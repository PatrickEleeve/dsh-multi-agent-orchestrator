/**
 * DSH-native backend (Implementer). Runs a genuinely separate DeepSeek child
 * agent through the supported `ctx.subagents.startActivation()` API with the
 * in-process `spawn` provider, `delivery: 'caller'` (the orchestrator awaits
 * the result) and an explicit `agentOptions` route. No prompt role-play, no
 * undocumented HTTP endpoints, no credential access: the DeepSeek account
 * credential stays inside DSH's own LLM adapter.
 */
import { redact } from '../security/redaction.js'

const flatten = (output) => {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) return output.map((b) => (typeof b === 'string' ? b : (b?.text ?? ''))).join('\n')
  return output === undefined || output === null ? '' : String(output)
}

export class DSHNativeBackend {
  id = 'dsh-native'

  /**
   * @param {{ctx:any, provider:string, model:string, reasoning:string, subagentProvider?:string}} opts
   */
  constructor({ ctx, provider, model, reasoning, subagentProvider = 'spawn' }) {
    this.ctx = ctx
    this.provider = provider
    this.model = model
    this.reasoning = reasoning
    this.subagentProvider = subagentProvider
    this.runs = new Map()
  }

  async discoverModels() {
    const llm = this.ctx.get?.('llm') ?? this.ctx.llm
    if (!llm?.listModels) return []
    try {
      const models = await llm.listModels(this.provider)
      return models.map((m) => ({ id: m.id, name: m.name ?? m.id, provider: this.provider }))
    } catch {
      return []
    }
  }

  /** Resolve `auto` to a concrete advertised model id (prefers *flash*, then 1017). */
  async resolveModel() {
    if (this.model !== 'auto') return { model: this.model, verified: (await this.discoverModels()).some((m) => m.id === this.model) }
    const models = await this.discoverModels()
    const pick = models.find((m) => /1017/.test(`${m.id} ${m.name}`)) ?? models.find((m) => /flash/i.test(m.id)) ?? models[0]
    return pick ? { model: pick.id, verified: true } : { model: 'deepseek-flash', verified: false }
  }

  async healthCheck() {
    const checks = { subagentProviderRegistered: false, accountSignedIn: null, modelAdvertised: false }
    const subagents = this.ctx.get?.('subagents') ?? this.ctx.subagents
    checks.subagentProviderRegistered = Boolean(subagents?.getProvider?.(this.subagentProvider))
    try {
      const account = this.ctx.get?.('deepseekAccount') ?? this.ctx.deepseekAccount
      if (account?.getState) {
        const state = await account.getState()
        // Only the sign-in status is read; no token or profile data is touched.
        checks.accountSignedIn = state?.status === 'signed-in' || state?.signedIn === true || state?.kind === 'signed-in' ? true : (state?.status ?? state?.kind ?? 'unknown')
      }
    } catch {
      checks.accountSignedIn = 'unknown'
    }
    const resolved = await this.resolveModel()
    checks.modelAdvertised = resolved.verified
    return {
      ok: checks.subagentProviderRegistered && resolved.verified,
      available: checks.subagentProviderRegistered,
      route: { provider: this.provider, model: resolved.model, reasoningEffort: this.reasoning },
      checks,
    }
  }

  /**
   * @param {{prompt:string, cwd:string, parent:any, runId?:string, label?:string}} request
   * @param {{timeoutMs:number, signal?:AbortSignal}} options
   */
  async execute(request, options) {
    const started = Date.now()
    const subagents = this.ctx.get?.('subagents') ?? this.ctx.subagents
    if (!subagents?.startActivation || !subagents.getProvider?.(this.subagentProvider)) {
      return fail('unavailable', `DSH subagent provider "${this.subagentProvider}" is not registered`, started)
    }
    if (!request.parent) return fail('unavailable', 'a live parent Agent is required to start a native child agent', started)
    const route = await this.resolveModel()
    const controller = new AbortController()
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true })
    const timer = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs)
    let activation
    let timedOut = false
    controller.signal.addEventListener('abort', () => {
      if (controller.signal.reason?.message === 'timeout') timedOut = true
    })
    try {
      activation = await subagents.startActivation({
        provider: this.subagentProvider,
        label: request.label ?? 'orchestrator implementer',
        request: {
          cwd: request.cwd,
          prompt: [{ type: 'text', text: request.prompt }],
          parent: request.parent,
          agentOptions: { provider: this.provider, model: route.model, reasoningEffort: this.reasoning },
        },
        signal: controller.signal,
        delivery: 'caller',
      })
      this.runs.set(request.runId ?? activation.childId, activation)
      const abortActive = () => void activation.dispose?.().catch(() => undefined)
      if (controller.signal.aborted) abortActive()
      controller.signal.addEventListener('abort', abortActive, { once: true })
      const result = await activation.result
      await activation.dispose?.().catch(() => undefined)
      if (timedOut) return fail('timeout', `native implementer exceeded ${options.timeoutMs}ms`, started)
      if (options.signal?.aborted) return fail('cancelled', 'cancelled', started)
      const text = flatten(result?.output)
      const stop = result?.stopReason ?? 'unknown'
      const base = {
        backend: this.id,
        text,
        childSessionId: activation.childId,
        // Route actually requested for the child. DSH records the resolved
        // model in the child's session descriptor; the result object itself
        // does not echo it, so modelVerified reflects catalog membership only.
        model: route.model,
        provider: this.provider,
        reasoningEffort: this.reasoning,
        modelVerified: route.verified,
        stopReason: stop,
        durationMs: Date.now() - started,
        usage: { inputTokens: null, outputTokens: null, reasoningTokens: null, note: 'token usage is not exposed by the subagent result' },
        billing: { mode: 'deepseek-account', charged: 'per DeepSeek account terms (not an API key)' },
      }
      if (stop !== 'completed') return { ok: false, ...base, error: { kind: stop === 'aborted' ? 'cancelled' : 'failed', message: `child stopped with reason "${stop}"` } }
      return { ok: true, ...base }
    } catch (error) {
      const message = redact(String(error?.message ?? error))
      if (timedOut) return fail('timeout', `native implementer exceeded ${options.timeoutMs}ms`, started)
      if (options.signal?.aborted) return fail('cancelled', 'cancelled', started)
      const kind = error?.code === 'ACTIVATION_LIMIT_REACHED' ? 'rate_limit' : /auth|sign|credential|balance|quota/i.test(message) ? 'auth' : 'failed'
      return fail(kind, message, started)
    } finally {
      clearTimeout(timer)
    }
  }

  async cancel(runId) {
    const activation = this.runs.get(runId)
    await activation?.dispose?.().catch(() => undefined)
  }
}

function fail(kind, message, started) {
  return { ok: false, backend: 'dsh-native', text: '', durationMs: Date.now() - started, error: { kind, message: redact(message) } }
}
