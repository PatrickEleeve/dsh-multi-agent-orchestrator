/**
 * Host entry: wires config, backends, engine, persistence, the `/orchestrate`
 * command and the `orchestrate` agent tool into a DSH Cordis context.
 */
import { resolveConfig } from './config.js'
import { ClaudeCLIBackend } from './backends/claude-cli.js'
import { CodexCLIBackend } from './backends/codex-cli.js'
import { DSHNativeBackend } from './backends/dsh-native.js'
import { Engine } from './orchestrator/engine.js'
import { WorkflowStore } from './orchestrator/persistence.js'
import { Git } from './workspace/worktree.js'
import { createOps } from './ops.js'
import { registerRoutes } from './routes.js'
import { promptApproval } from './approval.js'
import { deliverNotice } from './notify.js'

export const inject = ['tools', 'commands', 'subagents', 'workingDirectory']

const text = (value) => [{ type: 'text', text: value }]

/** Cordis exposes ctx.logger(name); a logger must never break plugin startup. */
function logWarn(ctx, message) {
  try {
    const logger = typeof ctx.logger === 'function' ? ctx.logger('orchestrator') : ctx.logger
    logger?.warn?.(message)
  } catch {
    /* ignore */
  }
}

export function buildRuntime(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const store = new WorkflowStore(config.orchestrator.dataDir)
  const backends = {
    architect: new ClaudeCLIBackend({ executable: config.roles.architect.executable, billing: config.billing }),
    implementer: new DSHNativeBackend({ ctx, provider: config.roles.implementer.provider, model: config.roles.implementer.model, reasoning: config.roles.implementer.reasoning }),
    reviewer: new CodexCLIBackend({ executable: config.roles.reviewer.executable, billing: config.billing }),
  }
  const approvalState = new Map() // workflow id -> in-flight prompt, never asked twice concurrently
  // `userQuestions` is NOT in `inject`, so reading ctx.userQuestions throws
  // ("cannot get property without inject"). Only the optional ctx.get accessor
  // is safe, and it must never be allowed to escape as a rejection: this runs
  // from a background workflow and an unhandled rejection kills the Host.
  const askQuestions = () => {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('userQuestions') : undefined
      return service && typeof service.ask === 'function' ? service.ask.bind(service) : undefined
    } catch {
      return undefined
    }
  }
  async function maybePromptApproval(wf, fallbackAgent) {
    try {
      if (wf?.state !== 'BLOCKED' || wf.blocker?.kind !== 'awaiting_approval' || approvalState.has(wf.id)) return 'skipped'
      const agent = engine.parentFor(wf.id) ?? fallbackAgent
      const ask = askQuestions()
      if (!agent || !ask) return 'skipped'
      approvalState.set(wf.id, true)
      try {
        const outcome = await promptApproval({ wf, ask, engine, agent, log: (m) => logWarn(ctx, m) })
        if (outcome !== 'skipped') logWarn(ctx, `approval card: ${wf.id} ${outcome}`)
        return outcome
      } finally {
        approvalState.delete(wf.id)
      }
    } catch (error) {
      logWarn(ctx, `approval prompt failed safely: ${error?.message ?? error}`)
      return 'skipped'
    }
  }
  /** Re-offer a pending gate after a restart/reload, when an agent next interacts. */
  async function notifyPendingApproval(agent) {
    if (!agent) return
    try {
      const pending = (await store.list()).find((wf) => wf.state === 'BLOCKED' && wf.blocker?.kind === 'awaiting_approval' && !approvalState.has(wf.id))
      if (pending) await maybePromptApproval(pending, agent)
    } catch (error) {
      logWarn(ctx, `pending-approval lookup failed safely: ${error?.message ?? error}`)
    }
  }
  const notified = new Map() // workflow id -> last notified state, so a retried persist cannot double-notify
  const engine = new Engine({
    config,
    store,
    backends,
    git: new Git(),
    onChange: (wf) => {
      void maybePromptApproval(wf).catch(() => undefined)
      // Chat feedback: one notice per workflow state change the user must know about.
      try {
        if (notified.get(wf?.id) === wf?.state) return
        const target = engine?.parentFor?.(wf.id) ?? undefined
        const outcome = deliverNotice(target, wf)
        if (outcome !== 'skipped') notified.set(wf.id, wf.state)
      } catch {
        /* notices must never affect the workflow */
      }
    },
  })
  const resolveRepo = async (agent) => {
    if (!agent) throw new Error('no agent context: cannot resolve the repository (working directory)')
    return ctx.workingDirectory.ensure(agent)
  }
  // Optional: the DSH jobs service turns a workflow into a native background job.
  const jobs = (() => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('jobs') : undefined
    } catch {
      return undefined
    }
  })()
  const ops = createOps({ ctx, config, engine, store, backends, resolveRepo, jobs })
  return { config, store, backends, engine, ops, maybePromptApproval, notifyPendingApproval }
}

