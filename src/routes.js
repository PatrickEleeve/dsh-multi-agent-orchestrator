/**
 * Host HTTP API for the Orchestrator panel (`/orchestrate-api`). Registered on
 * the same origin as the Web GUI and behind the composition's browser trust
 * fence; it exposes read-only workflow state plus the two decisions a human may
 * take from the panel (approve or reject the gate) and cancellation.
 */
import { computeMetrics, progressLine } from './orchestrator/engine.js'
import { redact } from './security/redaction.js'
import { explainBlocker } from './explain.js'

export const ROUTE_PREFIX = '/orchestrate-api'
const MAX_BODY_BYTES = 64 * 1024
const LIST_LIMIT = 25

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader?.('content-type', 'application/json; charset=utf-8')
  res.setHeader?.('cache-control', 'no-store')
  res.end(body)
}

const strip = (wf) => ({
  id: wf.id,
  task: wf.task,
  mode: wf.mode,
  state: wf.state,
  createdAt: wf.createdAt,
  updatedAt: wf.updatedAt,
  finishedAt: wf.finishedAt ?? null,
  verification: wf.verification?.status ?? null,
  review: wf.review?.verdict ?? null,
  fixCycles: wf.fixCycles ?? 0,
  maxFixCycles: wf.config?.maxFixCycles ?? null,
  escalations: wf.escalations ?? 0,
  awaitingApproval: wf.awaitingApproval === true,
  blocker: wf.blocker ? { kind: wf.blocker.kind, message: redact(wf.blocker.message ?? '').slice(0, 2000) } : null,
  // Plain-language "what happened / what to do", same text as the chat notice.
  blockerExplained: wf.blocker ? explainBlocker(wf.blocker) : null,
  readOnly: wf.route?.readOnly === true,
  active: wf.active ? { role: wf.active.role, backend: wf.active.backend, startedAt: wf.active.startedAt } : null,
  files: wf.changes?.files ?? [],
  delivery: wf.delivery ?? null,
  timeline: progressLine(wf),
  // Flat, list-level facts. Without these the panel can only guess, and a guess
  // is worse than an empty value.
  visited: [...new Set((wf.history ?? []).map((entry) => entry.to))],
  verificationCounts: {
    pass: (wf.verification?.results ?? []).filter((result) => result.passed).length,
    total: (wf.verification?.results ?? []).length,
  },
  findingsCount: (wf.review?.findings ?? []).length,
  reviewSummary: wf.review ? redact(wf.review.summary ?? '') : null,
})

function detail(wf) {
  return {
    ...strip(wf),
    repo: wf.repo,
    workspace: wf.workspace ? { branch: wf.workspace.branch, path: wf.workspace.path, baseSha: wf.workspace.baseSha } : null,
    findings: (wf.review?.findings ?? []).map((f) => ({ severity: f.severity, category: f.category, file: f.file, line: f.line, description: redact(f.description), suggestedFix: f.suggested_fix ? redact(f.suggested_fix) : null, reviewers: f.reviewers ?? [] })),
    reviewOutcomes: (wf.reviewOutcomes ?? []).map((o) => ({ backend: o.backend, model: o.model ?? null, ok: o.ok === true, error: o.error ? redact(o.error).slice(0, 300) : null })),
    readOnlyCheck: wf.readOnlyCheck ?? null,
    reviewSummary: wf.review ? redact(wf.review.summary ?? '') : null,
    verificationResults: (wf.verification?.results ?? []).map((r) => ({ name: r.name, passed: r.passed, exitCode: r.exitCode, durationMs: r.durationMs, testSummary: r.testSummary ?? null })),
    stages: (wf.stages ?? []).map((s) => ({ role: s.role, state: s.state, backend: s.backend, model: s.model ?? null, modelVerified: s.modelVerified === true, ok: s.ok, durationMs: s.durationMs, error: s.error?.kind ?? null })),
    history: (wf.history ?? []).map((h) => ({ at: h.at, from: h.from, to: h.to, reason: redact(h.reason ?? '') })),
    reviews: (wf.reviews ?? []).map((r) => ({ at: r.at, verdict: r.verdict, summary: redact(r.summary ?? '') })),
    violations: (wf.violations ?? []).map((v) => ({ at: v.at, kind: v.kind, detail: redact(v.detail ?? '') })),
    metrics: safeMetrics(wf),
  }
}

async function readJsonBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('request body too large'), { code: 'BODY_TOO_LARGE' })
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { code: 'INVALID_JSON' })
  }
}

/**
 * @param {{connection?:any, webServer?:any}} ctx
 * @param {{store:object, engine:object, log?:(m:string)=>void}} deps
 * @returns {() => void} disposer (no-op when the web server is absent)
 */
