/**
 * Codex CLI backend (Reviewer). Uses `codex exec` with the user's existing
 * ChatGPT login (never reads ~/.codex/auth.json). Sandbox is read-only and the
 * session is ephemeral. Prompt goes through stdin.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runProcess, parseJsonLines } from '../process.js'
import { billingDecision } from '../security/permissions.js'
import { redact } from '../security/redaction.js'

export class CodexCLIBackend {
  id = 'codex-cli'

  constructor({ executable = 'codex', billing, run = runProcess }) {
    this.executable = executable
    this.billing = billing
    this.run = run
    this.runs = new Map()
  }

  async discoverModels(cwd = process.cwd()) {
    const out = await this.run({ command: this.executable, args: ['debug', 'models'], cwd, timeoutMs: 30_000 })
    if (out.exitCode !== 0) return []
    try {
      const j = JSON.parse(out.stdout)
      const list = Array.isArray(j) ? j : (j.models ?? [])
      return list.filter((m) => m.visibility === 'list').map((m) => ({ id: m.slug, name: m.display_name ?? m.slug, defaultReasoning: m.default_reasoning_level ?? null }))
    } catch {
      return []
    }
  }

  async authStatus(cwd = process.cwd()) {
    const out = await this.run({ command: this.executable, args: ['login', 'status'], cwd, timeoutMs: 20_000 })
    const text = `${out.stdout}\n${out.stderr}`
    if (out.spawnError || out.exitCode !== 0 || /not logged in/i.test(text)) return { loggedIn: false, mode: 'unknown', detail: redact(text).slice(0, 200) }
    if (/chatgpt/i.test(text)) return { loggedIn: true, mode: 'subscription', detail: 'Logged in using ChatGPT' }
    if (/api key/i.test(text)) return { loggedIn: true, mode: 'api', detail: 'Logged in using an API key' }
    return { loggedIn: true, mode: 'unknown', detail: redact(text).trim().slice(0, 200) }
  }

  async healthCheck(cwd = process.cwd()) {
    const v = await this.run({ command: this.executable, args: ['--version'], cwd, timeoutMs: 15_000 })
    if (v.spawnError || v.exitCode !== 0) return { ok: false, available: false, error: `codex CLI not available: ${redact(v.spawnError ?? v.stderr).slice(0, 200)}` }
    const auth = await this.authStatus(cwd)
    const decision = billingDecision({ mode: auth.mode, billing: this.billing })
    return { ok: auth.loggedIn && decision.allowed, available: true, version: v.stdout.trim(), auth, billing: decision }
  }

  /**
   * @param {{prompt:string, cwd:string, runId?:string, outputSchema?:object}} request
   * @param {{model?:string, timeoutMs:number, signal?:AbortSignal, onEvent?:(e:object)=>void, scratchDir?:string}} options
   */
  async execute(request, options) {
    const started = Date.now()
    const runId = request.runId ?? `codex-${started}`
    const controller = new AbortController()
    this.runs.set(runId, controller)
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true })
    const scratch = await fs.mkdtemp(path.join(options.scratchDir ?? os.tmpdir(), 'codex-run-'))
    try {
      const auth = await this.authStatus(request.cwd)
      const decision = billingDecision({ mode: auth.mode, billing: this.billing })
      if (!auth.loggedIn) return fail('auth', 'Codex CLI is not logged in (run `codex login`)', started)
      if (!decision.allowed) return fail('billing', decision.reason, started)

      const lastMessage = path.join(scratch, 'last-message.txt')
      const args = [
        'exec', '--sandbox', 'read-only', '--json', '--ephemeral', '--skip-git-repo-check',
        // Ignore implementer-authored AGENTS.md/project docs.
        '-c', 'project_doc_max_bytes=0',
        '--output-last-message', lastMessage, '-C', request.cwd,
      ]
      if (options.model && options.model !== 'default') args.push('-m', options.model)
      if (request.outputSchema) {
        const schemaPath = path.join(scratch, 'schema.json')
        await fs.writeFile(schemaPath, JSON.stringify(request.outputSchema))
        args.push('--output-schema', schemaPath)
      }
      args.push('-')

      const events = []
      let usage = null
      let failure = null
      let message = ''
      const out = await this.run({
        command: this.executable,
        args,
        cwd: request.cwd,
        input: request.prompt,
        timeoutMs: options.timeoutMs,
        signal: controller.signal,
        onSpawn: (pid) => options.onPid?.(pid, this.executable),
        onStdoutLine: (line) => {
          let e
          try {
            e = JSON.parse(line)
          } catch {
            return
          }
          events.push(e.type)
          if (e.type === 'turn.completed') usage = e.usage
          else if (e.type === 'turn.failed') failure = e.error?.message ?? 'turn failed'
          else if (e.type === 'error') failure = e.message ?? 'error'
          else if (e.type === 'item.completed' && e.item?.type === 'agent_message') message = e.item.text ?? message
          options.onEvent?.(e)
        },
      })
      if (out.cancelled) return fail('cancelled', 'cancelled', started)
      if (out.timedOut) return fail('timeout', `Codex CLI exceeded ${options.timeoutMs}ms`, started)
      if (out.spawnError) return fail('unavailable', out.spawnError, started)
      let text = message
      try {
        text = (await fs.readFile(lastMessage, 'utf8')).trim() || message
      } catch {
        /* fall back to streamed message */
      }
      if (out.exitCode !== 0 || (text === '' && failure)) {
        const msg = redact(failure ?? out.stderr ?? `exit ${out.exitCode}`).slice(0, 400)
        const kind = /usage limit|rate limit|quota|429/i.test(msg) ? 'rate_limit' : /login|auth|token/i.test(msg) ? 'auth' : 'failed'
        return { ok: false, backend: this.id, text, durationMs: Date.now() - started, error: { kind, message: msg } }
      }
      return {
        ok: true,
        backend: this.id,
        text,
        // The Codex JSONL stream does not report the model. We report what was
        // requested ("default" = the CLI's configured default) and flag it.
        model: options.model && options.model !== 'default' ? options.model : null,
        requestedModel: options.model ?? 'default',
        modelVerified: false,
        durationMs: Date.now() - started,
        usage: {
          inputTokens: usage?.input_tokens ?? null,
          outputTokens: usage?.output_tokens ?? null,
          cacheReadTokens: usage?.cached_input_tokens ?? null,
          reasoningTokens: usage?.reasoning_output_tokens ?? null,
        },
        billing: { mode: 'subscription', charged: false },
        eventTypes: [...new Set(events)],
        parseWarnings: parseJsonLines('').invalid,
      }
    } finally {
      this.runs.delete(runId)
      await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async cancel(runId) {
    this.runs.get(runId)?.abort()
  }
}

function fail(kind, message, started) {
  return { ok: false, backend: 'codex-cli', text: '', durationMs: Date.now() - started, error: { kind, message: redact(message) } }
}