export function apply(ctx, rawConfig) {
  const { config, store, engine, ops, notifyPendingApproval } = buildRuntime(ctx, rawConfig)

  // Crash recovery: reconcile surviving child processes, then mark interrupted
  // workflows BLOCKED with recovery notes. Nothing is replayed automatically.
  store
    .recoverInterrupted({
      isLive: (id) => engine.isLive(id),
      reconcile: (wf) => engine.reconcileOrphans(wf.active),
    })
    .then((ids) => ids.length > 0 && logWarn(ctx, `marked ${ids.length} interrupted workflow(s) BLOCKED: ${ids.join(', ')}`))
    .catch(() => undefined)
  // Register the panel API once (and only if) the web server exists. Activation
  // order is not guaranteed, so this waits for the service instead of skipping it.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (serviceCtx) => {
      const disposeRoutes = registerRoutes(serviceCtx, { store, engine, log: (message) => logWarn(ctx, message) })
      if (typeof disposeRoutes === 'function') ctx.effect(() => disposeRoutes, 'orchestrator: /orchestrate-api routes')
    })
  }
  ctx.effect(() => () => {
    // Plugin unload: cancel live runs (processes are terminated; state is persisted as CANCELLED).
    for (const id of [...engine.live.keys()]) void engine.cancel(id).catch(() => undefined)
  }, 'orchestrator: cancel live workflows on unload')

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'orchestrate',
        description: 'Multi-model engineering workflow: Claude architect → DeepSeek implementer → verification → Codex review',
        input: { hint: '<task> | status | cancel <id> | resume <id> | models | test-connections | config' },
        handler: async ({ agent, rawInput }) => {
          try {
            const text = await ops.handle(rawInput ?? '', agent)
            void notifyPendingApproval(agent)
            return { kind: 'success', text }
          } catch (error) {
            return { kind: 'error', text: String(error?.message ?? error) }
          }
        },
      }),
    'orchestrator: /orchestrate command',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'orchestrate',
        description:
          'Run or inspect the multi-model engineering workflow (Claude Code CLI architect → DeepSeek native implementer → deterministic verification → Codex CLI reviewer → repair loop). Work happens on an isolated git worktree branch that is never merged or pushed. action=run starts a background workflow for the current working directory (a git repo); other actions: status, cancel, resume, approve, report, models, test_connections, config.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['run', 'status', 'cancel', 'resume', 'approve', 'report', 'models', 'test_connections', 'config'] },
            task: { type: 'string', description: 'Development task (action=run).' },
            mode: { type: 'string', enum: ['fast', 'balanced', 'thorough'], description: 'Routing preset; defaults to the configured mode.' },
            verify: { type: 'array', items: { type: 'string' }, description: 'Deterministic verification commands, e.g. ["npm test"]. Executables must be on the configured allow-list.' },
            review: { type: 'boolean', description: 'Override whether the Codex review stage runs.' },
            repo: { type: 'string', description: 'Target git repository (absolute, or relative to the chat working directory). Defaults to the chat working directory.' },
            workflow_id: { type: 'string', description: 'Workflow id for status/cancel/resume/approve/report.' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        timeoutMs: 600_000,
        output: { schema: { type: 'object' }, render: (_args, value) => text(value.text) },
        execute: async (args, exec) => {
          const agent = exec.agent
          const id = args.workflow_id
          // Any interaction is a chance to re-offer an approval gate that was
          // lost to a restart (the card needs a live root agent).
          void notifyPendingApproval(agent)
          switch (args.action) {
            case 'run':
              if (!args.task) throw new Error('task is required for action=run')
              return { text: await ops.run({ task: args.task, mode: args.mode, verify: args.verify ?? [], review: args.review, repo: args.repo }, agent) }
            case 'status': return { text: await ops.status(id) }
            case 'cancel': return { text: await ops.cancel(id) }
            case 'resume': return { text: await ops.resume(id, agent, args.verify ?? []) }
            case 'approve': return { text: await ops.approve(id, agent) }
            case 'report': return { text: await ops.report(id) }
            case 'models': return { text: await ops.models(agent) }
            case 'test_connections': return { text: await ops.testConnections(agent) }
            case 'config': return { text: await ops.config() }
            default: throw new Error(`unknown action ${args.action}`)
          }
        },
      }),
    'orchestrator: orchestrate tool',
  )
}
