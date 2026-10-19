/** User-facing operations shared by the `/orchestrate` command and the `orchestrate` agent tool. */
import { classifyIntent } from './explain.js'
import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import { HELP, parseOrchestrateInput } from './commands.js'
import { PRESETS } from './orchestrator/routing.js'
import { computeMetrics, describe, renderReport } from './orchestrator/engine.js'
import { attachWorkflowJob } from './job-bridge.js'
import { redact } from './security/redaction.js'
import { ORCHESTRATOR_VERSION } from './version.js'

const NON_GIT_OPTIONS = { init: '初始化 git 并继续', review: '改为只读审查', cancel: '取消' }
const INTENT_OPTIONS = { review: '只读审查（不改代码）', change: '修改代码', cancel: '取消' }

/** One in-flight git init per directory, so concurrent requests cannot clobber each other. */
const initLocks = new Map()

/** Real on-disk path: resolves symlinks and, on macOS, the stored letter case. */
async function canonical(p) {
  const real = await fs.realpath(p).catch(() => path.resolve(p))
  return process.platform === 'darwin' || process.platform === 'win32' ? real.toLowerCase() : real
}

/** Directories where `git add -A` would sweep up a whole home or system tree. */
async function unsafeInitTarget(repo) {
  const target = await canonical(repo)
  const home = await canonical(os.homedir())
  if (target === (await canonical(path.parse(path.resolve(repo)).root))) return 'it is a filesystem root'
  if (target === home) return 'it is your home directory'
  if (home.startsWith(target + path.sep)) return 'it contains your home directory'
  return null
}

