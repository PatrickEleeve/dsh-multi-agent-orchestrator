/**
 * Claude Code CLI backend (Architect). Uses the installed `claude -p` with the
 * user's existing login. Read-only: plan permission mode and a Read/Glob/Grep
 * tool allow-list; user MCP servers and skills are disabled for isolation.
 * Claude CLI 2.1.x has no --max-turns, so execution is bounded by timeout.
 */
import { runProcess, parseJsonLines } from '../process.js'
import { billingDecision } from '../security/permissions.js'
import { redact } from '../security/redaction.js'

export class ClaudeCLIBackend {
  id = 'claude-cli'

  /** @param {{executable?:string, billing:object, run?:typeof runProcess}} opts */
  constructor({ executable = 'claude', billing, run = runProcess }) {
    this.executable = executable
    this.billing = billing
    this.run = run
    /** @type {Map<string, AbortController>} */
    this.runs = new Map()
  }

  async discoverModels() {
    // The CLI exposes aliases (opus/sonnet/...) only; the concrete model id is
    // reported by the init event of an actual run and recorded per stage.
    return [{ id: 'opus', kind: 'alias', note: 'resolved to a concrete model by the CLI at run time' }]
  }

  async authStatus(cwd = process.cwd()) {
    const out = await this.run({ command: this.executable, args: ['auth', 'status'], cwd, timeoutMs: 20_000 })
    if (out.spawnError || out.exitCode !== 0) {
      return { loggedIn: false, mode: 'unknown', detail: redact(out.spawnError ?? out.stderr ?? '').slice(0, 300) }
    }
    try {
      const j = JSON.parse(out.stdout)
      const mode = j.loggedIn !== true ? 'unknown' : j.authMethod === 'claude.ai' ? 'subscription' : j.apiProvider && j.apiProvider !== 'firstParty' ? 'api' : j.authMethod === 'api_key' ? 'api' : 'unknown'
      return { loggedIn: j.loggedIn === true, mode, authMethod: j.authMethod, apiProvider: j.apiProvider, subscriptionType: j.subscriptionType }
    } catch {
      return { loggedIn: false, mode: 'unknown', detail: 'unparseable auth status output' }
    }
  }

  async healthCheck(cwd = process.cwd()) {
    const v = await this.run({ command: this.executable, args: ['--version'], cwd, timeoutMs: 15_000 })
    if (v.spawnError || v.exitCode !== 0) return { ok: false, available: false, error: `claude CLI not available: ${redact(v.spawnError ?? v.stderr).slice(0, 200)}` }
    const auth = await this.authStatus(cwd)
    const decision = billingDecision({ mode: auth.mode, billing: this.billing })
    return { ok: auth.loggedIn && decision.allowed, available: true, version: v.stdout.trim(), auth, billing: decision }
  }

  buildArgs({ model, permissionMode = 'plan', effort }) {
    return [
      '-p',
      '--model', model,
      '--permission-mode', permissionMode,
      '--output-format', 'stream-json',
      '--verbose',
      '--tools', 'Read,Glob,Grep',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
      ...(effort ? ['--effort', effort] : []),
    ]
  }

  /**
   * @param {{prompt:string, cwd:string, runId?:string}} request
   * @param {{model:string, timeoutMs:number, signal?:AbortSignal, permissionMode?:string, effort?:string, onEvent?:(e:object)=>void}} options
   */
  async execute(request, options) {
    const started = Date.now()
    const runId = request.runId ?? `claude-${started}`
    const controller = new AbortController()
    this.runs.set(runId, controller)
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true })
    try {
      const auth = await this.authStatus(request.cwd)
      const decision = billingDecision({ mode: auth.mode, billing: this.billing })
      if (!auth.loggedIn) return fail('auth', 'Claude Code is not logged in (run `claude auth login`)', started)
      if (!decision.allowed) return fail('billing', decision.reason, started)

      let init = null
      let final = null
      let rateLimit = null
      const assistantText = []
      const out = await this.run({
        command: this.executable,
        args: this.buildArgs(options),
        cwd: request.cwd,
        input: request.prompt,
        timeoutMs: options.timeoutMs,
        signal: controller.signal,
        onSpawn: (pid) => options.onPid?.(pid, this.executable),
        onStdoutLine: (line) => {
          let event
          try {
            event = JSON.parse(line)
          } catch {
            return
          }
          if (event.type === 'system' && event.subtype === 'init') init = event
          else if (event.type === 'result') final = event
          else if (event.type === 'rate_limit_event') rateLimit = event
          else if (event.type === 'assistant') {
            for (const block of event.message?.content ?? []) if (block.type === 'text') assistantText.push(block.text)
          }
          options.onEvent?.(event)
        },
      })
      if (out.cancelled) return fail('cancelled', 'cancelled', started)
      if (out.timedOut) return fail('timeout', `Claude CLI exceeded ${options.timeoutMs}ms`, started)
      if (out.spawnError) return fail('unavailable', out.spawnError, started)
      if (final === null) {
        const parsed = parseJsonLines(out.stdout)
        return fail('failed', `no result event (exit ${out.exitCode}): ${redact(out.stderr || parsed.invalid.join(' ')).slice(0, 400)}`, started)
      }
      // Billing: apiKeySource "none" means OAuth/subscription login was used.
      if (init && init.apiKeySource && init.apiKeySource !== 'none') {
        return fail('billing', `Claude CLI reported apiKeySource="${init.apiKeySource}" (API billing path); run rejected`, started)
      }
      const text = typeof final.result === 'string' && final.result !== '' ? final.result : assistantText.join('\n')
      const base = {
        text,
        backend: this.id,
        model: init?.model ?? Object.keys(final.modelUsage ?? {})[0] ?? null,
        requestedModel: options.model,
        modelVerified: Boolean(init?.model),
        durationMs: Date.now() - started,
        usage: {
          inputTokens: final.usage?.input_tokens ?? null,
          outputTokens: final.usage?.output_tokens ?? null,
          cacheReadTokens: final.usage?.cache_read_input_tokens ?? null,
          cacheCreationTokens: final.usage?.cache_creation_input_tokens ?? null,
          reasoningTokens: final.usage?.output_tokens_details?.thinking_tokens ?? null,
        },
        billing: {
          mode: 'subscription',
          apiKeySource: init?.apiKeySource ?? null,
          notionalListCostUSD: final.total_cost_usd ?? null, // list-price equivalent, NOT a charge
          charged: false,
        },
        rateLimit: rateLimit?.rate_limit_info ?? null,
        toolsAvailable: init?.tools ?? null,
        permissionModeReported: init?.permissionMode ?? null,
      }
      if (final.is_error) {
        const message = redact(String(final.result ?? final.subtype ?? 'error')).slice(0, 400)
        const kind = /limit|quota|usage|overloaded|429/i.test(message) ? 'rate_limit' : /login|auth|credential/i.test(message) ? 'auth' : 'failed'
        return { ok: false, ...base, error: { kind, message } }
      }
      return { ok: true, ...base }
    } finally {
      this.runs.delete(runId)
    }
  }

  async cancel(runId) {
    this.runs.get(runId)?.abort()
  }
}

function fail(kind, message, started) {
  return { ok: false, backend: 'claude-cli', text: '', durationMs: Date.now() - started, error: { kind, message: redact(message) } }
}
