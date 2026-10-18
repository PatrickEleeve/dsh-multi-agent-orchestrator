/**
 * Orchestrator engine: drives one workflow through
 * PLANNING → IMPLEMENTING → VERIFYING → REVIEWING → (FIXING → VERIFYING)* → COMPLETED,
 * persisting every transition. Pure orchestration: backends do the model work.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { routeFor } from './routing.js'
import { transition, isTerminal } from './state-machine.js'
import { ARTIFACT_FILES, buildArchitectPrompt, parseArchitectOutput } from '../agents/architect.js'
import { buildFixPrompt, buildImplementPrompt } from '../agents/implementer.js'
import { REVIEW_SCHEMA, buildReviewPrompt, parseReview } from '../agents/reviewer.js'
import { isPathAllowed, normalizeVerificationCommand } from '../security/permissions.js'
import { runVerification, verificationFingerprint } from '../verification/runner.js'
import { terminateOrphan } from '../process.js'
import { collectChanges, commitTask, createWorktree, originalUntouched, restoreInfoExclude, stagedTree } from '../workspace/worktree.js'
import { redact } from '../security/redaction.js'

const sha = (text) => createHash('sha256').update(text).digest('hex')

/** Write a file in the worktree without ever following a symlink there. */
async function writeNoFollow(file, content) {
  const stat = await fs.lstat(file).catch(() => null)
  if (stat) {
    if (stat.isDirectory()) throw new Error(`refusing to overwrite directory ${file}`)
    await fs.unlink(file) // removes a symlink itself, not its target
  }
  await fs.writeFile(file, content, { flag: 'wx' })
}
const BLOCKING_KINDS = new Set(['auth', 'rate_limit', 'billing', 'unavailable', 'timeout'])
const MAX_STAGE_RETRIES = 1

class Halt extends Error {
  constructor(kind, message) {
    super(message)
    this.kind = kind // 'blocked' | 'cancelled'
  }
}

export class Engine {
  /**
   * @param {{config:object, store:import('./persistence.js').WorkflowStore, backends:{architect:any, implementer:any, reviewer:any}, git:any, run?:Function, onChange?:(wf:object)=>void}} deps
   */
  constructor({ config, store, backends, git, run, onChange }) {
    this.config = config
    this.store = store
    this.backends = backends
    this.git = git
    this.run = run
    this.onChange = onChange ?? (() => undefined)
    /** @type {Map<string,{controller:AbortController, promise:Promise<void>, parent:any}>} */
    this.live = new Map()
    /** Live root Agent per workflow, so a human-interaction prompt can be addressed to it. */
    this.parents = new Map()
    /** External observers (Jobs bridge, UI hooks); they never affect the workflow. */
    this.observers = new Set()
    /** Slots and ids reserved synchronously before any await (see `claim`). */
    this.claims = new Set()
  }

  /** Reserve capacity before the first await; callers must release in `finally`. */
  claim(key) {
    const limit = this.config.orchestrator.maxParallelWorkers
    if (key !== null) {
      // Only a concurrent *operation* is rejected here; whether the workflow is
      // live is checked after its (possibly unwinding) driver has settled.
      if (this.claims.has(key)) throw new Error(`workflow "${key}" is already being started, resumed or approved`)
      this.claims.add(key)
      return () => this.claims.delete(key)
    }
    // A fresh run must not exceed the worker slots, counting in-flight operations.
    if (this.live.size + this.claims.size >= limit) throw new Error(`a workflow is already running (maxParallelWorkers=${limit}); wait for it or cancel it`)
    const token = Symbol('start')
    this.claims.add(token)
    return () => this.claims.delete(token)
  }

  isLive(id) {
    return this.live.has(id)
  }

