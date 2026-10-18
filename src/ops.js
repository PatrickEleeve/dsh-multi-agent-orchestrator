/** User-facing operations shared by the `/orchestrate` command and the `orchestrate` agent tool. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { HELP, parseOrchestrateInput } from './commands.js'
import { PRESETS } from './orchestrator/routing.js'
import { computeMetrics, describe, renderReport } from './orchestrator/engine.js'
import { attachWorkflowJob } from './job-bridge.js'
import { redact } from './security/redaction.js'
import { ORCHESTRATOR_VERSION } from './version.js'

export function createOps({ ctx, config, engine, store, backends, resolveRepo, jobs }) {
  /** A repo argument may be absolute or relative to the session's directory. */
  async function resolveRepoPath(value, agent) {
    const path = await import('node:path')
    const fs = await import('node:fs/promises')
    const base = value.startsWith('/') ? value : path.resolve(await resolveRepo(agent), value)
    const stat = await fs.stat(base).catch(() => null)
    if (!stat || !stat.isDirectory()) throw new Error(`repo "${value}" is not a directory (resolved to ${base})`)
    return base
  }

  const dump = (value) => JSON.stringify(value, null, 2)

  /** Explicit id wins; otherwise the newest workflow matching `predicate`. */
  async function pick(id, predicate, what) {
    if (id) {
      const wf = await store.load(id)
      if (!wf) throw new Error(`unknown workflow "${id}" — run /orchestrate status`)
      return wf
    }
    const wf = (await store.list()).find(predicate ?? (() => true))
    if (!wf) throw new Error(`no ${what} workflow — run /orchestrate status`)
    return wf
  }
  const latest = (id) => pick(id, () => true, '')

  return {
    help: async () => HELP,

    async run({ task, mode, verify = [], review, repo: repoArg }, agent) {
      // An explicit repo wins; otherwise the chat session's working directory.
      const repo = repoArg ? await resolveRepoPath(repoArg, agent) : await resolveRepo(agent)
      const wf = await engine.start({ task, repo, parent: agent, mode, verify, review })
      const sessionId = agent?.session?.id ?? agent?.id
      const jobId = attachWorkflowJob({ jobs, engine, wf, sessionId })
      return `Started workflow ${wf.id} (mode=${wf.mode}) — you will get a notification in this chat when it finishes.${jobId ? `\nBackground job: ${jobId} (progress in the Jobs panel; job_kill stops it)` : ''}\nRepository: ${repo}\nTrack it with: /orchestrate status ${wf.id}\nRoles: architect=claude-cli/${config.roles.architect.model} · implementer=dsh-native/${config.roles.implementer.provider}/${config.roles.implementer.model} (reasoning ${config.roles.implementer.reasoning}) · reviewer=codex-cli/${config.roles.reviewer.model}`
    },

    async status(id) {
      if (id) return describe(await latest(id))
      const all = (await store.list()).slice(0, 8)
      if (all.length === 0) return 'No workflows yet.'
      return all.map((wf) => describe(wf)).join('\n\n')
    },

    async cancel(id) {
      const target = await pick(id, (wf) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(wf.state), 'running')
      return `${describe(await engine.cancel(target.id))}\nNote: cancelling stops processes but does not revert file edits already made in the worktree.`
    },

    async resume(id, agent, verify = []) {
      const target = await pick(id, (wf) => wf.state === 'BLOCKED', 'blocked')
      const wf = await engine.resume(target.id, agent, { verify })
      return `Resumed ${wf.id} from ${wf.state}${verify.length > 0 ? ` with verification: ${verify.map((v) => (typeof v === 'string' ? v : v.command)).join(' ; ')}` : ''}.`
    },

    async approve(id, agent) {
      const target = await pick(id, (wf) => wf.awaitingApproval === true, 'workflow awaiting approval')
      const wf = await engine.approve(target.id, agent)
      return `Approved ${wf.id}; continuing (${wf.state}).`
    },

    async report(id) {
      const wf = await latest(id)
      if (!wf) return 'No workflows yet.'
      const file = path.join(store.dir(wf.id), 'report.md')
      return (await fs.readFile(file, 'utf8').catch(() => null)) ?? renderReport(wf)
    },

    async config() {
      return `Effective configuration (edit the plugin row's config in Settings → Plugins):\nversion=${ORCHESTRATOR_VERSION} dataDir=${config.orchestrator.dataDir}\n${dump({ ...config, orchestrator: config.orchestrator })}\nModes:\n${Object.entries(PRESETS).map(([k, v]) => `  ${k}: ${v.description}`).join('\n')}`
    },

    async models(agent) {
      const cwd = await resolveRepo(agent).catch(() => process.cwd())
      const [claude, codex, native] = await Promise.all([backends.architect.discoverModels(), backends.reviewer.discoverModels(cwd), backends.implementer.discoverModels()])
      const route = await backends.implementer.resolveModel()
      return [
        `Architect (claude-cli): configured "${config.roles.architect.model}" — ${claude.map((m) => m.note ?? m.id).join('; ')}`,
        `Implementer (dsh-native): configured ${config.roles.implementer.provider}/${config.roles.implementer.model} → resolves to ${route.model}${route.verified ? '' : ' (NOT found in the provider catalog)'}; advertised: ${native.map((m) => m.id).join(', ') || '(none)'}`,
        `Reviewer (codex-cli): configured "${config.roles.reviewer.model}" (default = Codex CLI's own default). Selectable via roles.reviewer.model: ${codex.map((m) => m.id).join(', ') || '(catalog unavailable)'}`,
      ].join('\n')
    },

    /** Real, minimal executions — nothing is inferred from generated text. */
    async testConnections(agent) {
      const cwd = await resolveRepo(agent).catch(() => process.cwd())
      const out = []
      const line = (label, ok, detail) => out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${detail}`)

      const ch = await backends.architect.healthCheck(cwd)
      line('claude: CLI + auth', ch.ok, ch.available ? `${ch.version}; auth=${ch.auth.authMethod ?? ch.auth.mode} (${ch.auth.mode}); billing=${ch.billing.allowed ? 'subscription-safe' : ch.billing.reason}` : ch.error)
      if (ch.ok) {
        const r = await backends.architect.execute({ prompt: 'Reply with exactly: PONG', cwd }, { model: config.roles.architect.model, timeoutMs: 120_000 })
        line('claude: authenticated execution', r.ok && /PONG/.test(r.text), r.ok ? `backend-reported model=${r.model} (verified=${r.modelVerified}); apiKeySource=${r.billing.apiKeySource}; tools=${JSON.stringify(r.toolsAvailable)}; permissionMode=${r.permissionModeReported}; rate-limit status=${r.rateLimit?.status ?? 'n/a'}` : r.error.message)
      }

      const xh = await backends.reviewer.healthCheck(cwd)
      line('codex: CLI + auth', xh.ok, xh.available ? `${xh.version}; ${xh.auth.detail}; billing=${xh.billing.allowed ? 'subscription-safe' : xh.billing.reason}` : xh.error)
      if (xh.ok) {
        const models = await backends.reviewer.discoverModels(cwd)
        line('codex: model catalog', models.length > 0, models.map((m) => m.id).join(', ') || 'unavailable')
        const r = await backends.reviewer.execute({ prompt: 'Reply with exactly: PONG', cwd }, { model: config.roles.reviewer.model, timeoutMs: 180_000 })
        line('codex: read-only execution', r.ok && /PONG/.test(r.text), r.ok ? `requested model=${r.requestedModel}; model reporting: ${r.modelVerified ? 'verified' : 'NOT exposed by codex exec JSONL (limitation)'}` : r.error.message)
      }

      const dh = await backends.implementer.healthCheck()
      line('deepseek: native runtime', dh.ok, `provider registered=${dh.checks?.subagentProviderRegistered}; account=${JSON.stringify(dh.checks?.accountSignedIn)}; route=${dh.route?.provider ?? '?'}/${dh.route?.model ?? '?'} reasoning=${dh.route?.reasoningEffort ?? '?'}; model in catalog=${dh.checks?.modelAdvertised}`)
      if (dh.ok && agent) {
        const r = await backends.implementer.execute({ prompt: 'Reply with exactly: PONG. Do not use any tools.', cwd, parent: agent, label: 'connection test' }, { timeoutMs: 180_000 })
        line('deepseek: independent child agent execution', r.ok && /PONG/.test(r.text), r.ok ? `child session ${r.childSessionId}; stop=${r.stopReason}; route ${r.provider}/${r.model}@${r.reasoningEffort} (model identity from catalog; the result object does not echo it)` : r.error.message)
      } else if (dh.ok) line('deepseek: independent child agent execution', false, 'needs a live parent agent (run from a chat session)')
      return redact(out.join('\n'))
    },

    async handle(rawInput, agent) {
      const cmd = parseOrchestrateInput(rawInput)
      switch (cmd.action) {
        case 'help': return HELP
        case 'run': return this.run(cmd, agent)
        case 'status': return this.status(cmd.id)
        case 'cancel': return this.cancel(cmd.id)
        case 'resume': return this.resume(cmd.id, agent, cmd.verify ?? [])
        case 'approve': return this.approve(cmd.id, agent)
        case 'report': return this.report(cmd.id)
        case 'models': return this.models(agent)
        case 'test-connections': return this.testConnections(agent)
        case 'config': return this.config()
        case 'budget': return this.budget()
        default: return HELP
      }
    },

    metrics: async (id) => dump(computeMetrics(await latest(id))),

    /** Actual spend/usage across every workflow, subscription and API kept apart. */
    async budget() {
      const all = await store.list()
      const agg = {
        workflows: all.length,
        byState: {},
        paidApiCostUSD: 0,
        subscriptionNotionalListCostUSD: 0,
        backendCalls: {},
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        verificationRuns: 0,
        reviewRounds: 0,
        fixCycles: 0,
        reviewerFallbacks: 0,
      }
      for (const wf of all) {
        agg.byState[wf.state] = (agg.byState[wf.state] ?? 0) + 1
        for (const stage of wf.stages ?? []) {
          const backend = stage.backend ?? 'unknown'
          agg.backendCalls[backend] = (agg.backendCalls[backend] ?? 0) + 1
          const notional = stage.billing?.notionalListCostUSD
          if (typeof notional === 'number') agg.subscriptionNotionalListCostUSD += notional
          agg.inputTokens += stage.usage?.inputTokens ?? 0
          agg.outputTokens += stage.usage?.outputTokens ?? 0
          agg.reasoningTokens += stage.usage?.reasoningTokens ?? 0
        }
        agg.verificationRuns += (wf.verificationHistory ?? []).length
        agg.reviewRounds += (wf.reviews ?? []).length
        agg.fixCycles += wf.fixCycles ?? 0
        agg.reviewerFallbacks += (wf.fallbacks ?? []).length
      }
      const lines = [
        'Orchestrator budget',
        `  workflows: ${agg.workflows} (${Object.entries(agg.byState).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`,
        `  paid API spend: $${agg.paidApiCostUSD.toFixed(2)}  (no paid backend is ever activated)`,
        `  subscription notional list cost: $${agg.subscriptionNotionalListCostUSD.toFixed(4)}  (list price of subscription runs — NOT a charge)`,
        `  backend calls: ${Object.entries(agg.backendCalls).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
        `  tokens reported by backends: input ${agg.inputTokens}, output ${agg.outputTokens}, reasoning ${agg.reasoningTokens}`,
        `  verification runs: ${agg.verificationRuns}   review rounds: ${agg.reviewRounds}   fix cycles: ${agg.fixCycles}   reviewer fallbacks: ${agg.reviewerFallbacks}`,
        '  note: DeepSeek child usage and Codex usage are not exposed by their runtimes, so they stay blank rather than estimated.',
      ]
      return lines.join('\n')
    },
  }
}
