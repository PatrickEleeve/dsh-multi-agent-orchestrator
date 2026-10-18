import test from 'node:test'
import assert from 'node:assert/strict'
import { registerRoutes, ROUTE_PREFIX } from '../src/routes.js'

function fakeWebServer() {
  const routes = []
  return { routes, register: (route) => { routes.push(route); return () => undefined } }
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(body) { this.body = body ?? '' },
  }
  return res
}

function req(method, path, body, contentType = 'application/json') {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url: path,
    headers: body === undefined ? {} : { 'content-type': contentType },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
}

const workflows = {
  'wf-a1': {
    id: 'wf-a1', task: 'gate task', mode: 'thorough', state: 'BLOCKED', createdAt: '2026-01-01T00:00:00.000Z',
    fixCycles: 1, config: { maxFixCycles: 3 }, history: [{ at: 't', from: 'REVIEWING', to: 'BLOCKED', reason: 'gate' }],
    stages: [{ role: 'reviewer', backend: 'codex-cli', model: null, ok: true, durationMs: 5 }],
    reviews: [{ at: 't', verdict: 'APPROVE', summary: 'ok', findings: [] }], review: { verdict: 'APPROVE', summary: 'ok', findings: [] },
    verification: { status: 'passed', results: [{ name: 'npm test', passed: true, exitCode: 0, durationMs: 10 }] },
    awaitingApproval: true, blocker: { kind: 'awaiting_approval', message: 'gate' }, violations: [], changes: { files: ['a.js'] },
  },
  'wf-b2': { id: 'wf-b2', task: 'done task', mode: 'fast', state: 'COMPLETED', createdAt: '2026-01-02T00:00:00.000Z', fixCycles: 0, config: { maxFixCycles: 3 }, history: [], stages: [], reviews: [], verification: { status: 'passed', results: [] }, violations: [] },
}

function setup({ rejecting, noFence } = {}) {
  const web = fakeWebServer()
  const calls = []
  const store = {
    list: async () => Object.values(workflows),
    load: async (id) => workflows[id],
  }
  const engine = {
    approve: async (id) => calls.push(['approve', id]),
    cancel: async (id) => calls.push(['cancel', id]),
    resume: async (id) => calls.push(['resume', id]),
    parentFor: () => undefined,
  }
  const ctx = {
    webServer: web,
    connection: noFence ? undefined : { requestRejection: () => (rejecting ? 403 : undefined) },
  }
  registerRoutes(ctx, { store, engine, log: () => undefined })
  return { route: web.routes[0], calls }
}

async function call(route, method, sub, body, contentType) {
  const res = fakeRes()
  await route.handler(req(method, `${ROUTE_PREFIX}${sub}`, body, contentType), res)
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null }
}

test('route is a prefix route with the documented path', () => {
  const { route } = setup()
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, ROUTE_PREFIX)
})

test('GET /workflows lists real summaries only', async () => {
  const { route } = setup()
  const { status, json } = await call(route, 'GET', '/workflows')
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.workflows.length, 2)
  const a = json.workflows.find((w) => w.id === 'wf-a1')
  assert.equal(a.awaitingApproval, true)
  assert.equal(a.verification, 'passed')
  assert.equal(a.review, 'APPROVE')
  assert.match(a.timeline, /BLOCKED/)
})

test('GET /workflow returns the full detail; unknown id 404s', async () => {
  const { route } = setup()
  const { status, json } = await call(route, 'GET', '/workflow?id=wf-a1')
  assert.equal(status, 200)
  assert.equal(json.workflow.id, 'wf-a1')
  assert.equal(json.workflow.stages[0].backend, 'codex-cli')
  assert.equal(json.workflow.verificationResults[0].passed, true)
  const missing = await call(route, 'GET', '/workflow?id=wf-nope')
  assert.equal(missing.status, 404)
})

test('POST /action approves, rejects and cancels through the engine', async () => {
  const { route, calls } = setup()
  const approve = await call(route, 'POST', '/action', { id: 'wf-a1', action: 'approve' })
  assert.equal(approve.status, 200)
  assert.deepEqual(calls.at(-1), ['approve', 'wf-a1'])
  await call(route, 'POST', '/action', { id: 'wf-a1', action: 'reject' })
  assert.deepEqual(calls.at(-1), ['cancel', 'wf-a1'])
  await call(route, 'POST', '/action', { id: 'wf-b2', action: 'cancel' })
  assert.deepEqual(calls.at(-1), ['cancel', 'wf-b2'])
})

test('approve refuses a workflow that is not awaiting approval', async () => {
  const { route, calls } = setup()
  const { status, json } = await call(route, 'POST', '/action', { id: 'wf-b2', action: 'approve' })
  assert.equal(status, 409)
  assert.equal(json.error.code, 'not_awaiting_approval')
  assert.deepEqual(calls, [])
})

test('bad requests are rejected with explicit codes and the trust fence is honoured', async () => {
  const { route } = setup()
  assert.equal((await call(route, 'POST', '/action', { action: 'approve' })).status, 400)
  assert.equal((await call(route, 'POST', '/action', { id: 'wf-a1', action: 'explode' })).status, 400)
  assert.equal((await call(route, 'GET', '/nope')).status, 404)
  const fenced = setup({ rejecting: true })
  const { status, json } = await call(fenced.route, 'GET', '/workflows')
  assert.equal(status, 403)
  assert.equal(json.error.code, 'forbidden')
  // Without the fence service the API refuses rather than serving privileges.
  const unfenced = setup({ noFence: true })
  const denied = await call(unfenced.route, 'GET', '/workflows')
  assert.equal(denied.status, 503)
  assert.equal(denied.json.error.code, 'fence_unavailable')
  // A cross-site form cannot produce application/json.
  const plain = await call(route, 'POST', '/action', { id: 'wf-a1', action: 'approve' }, 'text/plain')
  assert.equal(plain.status, 415)
})

test('registerRoutes returns nothing (so the caller can wait) without a web server', () => {
  assert.equal(registerRoutes({}, { store: {}, engine: {} }), undefined)
  assert.equal(registerRoutes({ webServer: {} }, { store: {}, engine: {} }), undefined)
})