  /** Create + persist a workflow, then drive it in the background. */
  async start({ task, repo, parent, mode, verify, review }) {
    // Reserve the single worker slot BEFORE any await: two parallel starts must
    // not both pass the limit check.
    const release = this.claim(null)
    try {
    // Fail here, synchronously for the caller, instead of letting the driver
    // discover it later: "not a git repository" is a user error, not a workflow.
    const probe = await this.git.exec(repo, ['rev-parse', '--show-toplevel'], { allowFail: true })
    if (probe.spawnError || probe.exitCode !== 0) {
      throw new Error(`"${repo}" is not a git repository. The orchestrator isolates every run in a git worktree, so the target must be a repository (pass repo="/path/to/repo" or change the chat's working directory).`)
    }
    const effectiveMode = mode ?? this.config.orchestrator.mode
    const route = routeFor(effectiveMode, { review })
    const specs = verify && verify.length > 0 ? verify : this.config.verification.commands
    // Fail early on policy violations rather than mid-workflow.
    for (const spec of specs) normalizeVerificationCommand(spec, this.config.verification)
    const now = new Date().toISOString()
    const wf = {
      id: `wf-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
      task,
      repo,
      mode: effectiveMode,
      route,
      verifySpecs: specs,
      state: 'CREATED',
      createdAt: now,
      updatedAt: now,
      history: [],
      stages: [],
      attempts: [],
      fixCycles: 0,
      escalations: 0,
      noProgress: 0,
      fingerprints: [],
      violations: [],
      artifacts: {},
      verification: null,
      verificationHistory: [],
      review: null,
      reviews: [],
      humanInterventions: 0,
      active: null,
      blocker: null,
      config: {
        mode: effectiveMode,
        roles: { architect: this.config.roles.architect.model, implementer: `${this.config.roles.implementer.provider}/${this.config.roles.implementer.model}`, reviewer: this.config.roles.reviewer.model },
        maxFixCycles: this.config.orchestrator.maxFixCycles,
      },
    }
    await this.persist(wf)
    this.launch(wf, parent)
    return wf
    } finally {
      release()
    }
  }

  /** Resume a BLOCKED workflow from the stage it was blocked in. */
  async resume(id, parent, options = {}) {
    // Synchronous claim first: a second resume/approve for the same id is
    // rejected before it can await and then win the race.
    const release = options.claimHeld === true ? () => undefined : this.claim(id)
    try {
    // A driver that has just blocked may still be unwinding; let it settle so a
    // prompt or command issued at that moment is not refused as "already running".
    const settling = this.live.get(id)
    if (settling) await settling.promise.catch(() => undefined)
    const wf = await this.store.load(id)
    if (!wf) throw new Error(`unknown workflow ${id}`)
    if (this.live.has(id)) throw new Error(`workflow ${id} is already running`)
    if (wf.state !== 'BLOCKED') throw new Error(`workflow ${id} is ${wf.state}; only BLOCKED workflows can be resumed`)
    // A workflow blocked for missing verification is fixed by supplying the
    // commands, not by editing the plugin config: validate them exactly like
    // the ones a fresh run receives.
    if (Array.isArray(options.verify) && options.verify.length > 0) {
      for (const spec of options.verify) normalizeVerificationCommand(spec, this.config.verification)
      wf.verifySpecs = options.verify
      if (wf.blocker?.kind === 'no_verification') wf.blocker = null
    }
    // The user was told to inspect their repository; their fix is the new baseline.
    if (wf.blocker?.kind === 'isolation_violation' && wf.workspace?.repoRoot) {
      const { snapshotRepo } = await import('../workspace/worktree.js')
      const fresh = await snapshotRepo(this.git, wf.workspace.repoRoot)
      wf.originalSnapshot = {
        head: fresh.head, status: fresh.status, branch: fresh.branch, dirty: fresh.dirty,
        gitCommonDir: fresh.gitCommonDir, infoExcludeHash: fresh.infoExcludeHash,
        configHash: fresh.configHash, hooksHash: fresh.hooksHash,
      }
      await fs.writeFile(this.snapshotFile(wf), JSON.stringify(fresh), { mode: 0o600 }).catch(() => undefined)
    }
    wf.humanInterventions += 1
    wf.blocker = null
    transition(wf, wf.blockedFrom ?? 'PLANNING', 'resumed by user')
    await this.persist(wf)
    this.launch(wf, parent)
    return wf
    } finally {
      release()
    }
  }

  /** Human approval gate (thorough mode) before the task branch is committed. */
  async approve(id, parent) {
    const release = this.claim(id)
    try {
      const settling = this.live.get(id)
      if (settling) await settling.promise.catch(() => undefined)
      const wf = await this.store.load(id)
      if (!wf) throw new Error(`unknown workflow ${id}`)
      if (!wf.awaitingApproval) throw new Error(`workflow ${id} is not awaiting approval`)
      wf.approved = true
      wf.awaitingApproval = false
      await this.persist(wf)
      await this.resume(id, parent, { claimHeld: true })
      return this.store.load(id)
    } finally {
      release()
    }
  }

  async cancel(id) {
    const entry = this.live.get(id)
    if (entry) {
      entry.controller.abort()
      await entry.promise.catch(() => undefined)
      return this.store.load(id)
    }
    const wf = await this.store.load(id)
    if (!wf) throw new Error(`unknown workflow ${id}`)
    if (isTerminal(wf)) return wf
    transition(wf, 'CANCELLED', 'cancelled while not running')
    await this.persist(wf)
    return wf
  }

  /** The exact live root Agent that started (or resumed) this workflow, if still known. */
  parentFor(id) {
    return this.parents.get(id)
  }

  launch(wf, parent) {
    if (this.live.has(wf.id)) throw new Error(`workflow "${wf.id}" is already running`)
    const controller = new AbortController()
    const entry = { controller, parent, promise: Promise.resolve() }
    if (parent) this.parents.set(wf.id, parent)
    else this.parents.delete(wf.id)
    entry.promise = this.drive(wf, entry)
      .catch(() => undefined) // drive() already records its own failure; never reject unhandled
      .finally(() => {
        this.live.delete(wf.id)
        if (isTerminal(wf)) this.parents.delete(wf.id)
      })
    this.live.set(wf.id, entry)
  }

  /** @param {(wf:object)=>void} observer @returns {() => void} unsubscribe */
  observe(observer) {
    this.observers.add(observer)
    return () => this.observers.delete(observer)
  }

  async persist(wf) {
    wf.updatedAt = new Date().toISOString()
    await this.store.save(wf)
    try {
      this.onChange(wf)
    } catch {
      /* observers must not break the workflow */
    }
    for (const observer of this.observers) {
      try {
        observer(wf)
      } catch {
        /* an observer must never break the workflow */
      }
    }
  }

  async move(wf, to, reason, detail) {
    transition(wf, to, reason, detail)
    await this.persist(wf)
  }

  // ---------------------------------------------------------------- driver

  async drive(wf, entry) {
    const signal = entry.controller.signal
    try {
      if (!wf.workspace) await this.prepareWorkspace(wf)
      let guard = 0
      while (!isTerminal(wf)) {
        if (signal.aborted) throw new Halt('cancelled', 'cancelled by user')
        if (++guard > 200) throw new Error('internal loop guard tripped')
        switch (wf.state) {
          case 'CREATED':
            await this.move(wf, wf.route.architect ? 'PLANNING' : 'IMPLEMENTING', 'workspace ready')
            break
          case 'PLANNING':
            await this.stagePlanning(wf, signal)
            break
          case 'IMPLEMENTING':
          case 'FIXING':
            await this.stageImplement(wf, entry, signal)
            break
          case 'VERIFYING':
            await this.stageVerify(wf, signal)
            break
          case 'REVIEWING':
            await this.stageReview(wf, signal)
            break
          case 'BLOCKED':
            return
          default:
            throw new Error(`driver reached unexpected state ${wf.state}`)
        }
      }
    } catch (error) {
      await this.handleHalt(wf, error)
    } finally {
      // A resumed workflow replaces the live entry; the superseded driver must
      // never write its stale snapshot over the newer state.
      const superseded = this.live.get(wf.id) !== undefined && this.live.get(wf.id).controller !== entry.controller
      if (!superseded) {
        wf.active = null
        await this.writeReport(wf).catch(() => undefined)
        await this.persist(wf).catch(() => undefined)
      }
    }
  }

  async handleHalt(wf, error) {
    if (isTerminal(wf)) return
    if (error instanceof Halt && error.kind === 'cancelled') {
      transition(wf, 'CANCELLED', 'cancelled; filesystem changes already made are NOT reverted')
    } else if (error instanceof Halt) {
      transition(wf, 'BLOCKED', error.message)
      wf.blocker = { kind: error.blockKind ?? 'blocked', message: error.message }
    } else {
      // An orchestrator-internal fault is not a verdict on the work: keep the
      // workflow resumable (BLOCKED) instead of dead-ending it in FAILED.
      transition(wf, 'BLOCKED', `internal error: ${redact(String(error?.message ?? error)).slice(0, 500)}`)
      wf.blocker = { kind: 'internal', message: `Orchestrator internal error: ${redact(String(error?.message ?? error)).slice(0, 1000)}. Completed stages are preserved; fix the cause and run "/orchestrate resume ${wf.id}".` }
    }
    wf.active = null
    await this.persist(wf)
  }

  block(kind, message) {
    const halt = new Halt('blocked', message)
    halt.blockKind = kind
    return halt
  }

  // ------------------------------------------------------------- workspace

  async prepareWorkspace(wf) {
    const ws = await createWorktree({ git: this.git, repo: wf.repo, workflowId: wf.id, dataDir: this.config.orchestrator.dataDir })
    wf.workspace = { path: ws.path, branch: ws.branch, baseSha: ws.baseSha, repoRoot: ws.repoRoot, warnings: ws.warnings }
    wf.originalSnapshot = ws.originalSnapshot
    // Exact git-metadata bytes (info/exclude) live beside the workflow, not in
    // state.json, so a violation can be reverted without storing it redacted.
    await fs.mkdir(this.store.dir(wf.id), { recursive: true })
    await fs.writeFile(this.snapshotFile(wf), JSON.stringify(ws.privateSnapshot), { mode: 0o600 })
    await this.persist(wf)
  }

  snapshotFile(wf) {
    return path.join(this.store.dir(wf.id), 'repo-snapshot.json')
  }

  get artifactDir() {
    return (wf) => path.join(this.store.dir(wf.id), 'artifacts')
  }

  async syncArtifactsToWorktree(wf) {
    const dest = path.join(wf.workspace.path, '.orchestrator')
    await fs.mkdir(dest, { recursive: true })
    for (const name of ARTIFACT_FILES) {
      const body = await fs.readFile(path.join(this.artifactDir(wf), name), 'utf8').catch(() => null)
      if (body !== null) await writeNoFollow(path.join(dest, name), body)
    }
  }

  /** Detect + revert any implementer edit to the specification (cannot rewrite acceptance criteria). */
  async guardArtifacts(wf) {
    for (const name of ARTIFACT_FILES) {
      const expected = wf.artifacts[name]
      if (!expected) continue
      const current = await fs.readFile(path.join(wf.workspace.path, '.orchestrator', name), 'utf8').catch(() => null)
      if (current === null || sha(current) !== expected) {
        wf.violations.push({ at: new Date().toISOString(), kind: 'artifact_tampering', detail: `${name} was modified/deleted by the implementer; restored`, })
        const canonical = await fs.readFile(path.join(this.artifactDir(wf), name), 'utf8')
        await fs.mkdir(path.join(wf.workspace.path, '.orchestrator'), { recursive: true })
        await writeNoFollow(path.join(wf.workspace.path, '.orchestrator', name), canonical)
      }
    }
  }

  /** Startup reconciliation for a workflow that lost its driver mid-run. */
  async reconcileOrphans(active) {
    const result = await terminateOrphan(active)
    return result.note
  }

  /**
   * Files that steer the Architect (CLAUDE.md) or the Reviewer (AGENTS.md) are
   * inputs to *other* agents: the implementer must never author them.
   */
  guardInstructionFiles(wf, files) {
    const steering = files.filter((file) => /(^|\/)(AGENTS\.md|CLAUDE\.md)$/.test(file) || file === '.claude' || file.startsWith('.claude/') || file === '.codex' || file.startsWith('.codex/'))
    if (steering.length > 0) {
      wf.violations.push({ at: new Date().toISOString(), kind: 'instruction_file_modified', detail: `implementer authored agent-instruction files: ${steering.join(', ')}` })
      throw this.block('instruction_file_modified', `The implementer modified files that steer other agents (${steering.join(', ')}). This can redirect the independent reviewer, so the workflow is blocked before any review happens.`)
    }
  }

  /** Enforce security.allowedPaths on the changed files (empty list = whole worktree). */
  enforceAllowedPaths(wf, files) {
    const allowed = this.config.security.allowedPaths ?? []
    if (allowed.length === 0) return
    const outside = files.filter((file) => !isPathAllowed(file, { allowedPaths: allowed }))
    if (outside.length > 0) {
      wf.violations.push({ at: new Date().toISOString(), kind: 'path_violation', detail: `changed files outside security.allowedPaths ${JSON.stringify(allowed)}: ${outside.join(', ')}` })
      throw this.block('path_violation', `The implementer changed files outside the allowed paths (${allowed.join(', ')}): ${outside.join(', ')}. Nothing was reviewed or delivered; adjust security.allowedPaths or the task, then resume.`)
    }
  }

  async guardOriginal(wf) {
    const check = await originalUntouched(this.git, wf.workspace.repoRoot, wf.originalSnapshot)
    if (check.untouched) return
    if (check.treeSame && !check.metadataSame) {
      // A stray write into the shared git directory (worktrees share it). This is
      // outside the worktree and must never happen, but it is reversible.
      let restored = false
      try {
        const privateSnapshot = JSON.parse(await fs.readFile(this.snapshotFile(wf), 'utf8'))
        restored = await restoreInfoExclude(privateSnapshot)
      } catch {
        restored = false
      }
      wf.violations.push({ at: new Date().toISOString(), kind: 'repo_metadata_modified', detail: `the shared git directory changed during the workflow (worktree tree unchanged); ${restored ? 'info/exclude restored to its snapshot bytes' : 'could not be restored automatically'}` })
      throw this.block('isolation_violation', `The workflow modified shared git metadata of the original repository (outside the worktree)${restored ? '; .git/info/exclude was restored to its previous content' : ''}. Failing closed: the implementer must not touch anything outside the worktree, including the shared .git directory. Inspect the repository, then resume.`)
    }
    wf.violations.push({ at: new Date().toISOString(), kind: 'original_modified', detail: 'the original working tree changed during the workflow' })
    throw this.block('isolation_violation', 'The original repository working tree changed while the workflow ran. Failing closed; inspect it manually before resuming.')
  }

  // --------------------------------------------------------------- stages

  /** Run a backend call with stage bookkeeping, bounded retry, and block/cancel mapping. */
  async callBackend(wf, role, backendName, fn, signal) {
    let result
    for (let attempt = 0; attempt <= MAX_STAGE_RETRIES; attempt++) {
      if (signal.aborted) throw new Halt('cancelled', 'cancelled')
      wf.active = { role, backend: backendName, startedAt: new Date().toISOString(), attempt: attempt + 1 }
      await this.persist(wf)
      // Record the live child pid so a crash mid-run can be reconciled at startup
      // (a killed CLI does not undo filesystem changes, and a leftover CLI must not
      // keep writing into the worktree).
      const onPid = (pid, executable) => {
        wf.active = { ...(wf.active ?? {}), pid, executable }
        void this.persist(wf).catch(() => undefined)
      }
      result = await fn({ onPid })
      const stage = {
        role,
        state: wf.state,
        backend: result.backend ?? backendName,
        model: result.model ?? null,
        requestedModel: result.requestedModel ?? null,
        modelVerified: result.modelVerified ?? false,
        startedAt: wf.active.startedAt,
        durationMs: result.durationMs,
        ok: result.ok,
        usage: result.usage ?? null,
        billing: result.billing ?? null,
        stopReason: result.stopReason,
        childSessionId: result.childSessionId,
        error: result.error ?? null,
        attempt: attempt + 1,
      }
      wf.stages.push(stage)
      wf.active = null
      await this.persist(wf)
      if (result.ok) return result
      if (result.error?.kind === 'cancelled' || signal.aborted) throw new Halt('cancelled', 'cancelled')
      if (BLOCKING_KINDS.has(result.error?.kind)) {
        throw this.block(result.error.kind, `${role} backend "${backendName}" unavailable (${result.error.kind}): ${result.error.message}. Workflow state preserved; fix the backend and run "/orchestrate resume ${wf.id}". No fallback backend was activated.`)
      }
    }
    throw this.block('backend_failed', `${role} backend "${backendName}" failed after ${MAX_STAGE_RETRIES + 1} attempts: ${result.error?.message ?? 'unknown error'}`)
  }

  async repoOverview(wf) {
    const out = await this.git.exec(wf.workspace.path, ['ls-files'], { allowFail: true })
    const files = out.stdout.split('\n').filter(Boolean)
    let readme = ''
    const readmeName = files.find((f) => /^readme(\.md)?$/i.test(f))
    if (readmeName) {
      const readmePath = path.join(wf.workspace.path, readmeName)
      // A symlink here would send the Architect arbitrary file contents.
      const stat = await fs.lstat(readmePath).catch(() => null)
      if (stat?.isFile() && !stat.isSymbolicLink()) readme = (await fs.readFile(readmePath, 'utf8').catch(() => '')).slice(0, 3000)
    }
    return `Tracked files (${files.length}${files.length > 200 ? ', first 200' : ''}):\n${files.slice(0, 200).join('\n') || '(empty repository)'}\n\n${readme ? `README:\n${readme}` : ''}`
  }

  async stagePlanning(wf, signal) {
    const revising = wf.revision
    const previous = revising ? await this.readArtifacts(wf) : undefined
    const verifyCommands = wf.verifySpecs.map((s) => (typeof s === 'string' ? s : [s.command, ...(s.args ?? [])].join(' ')))
    const prompts = [{ label: 'design', revisionNotes: revising?.notes, previous }]
    if (wf.route.critique && !revising && !wf.critiqued) prompts.push({ label: 'critique' })
    for (const p of prompts) {
      let docs
      let lastErrors = []
      for (let attempt = 0; attempt < 2 && !docs; attempt++) {
        const basePrompt = buildArchitectPrompt({
          task: wf.task,
          overview: await this.repoOverview(wf),
          verifyCommands,
          revisionNotes: p.revisionNotes ?? (p.label === 'critique' ? 'Self-critique pass: find flaws, ambiguities and missing edge cases in the previous design and fix them.' : undefined),
          previous: p.previous ?? (p.label === 'critique' ? await this.readArtifacts(wf) : undefined),
        })
        const prompt = lastErrors.length ? `${basePrompt}\n\nYour previous answer was rejected by validation: ${lastErrors.join('; ')}. Follow the output format exactly.` : basePrompt
        const result = await this.callBackend(wf, `architect:${p.label}`, 'claude-cli', (extra) =>
          this.backends.architect.execute(
            { prompt, cwd: wf.workspace.path, runId: `${wf.id}-arch-${p.label}-${attempt}` },
            { model: this.config.roles.architect.model, timeoutMs: this.config.roles.architect.timeoutMs, signal, permissionMode: this.config.roles.architect.permissionMode, ...extra },
          ), signal)
        const parsed = parseArchitectOutput(result.text)
        if (parsed.ok) docs = parsed.files
        else lastErrors = parsed.errors
      }
      if (!docs) throw this.block('invalid_architecture', `Architect output failed validation twice: ${lastErrors.join('; ')}`)
      await this.writeArtifacts(wf, docs, p.label)
      if (p.label === 'critique') wf.critiqued = true
    }
    if (wf.revision) {
      wf.revision.applied = true
      wf.escalationLog = [...(wf.escalationLog ?? []), { at: new Date().toISOString(), notes: wf.revision.notes.slice(0, 500) }]
    }
    await this.syncArtifactsToWorktree(wf)
    await this.move(wf, 'IMPLEMENTING', wf.revision ? 'architecture revised after repeated failures' : 'architecture approved')
  }

  async readArtifacts(wf) {
    const out = {}
    for (const name of ARTIFACT_FILES) out[name] = await fs.readFile(path.join(this.artifactDir(wf), name), 'utf8').catch(() => '')
    return out
  }

  async writeArtifacts(wf, docs, label) {
    await fs.mkdir(this.artifactDir(wf), { recursive: true })
    for (const [name, body] of Object.entries(docs)) {
      const redacted = redact(body)
      const previous = wf.artifacts[name]
      await fs.writeFile(path.join(this.artifactDir(wf), name), redacted)
      wf.artifacts[name] = sha(redacted)
      if (previous && previous !== wf.artifacts[name] && name === 'acceptance-criteria.md') {
        wf.violations.push({ at: new Date().toISOString(), kind: 'acceptance_changed_by_architect', detail: `acceptance criteria revised by the Architect (${label}); recorded for audit` })
      }
    }
    await this.persist(wf)
  }

  async stageImplement(wf, entry, signal) {
    const fixing = wf.state === 'FIXING'
    const pending = wf.pendingFix
    const role = this.config.roles.implementer
    const prompt = fixing || pending
      ? buildFixPrompt({ task: wf.task, cycle: wf.fixCycles, max: this.config.orchestrator.maxFixCycles, verification: pending?.verification, review: pending?.review, escalation: Boolean(wf.revision?.applied) })
      : buildImplementPrompt({ task: wf.task, hasSpec: Object.keys(wf.artifacts).length > 0, verifyCommands: wf.verifySpecs.map((s) => (typeof s === 'string' ? s : [s.command, ...(s.args ?? [])].join(' '))) })
    const before = await collectChanges(this.git, wf.workspace.path, wf.workspace.baseSha)
    const result = await this.callBackend(wf, fixing ? 'implementer:fix' : 'implementer', 'dsh-native', (extra) =>
      this.backends.implementer.execute(
        { prompt, cwd: wf.workspace.path, parent: entry.parent, runId: `${wf.id}-impl-${wf.history.length}`, label: fixing ? `fix cycle ${wf.fixCycles}` : 'implement' },
        { timeoutMs: role.timeoutMs, signal, ...extra },
      ), signal)
    await this.guardOriginal(wf)
    await this.guardArtifacts(wf)
    const after = await collectChanges(this.git, wf.workspace.path, wf.workspace.baseSha)
    this.guardInstructionFiles(wf, after.files)
    this.enforceAllowedPaths(wf, after.files)
    const changed = sha(after.diff) !== sha(before.diff)
    wf.attempts.push({ at: new Date().toISOString(), state: wf.state, changedFiles: after.files.length, diffChanged: changed, report: redact(result.text).slice(0, 2000) })
    wf.changes = { files: after.files, stat: after.stat }
    wf.pendingFix = null
    wf.revision = wf.revision?.applied ? null : wf.revision
    if (after.files.length === 0) {
      // Never accept "done" without actual filesystem changes.
      return this.failedAttempt(wf, 'The implementer produced no file changes (claims without filesystem evidence are rejected).', { verification: { status: 'failed', results: [{ name: 'no-file-changes', command: '-', args: [], exitCode: 1, passed: false, output: 'no file changes in worktree' }] } }, `no-changes:${wf.fixCycles}`)
    }
    await this.move(wf, 'VERIFYING', `implementer finished (${after.files.length} files changed)`)
  }

  async stageVerify(wf, signal) {
    if (!this.config.verification.enabled) {
      wf.verification = { status: 'skipped', results: [], durationMs: 0 }
      return this.afterVerification(wf)
    }
    const verification = await runVerification({ cwd: wf.workspace.path, specs: wf.verifySpecs, policy: this.config.verification, signal })
    if (verification.status === 'cancelled') throw new Halt('cancelled', 'cancelled')
    wf.verification = verification
    wf.verificationHistory.push({ at: new Date().toISOString(), status: verification.status, results: verification.results.map(({ name, passed, exitCode, durationMs, testSummary }) => ({ name, passed, exitCode, durationMs, testSummary })) })
    await this.persist(wf)
    if (verification.status === 'not_configured') {
      if (this.config.verification.failClosed) {
        throw this.block('no_verification', `No verification commands are configured, so there is no evidence to gate the review on. Failing closed (by design). Fix it either way: run "/orchestrate resume${wf.id ? ` ${wf.id}` : ''} --verify \"npm test\"" (id optional, commands must be on the allow-list) or set verification.commands in the plugin config.`)
      }
    }
    if (verification.status === 'failed') {
      return this.failedAttempt(wf, 'verification failed', { verification }, `v:${verificationFingerprint(verification)}`)
    }
    return this.afterVerification(wf)
  }

  async afterVerification(wf) {
    if (wf.route.review) await this.move(wf, 'REVIEWING', 'verification passed')
    else await this.finish(wf, 'verification passed; review not required in this mode')
  }

  async stageReview(wf, signal) {
    if (wf.awaitingApproval === false && wf.approved && wf.review?.verdict === 'APPROVE') return this.finish(wf, 'APPROVE + human approval')
    // Fail closed: review never runs on an unverified tree.
    if (this.config.verification.requiredBeforeReview && wf.verification?.status !== 'passed' && wf.verification?.status !== 'skipped') {
      throw this.block('verification_required', 'Review requires passing deterministic verification first.')
    }
    const changes = await collectChanges(this.git, wf.workspace.path, wf.workspace.baseSha)
    // The reviewer signs off on a *tree*, not on a truncated diff.
    const reviewed = await stagedTree(this.git, wf.workspace.path)
    wf.reviewedTree = reviewed.tree
    await this.persist(wf)
    const prompt = buildReviewPrompt({ task: wf.task, docs: await this.readArtifacts(wf), changes, verification: wf.verification, baseSha: wf.workspace.baseSha })
    let review
    let parseError
    for (let attempt = 0; attempt < 2 && !review; attempt++) {
      const result = await this.callBackend(wf, 'reviewer', 'codex-cli', (extra) =>
        this.backends.reviewer.execute(
          { prompt: parseError ? `${prompt}\n\nYour previous reply was rejected: ${parseError}. Reply with only the JSON object.` : prompt, cwd: wf.workspace.path, outputSchema: REVIEW_SCHEMA, runId: `${wf.id}-review-${wf.reviews.length}-${attempt}` },
          { model: this.config.roles.reviewer.model, timeoutMs: this.config.roles.reviewer.timeoutMs, signal, scratchDir: this.store.dir(wf.id), ...extra },
        ), signal)
      const parsed = parseReview(result.text)
      if (parsed.ok) review = parsed.review
      else parseError = parsed.error
    }
    if (!review) throw this.block('invalid_review', `Reviewer output failed validation twice: ${parseError}`)
    // The reviewer is read-only, but verify the tree really is unchanged.
    await this.guardOriginal(wf)
    const after = await stagedTree(this.git, wf.workspace.path)
    if (after.tree !== reviewed.tree) {
      wf.violations.push({ at: new Date().toISOString(), kind: 'reviewer_modified_tree', detail: `tree changed during review (${reviewed.tree.slice(0, 12)} -> ${after.tree.slice(0, 12)})` })
      throw this.block('isolation_violation', 'The worktree changed during the read-only review; failing closed.')
    }
    wf.review = review
    wf.reviews.push({ at: new Date().toISOString(), ...review })
    await this.persist(wf)
    if (review.verdict === 'BLOCKED') throw this.block('review_blocked', `Reviewer reported BLOCKED: ${review.summary}`)
    if (review.verdict === 'REQUEST_CHANGES') {
      return this.failedAttempt(wf, 'review requested changes', { review }, `r:${review.findings.map((f) => `${f.file}:${f.description}`).join('|')}`)
    }
    if (wf.route.humanApproval && !wf.approved) {
      wf.awaitingApproval = true
      throw this.block('awaiting_approval', `Review APPROVED. Thorough mode requires human approval before the task branch is committed: run "/orchestrate approve ${wf.id}".`)
    }
    return this.finish(wf, 'APPROVE')
  }

  /**
   * Shared failure path for verification/review/no-change: bounded repair
   * cycles, no-progress detection, one Architect escalation, else BLOCKED.
   */
  async failedAttempt(wf, reason, evidence, fingerprint) {
    const max = this.config.orchestrator.maxFixCycles
    const repeated = wf.fingerprints.at(-1) === fingerprint
    wf.fingerprints.push(fingerprint)
    wf.noProgress = repeated ? wf.noProgress + 1 : 0
    wf.pendingFix = evidence
    if (wf.noProgress >= 1 && wf.route.architect && wf.escalations < 1 && wf.fixCycles < max) {
      wf.escalations += 1
      wf.noProgress = 0
      wf.revision = { notes: `${reason}. The same failure repeated after a repair.\n${JSON.stringify(evidence, null, 1).slice(0, 6000)}`, applied: false }
      return this.move(wf, 'PLANNING', `repeated failure; escalating to Architect (${reason})`)
    }
    if (wf.fixCycles >= max || wf.noProgress >= 2) {
      throw this.block('repair_exhausted', `${reason}. ${wf.noProgress >= 2 ? 'No progress detected (identical failure repeated).' : `Repair budget exhausted (${wf.fixCycles}/${max} cycles).`} Diagnostics are preserved in ${this.store.dir(wf.id)}.`)
    }
    wf.fixCycles += 1
    return this.move(wf, 'FIXING', `${reason}; repair cycle ${wf.fixCycles}/${max}`)
  }

  async finish(wf, reason) {
    // Completion invariant: verification and review statuses are tracked separately.
    const vOk = wf.verification?.status === 'passed' || wf.verification?.status === 'skipped'
    if (!vOk) throw this.block('verification_required', 'cannot complete without passing verification')
    if (wf.route.review && wf.review?.verdict !== 'APPROVE') throw this.block('review_required', 'cannot complete without reviewer approval')
    await this.guardOriginal(wf)
    const final = await stagedTree(this.git, wf.workspace.path)
    if (wf.reviewedTree && final.tree !== wf.reviewedTree) {
      wf.violations.push({ at: new Date().toISOString(), kind: 'tree_changed_after_review', detail: `reviewed tree ${wf.reviewedTree.slice(0, 12)} but committing ${final.tree.slice(0, 12)}` })
      throw this.block('tree_changed', 'The worktree changed after the independent review (approval, fix or config drift). Nothing was committed; re-run the review before delivering.')
    }
    const changes = await collectChanges(this.git, wf.workspace.path, wf.workspace.baseSha)
    this.enforceAllowedPaths(wf, changes.files)
    if (changes.files.length === 0) throw this.block('no_changes', 'no file changes to deliver')
    const commit = await commitTask(this.git, wf.workspace.path, `orchestrate: ${wf.task.slice(0, 72)}\n\nWorkflow ${wf.id} (${wf.mode}). Not merged; review branch ${wf.workspace.branch}.`)
    wf.delivery = { branch: wf.workspace.branch, worktree: wf.workspace.path, commit: commit.sha, files: changes.files, merged: false, pushed: false }
    await this.move(wf, 'COMPLETED', reason)
  }

  // --------------------------------------------------------------- reports

  async writeReport(wf) {
    await fs.mkdir(this.store.dir(wf.id), { recursive: true })
    await fs.writeFile(path.join(this.store.dir(wf.id), 'report.md'), renderReport(wf), { mode: 0o600 })
  }
}

export function computeMetrics(wf) {
  const end = wf.finishedAt ? Date.parse(wf.finishedAt) : Date.now()
  const sum = (key) => {
    const values = (wf.stages ?? []).map((s) => s.usage?.[key]).filter((v) => typeof v === 'number')
    return values.length ? values.reduce((a, b) => a + b, 0) : null
  }
  const runs = (wf.verificationHistory ?? []).flatMap((v) => v.results ?? [])
  const perStage = {}
  for (const s of wf.stages ?? []) perStage[s.role] = (perStage[s.role] ?? 0) + (s.durationMs ?? 0)
  return {
    totalDurationMs: end - Date.parse(wf.createdAt),
    perStageDurationMs: perStage,
    backendCalls: (wf.stages ?? []).length,
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    reasoningTokens: sum('reasoningTokens'),
    tokenNote: 'null = not exposed by that backend (never estimated); DeepSeek native child usage is not exposed',
    verificationPassRate: runs.length ? runs.filter((r) => r.passed).length / runs.length : null,
    reviewRounds: (wf.reviews ?? []).length,
    repairCycles: wf.fixCycles,
    escalations: wf.escalations,
    humanInterventions: wf.humanInterventions,
    paidApiCostUSD: 0,
    subscriptionNotionalListCostUSD: (wf.stages ?? []).reduce((a, s) => a + (s.billing?.notionalListCostUSD ?? 0), 0) || null,
    costNote: 'subscription usage is reported separately: notional list cost is NOT a charge; paid API cost is always 0 (no paid backend exists)',
  }
}

export function renderReport(wf) {
  const m = computeMetrics(wf)
  const lines = [
    `# Workflow ${wf.id}`,
    `- State: **${wf.state}**${wf.blocker ? ` — ${wf.blocker.kind}: ${wf.blocker.message}` : ''}`,
    `- Mode: ${wf.mode}   Created: ${wf.createdAt}${wf.finishedAt ? `   Finished: ${wf.finishedAt}` : ''}`,
    `- Task: ${wf.task}`,
    `- Branch: ${wf.workspace?.branch ?? '-'}  Worktree: ${wf.workspace?.path ?? '-'}  Base: ${wf.workspace?.baseSha ?? '-'}`,
    wf.delivery ? `- Delivery: commit ${wf.delivery.commit} on ${wf.delivery.branch} (not merged, not pushed); files: ${wf.delivery.files.join(', ')}` : '',
    `- Verification status: **${wf.verification?.status ?? 'not run'}**   Review verdict: **${wf.review?.verdict ?? 'n/a'}**   Fix cycles: ${wf.fixCycles}/${wf.config.maxFixCycles}`,
    '',
    '## Stages (actual backend/model per execution)',
    ...wf.stages.map((s) => `- ${s.role} [${s.state}] backend=${s.backend} model=${s.model ?? 'not reported'}${s.modelVerified ? ' (reported by backend)' : ' (unverified)'} ok=${s.ok} ${s.durationMs}ms${s.error ? ` error=${s.error.kind}: ${s.error.message}` : ''}`),
    '',
    '## Transitions',
    ...wf.history.map((h) => `- ${h.at} ${h.from} → ${h.to}: ${h.reason}`),
    '',
    '## Verification runs',
    ...wf.verificationHistory.flatMap((v, i) => [`- run ${i + 1}: ${v.status}`, ...v.results.map((r) => `  - ${r.name}: ${r.passed ? 'pass' : 'FAIL'} exit=${r.exitCode} ${r.durationMs}ms ${r.testSummary ? JSON.stringify(r.testSummary) : ''}`)]),
    '',
    '## Reviews',
    ...wf.reviews.flatMap((r, i) => [`- round ${i + 1}: ${r.verdict} — ${r.summary}`, ...r.findings.map((f) => `  - [${f.severity}] ${f.file ?? '-'}:${f.line ?? '-'} ${f.description}`)]),
    '',
    '## Policy events',
    ...(wf.violations.length ? wf.violations.map((v) => `- ${v.at} ${v.kind}: ${v.detail}`) : ['- none']),
    '',
    '## Metrics',
    '```json',
    JSON.stringify(m, null, 2),
    '```',
  ]
  return redact(lines.filter((l) => l !== null).join('\n'))
}

const STAGE_ICON = { COMPLETED: '✅', BLOCKED: '⛔', FAILED: '❌', CANCELLED: '🚫' }

/** Compact stage timeline, e.g. "PLANNING✓47s → IMPLEMENTING✓22s → …". */
export function progressLine(wf) {
  const done = []
  const seen = new Set()
  for (const h of wf.history ?? []) {
    if (seen.has(h.to)) continue
    seen.add(h.to)
    done.push(h.to)
  }
  const stages = (wf.stages ?? []).map((s) => `${s.role}${s.ok ? '' : '(failed)'}`)
  return `${done.join(' → ')}${stages.length ? `   [${stages.join(', ')}]` : ''}`
}

export function describe(wf) {
  const running = wf.active ? `${wf.active.role} via ${wf.active.backend} (since ${wf.active.startedAt})` : '-'
  const last = wf.stages.at(-1)
  return [
    `${wf.id}  ${wf.state}  mode=${wf.mode}  age=${Math.round(((wf.finishedAt ? Date.parse(wf.finishedAt) : Date.now()) - Date.parse(wf.createdAt)) / 1000)}s`,
    `  task: ${wf.task.slice(0, 100)}`,
    `  timeline: ${progressLine(wf)}`,
    `  active agent: ${running}${last ? `   last stage: ${last.role}/${last.backend}/${last.model ?? 'model n/a'}` : ''}`,
    `  verification: ${wf.verification?.status ?? 'not run'}   review: ${wf.review?.verdict ?? 'n/a'}   retries: ${wf.fixCycles}/${wf.config.maxFixCycles}${wf.escalations ? ` escalations=${wf.escalations}` : ''}`,
    wf.review?.findings?.length ? `  open findings: ${wf.review.findings.map((f) => `[${f.severity}] ${f.description}`.slice(0, 90)).join(' | ')}` : '',
    wf.blocker ? `  BLOCKER (${wf.blocker.kind}): ${wf.blocker.message}` : '',
    wf.blocker?.kind === 'awaiting_approval' ? '  NEXT: approve — click the approval card in the chat or say "approve"; the workflow id is optional' : '',
    wf.state === 'BLOCKED' && wf.blocker?.kind !== 'awaiting_approval' ? '  NEXT: resolve the blocker, then "/orchestrate resume" (id optional)' : '',
    wf.delivery ? `  delivered: branch ${wf.delivery.branch} commit ${wf.delivery.commit?.slice(0, 10)} (not merged/pushed)\n  worktree: ${wf.delivery.worktree}` : '',
  ].filter(Boolean).join('\n')
}