export function createOps({ ctx, config, engine, store, backends, resolveRepo, jobs, askQuestions }) {
  /** Ask what to do with a non-git target; returns 'init' | 'review' | 'cancel'. */
  async function askNonGit(agent, repo) {
    let ask
    try {
      ask = typeof askQuestions === 'function' ? askQuestions() : undefined
    } catch {
      ask = undefined
    }
    if (!ask || !agent) return 'unavailable'
    try {
      const answer = await ask({
        agent,
        questions: [{
          id: 'non-git',
          header: '不是 git 仓库',
          question: `${repo} 不是 git 仓库。编排器改代码时要用 git 隔离工作区，怎么处理？`,
          detail: '初始化会在该目录执行 git init 并把现有文件提交一次（不推送）。没有 .gitignore 时会先写一个忽略 node_modules 与 .env* 的版本；请确认目录里没有其他不该进 git 的密钥文件。只读审查不需要 git，也不会改任何文件。',
          options: [
            { label: NON_GIT_OPTIONS.init, description: 'git init + 首次提交（自动忽略 node_modules、.env*），然后按原任务运行' },
            { label: NON_GIT_OPTIONS.review, description: '不改代码，只让 Claude 和 Codex 读代码找问题' },
            { label: NON_GIT_OPTIONS.cancel, description: '什么都不做' },
          ],
        }],
      })
      // Only an exact predefined option authorises anything; free text such as
      // "初始化会不会影响现有文件？" is a question, not consent.
      const first = answer?.answers?.[0]
      const label = (first?.custom?.trim() || first?.selected?.[0] || '').trim()
      if (label === NON_GIT_OPTIONS.init) return 'init'
      if (label === NON_GIT_OPTIONS.review) return 'review'
      return 'cancel'
    } catch {
      // The card was shown (the service exists) but rejected/was dismissed.
      return 'cancel'
    }
  }

  /** Ask whether an ambiguous request means look or change; 'unavailable' when no card can be shown. */
  async function askIntent(agent, task) {
    let ask
    try {
      ask = typeof askQuestions === 'function' ? askQuestions() : undefined
    } catch {
      ask = undefined
    }
    if (!ask || !agent) return 'unavailable'
    try {
      const answer = await ask({
        agent,
        questions: [{
          id: 'intent',
          header: '看还是改？',
          question: `这句话既像审查又像修改：「${String(task).slice(0, 120)}」。要怎么做？`,
          detail: '只读审查：Claude 和 Codex 读代码给出问题清单，不改任何文件。修改代码：走完整流水线，在隔离分支上改代码。',
          options: [
            { label: INTENT_OPTIONS.review, description: '只给问题清单，不动文件' },
            { label: INTENT_OPTIONS.change, description: '设计 → 实现 → 验证 → 评审 → 提交到隔离分支' },
            { label: INTENT_OPTIONS.cancel, description: '什么都不做' },
          ],
        }],
      })
      const first = answer?.answers?.[0]
      const label = (first?.custom?.trim() || first?.selected?.[0] || '').trim()
      if (label === INTENT_OPTIONS.review) return 'review'
      if (label === INTENT_OPTIONS.change) return 'change'
      return 'cancel'
    } catch {
      return 'cancel'
    }
  }

  /**
   * git init + first commit, all or nothing. Serialised per directory; only
   * what this call verifiably created is rolled back on failure.
   * @returns {Promise<{rollback: () => Promise<void>}>}
   */
  async function initRepository(repo) {
    const unsafe = await unsafeInitTarget(repo)
    if (unsafe) throw new Error(`refusing to run git init in ${repo}: ${unsafe}. Point --repo at a project folder instead.`)
    const key = await canonical(repo)
    while (initLocks.has(key)) await initLocks.get(key).catch(() => undefined)
    const job = initUnlocked(repo)
    initLocks.set(key, job)
    try {
      return await job
    } finally {
      if (initLocks.get(key) === job) initLocks.delete(key)
    }
  }

  async function initUnlocked(repo) {
    const git = engine.git
    // Another request (or the user) may have created the repository while the
    // card was open: use it instead of failing.
    const probe = await git.exec(repo, ['rev-parse', '--show-toplevel'], { allowFail: true })
    if (!probe.spawnError && probe.exitCode === 0) return { rollback: async () => undefined }
    const dotGit = path.join(repo, '.git')
    const ignorePath = path.join(repo, '.gitignore')
    const hardened = ['-c', 'user.name=DSH Orchestrator', '-c', 'user.email=orchestrator@localhost', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false']
    let createdIgnore = false
    let createdGit = false
    const rollback = async () => {
      if (createdGit) await fs.rm(dotGit, { recursive: true, force: true })
      if (createdIgnore) await fs.rm(ignorePath, { force: true })
    }
    let step = 'git init'
    try {
      if (await fs.lstat(dotGit).then(() => true, () => false)) throw new Error(`${dotGit} already exists; refusing to initialise over it`)
      try {
        await fs.writeFile(ignorePath, 'node_modules/\n.env\n.env.*\n*.pem\n*.key\n.DS_Store\n', { flag: 'wx' })
        createdIgnore = true // only now is the file ours
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      // Ownership of .git is claimed by creating the directory exclusively
      // (mkdir without recursive fails if someone else made it).
      await fs.mkdir(dotGit)
      createdGit = true
      await git.exec(repo, ['init', '-q'])
      step = 'git add'
      await git.exec(repo, ['add', '-A'])
      step = 'git commit'
      await git.exec(repo, [...hardened, 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'initial import (created by the orchestrator at the user\'s request)'])
      return { rollback }
    } catch (error) {
      await rollback()
      throw new Error(`could not initialise git in ${repo} (failed at ${step}: ${error?.message ?? error}); only files this attempt created were removed`)
    }
  }

  /** A repo argument may be absolute or relative to the session's directory. */
  async function resolveRepoPath(value, agent) {
    const base = path.isAbsolute(value) ? value : path.resolve(await resolveRepo(agent), value)
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
      // No mode given: decide look vs change from the wording, and ask when unsure.
      let effectiveMode = mode
      let routingNote = ''
      if (!mode) {
        let intent = classifyIntent(task)
        if (intent === 'ambiguous') {
          const answer = await askIntent(agent, task)
          if (answer === 'cancel') return '已取消，什么都没做。'
          if (answer === 'unavailable') {
            intent = 'review'
            routingNote = '（措辞既像审查又像修改，这里无法弹卡片确认，按更安全的只读审查处理；要改代码请加 --mode balanced）'
          } else intent = answer
        } else if (intent === 'review') {
          routingNote = '（按你的措辞判断为只读审查；要改代码请加 --mode balanced）'
        }
        if (intent === 'review') effectiveMode = 'review'
        else {
          // An explicit "change" must change code even if the default mode is read-only.
          const fallback = config.orchestrator?.mode
          effectiveMode = fallback && fallback !== 'review' ? fallback : 'balanced'
        }
      }
      let wf
      try {
        wf = await engine.start({ task, repo, parent: agent, mode: effectiveMode, verify, review })
      } catch (error) {
        if (error?.code !== 'NOT_GIT_REPO') throw error
        const choice = await askNonGit(agent, repo)
        if (choice === 'review') wf = await engine.start({ task, repo, parent: agent, mode: 'review', verify: [] })
        else if (choice === 'init') {
          const { rollback } = await initRepository(repo)
          try {
            wf = await engine.start({ task, repo, parent: agent, mode: effectiveMode, verify, review })
          } catch (startError) {
            await rollback().catch(() => undefined)
            throw new Error(`${startError?.message ?? startError} (the git repository created for this request was removed again)`)
          }
        } else if (choice === 'unavailable') {
          return `${repo} 不是 git 仓库，没有开始（这里弹不出选择卡片）。\n- 只想看问题：加 --mode review（只读，不需要 git）\n- 要改代码：先在该目录 git init 并提交一次，再重新发起任务`
        } else {
          return `已取消：${repo} 不是 git 仓库，什么都没做。`
        }
      }
      if (wf.route?.readOnly) {
        return `开始只读审查 ${wf.id}${routingNote}：Claude（${config.roles.architect.critiqueModel}）和 Codex（${config.roles.reviewer.model}）同时阅读 ${repo}，只用只读权限，结束时核对文件未被改动（被 .gitignore 忽略的文件和 node_modules 等依赖目录不在核对范围内）。完成后结果会直接发到聊天里（通常 2–5 分钟）。`
      }
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