export function registerRoutes(ctx, { store, engine, log }) {
  // Never read a service property directly: Cordis throws for a non-injected
  // property ("cannot get property \"webServer\" without inject"), and that
  // throw during activation makes the whole plugin row fail.
  const webServer = safeGet(ctx, 'webServer')
  if (!webServer || typeof webServer.register !== 'function') return undefined
  // Resolved per request: the fence's service may not exist yet when the route
  // is registered, and a stale undefined must never disable the fence.
  const connectionOf = () => safeGet(ctx, 'connection')

  const route = {
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      try {
        const connection = connectionOf()
        if (!connection || typeof connection.requestRejection !== 'function') {
          // No fence means no way to prove this is the local GUI: refuse instead
          // of silently serving a privileged endpoint.
          sendJson(res, 503, { ok: false, error: { code: 'fence_unavailable', message: 'the connection trust fence is unavailable; the panel API refuses to serve' } })
          return
        }
        const rejection = connection.requestRejection(req)
        if (rejection !== undefined && rejection !== false) {
          sendJson(res, typeof rejection === 'number' ? rejection : 403, { ok: false, error: { code: 'forbidden', message: 'request rejected by the connection trust fence' } })
          return
        }
        let url
        try {
          url = new URL(req.url ?? '/', 'http://localhost')
        } catch {
          sendJson(res, 400, { ok: false, error: { code: 'invalid_params', message: 'unparseable request URL' } })
          return
        }
        const sub = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/g, '') || '/'
        const method = (req.method ?? 'GET').toUpperCase()

        if (method === 'GET' && sub === '/workflows') {
          const workflows = (await store.list()).slice(0, LIST_LIMIT).map(strip)
          sendJson(res, 200, { ok: true, workflows })
          return
        }
        if (method === 'GET' && sub === '/workflow') {
          const id = url.searchParams.get('id') ?? ''
          const wf = await store.load(id)
          if (!wf) {
            sendJson(res, 404, { ok: false, error: { code: 'not_found', message: `unknown workflow "${id}"` } })
            return
          }
          sendJson(res, 200, { ok: true, workflow: detail(wf) })
          return
        }
        if (method === 'POST' && sub === '/action') {
          // A cross-site form can only send text/plain, urlencoded or multipart.
          if (!String(req.headers?.['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
            sendJson(res, 415, { ok: false, error: { code: 'unsupported_media_type', message: 'POST /action requires content-type: application/json' } })
            return
          }
          const body = await readJsonBody(req)
          const id = typeof body.id === 'string' ? body.id : ''
          const action = typeof body.action === 'string' ? body.action : ''
          if (id === '' || action === '') {
            sendJson(res, 400, { ok: false, error: { code: 'invalid_params', message: 'id and action are required' } })
            return
          }
          const before = await store.load(id)
          if (!before) {
            sendJson(res, 404, { ok: false, error: { code: 'not_found', message: `unknown workflow "${id}"` } })
            return
          }
          try {
            if (action === 'approve') {
              if (before.awaitingApproval !== true) {
                sendJson(res, 409, { ok: false, error: { code: 'not_awaiting_approval', message: 'this workflow is not waiting for approval' } })
                return
              }
              await engine.approve(id, engine.parentFor?.(id))
            } else if (action === 'reject') {
              await engine.cancel(id)
            } else if (action === 'cancel') {
              await engine.cancel(id)
            } else if (action === 'resume') {
              // A resume that re-enters IMPLEMENTING needs a live root agent, which the
              // panel cannot fabricate; the engine reports that instead of faking one.
              await engine.resume(id, engine.parentFor?.(id))
            } else {
              sendJson(res, 400, { ok: false, error: { code: 'unsupported_action', message: `unsupported action "${action}"` } })
              return
            }
          } catch (error) {
            sendJson(res, 409, { ok: false, error: { code: 'action_failed', message: redact(String(error?.message ?? error)).slice(0, 500) } })
            return
          }
          const after = await store.load(id)
          sendJson(res, 200, { ok: true, workflow: after ? detail(after) : null })
          return
        }
        sendJson(res, 404, { ok: false, error: { code: 'not_found', message: `no route for ${method} ${sub}` } })
      } catch (error) {
        log?.(`/orchestrate-api failed: ${error?.message ?? error}`)
        sendJson(res, 500, { ok: false, error: { code: 'internal', message: redact(String(error?.message ?? error)).slice(0, 500) } })
      }
    },
  }
  return webServer.register(route)
}

function safeMetrics(wf) {
  try {
    return computeMetrics(wf)
  } catch {
    return null
  }
}

function safeGet(ctx, key) {
  try {
    if (typeof ctx?.get === 'function') {
      const value = ctx.get(key)
      if (value !== undefined) return value
    }
  } catch {
    /* fall through to the property form */
  }
  try {
    return ctx?.[key]
  } catch {
    // Cordis throws for a property whose service was not declared in `inject`.
    return undefined
  }
}
