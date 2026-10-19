import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Engine } from '../src/orchestrator/engine.js'
import { WorkflowStore } from '../src/orchestrator/persistence.js'
import { Git, createWorktree, snapshotRepo } from '../src/workspace/worktree.js'
import { resolveConfig } from '../src/config.js'
import { ARTIFACT_FILES } from '../src/agents/architect.js'
import { runVerification } from '../src/verification/runner.js'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
async function makeRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-repo-'))
  git(dir, 'init', '-q', '-b', 'main')
  await fs.writeFile(path.join(dir, 'README.md'), '# demo\n')
  git(dir, 'add', '-A'); git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
  return dir
}
const doc = (n) => `# ${n}\n## Scope\nlong enough content to satisfy minimum length validation for the architect artifacts.\n## Non-goals\nn\n## Decisions module\nx\n## Failure modes risks\nx\n## Security\nx\n## Task order dependencies\n- task\n## Test requirements\ninterface API\n## Acceptance criteria\n1. a\n2. b\n3. c\n`
const archText = () => ARTIFACT_FILES.map((n) => `=====FILE: ${n}=====\n${doc(n)}\n=====END FILE=====`).join('\n')
const review = (verdict, findings = []) => JSON.stringify({ verdict, summary: `sum ${verdict}`, findings })
const finding = (d = 'bug') => ({ severity: 'medium', category: 'correctness', file: 'lib.js', line: 1, description: d, suggested_fix: 'fix' })

/** Build an engine with scripted backends. */
async function setup({ arch, impl, rev, config = {}, verify = ['node check.js'] } = {}) {
  const repo = await makeRepo()
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-data-'))
  const cfg = resolveConfig({ ...config, orchestrator: { dataDir, maxFixCycles: 3, ...config.orchestrator }, verification: { commands: verify, ...(config.verification ?? {}) } })
  const calls = { arch: [], impl: [], rev: [] }
  const ok = (backend, text, extra = {}) => ({ ok: true, backend, text, model: `${backend}-model`, modelVerified: true, durationMs: 1, usage: { inputTokens: 1, outputTokens: 1 }, ...extra })
  const backends = {
    architect: { execute: async (req, opt) => { calls.arch.push(req); return arch ? arch(req, opt, calls.arch.length) : ok('claude-cli', archText()) } },
    implementer: { execute: async (req, opt) => { calls.impl.push(req); return impl(req, opt, calls.impl.length) } },
    reviewer: { execute: async (req, opt) => { calls.rev.push(req); return rev ? rev(req, opt, calls.rev.length) : ok('codex-cli', review('APPROVE')) } },
  }
  const store = new WorkflowStore(dataDir)
  const engine = new Engine({ config: cfg, store, backends, git: new Git() })
  const run = async (opts = {}) => {
    const wf = await engine.start({ task: 'build x', repo, parent: { id: 'parent' }, ...opts })
    await engine.live.get(wf.id)?.promise
    return store.load(wf.id)
  }
  return { repo, dataDir, engine, store, calls, run, ok, cfg }
}
const good = async (req) => { await fs.writeFile(path.join(req.cwd, 'check.js'), 'process.exit(0)'); await fs.writeFile(path.join(req.cwd, 'lib.js'), 'module.exports = 1'); return { ok: true, backend: 'dsh-native', text: 'done', model: 'deepseek-flash', durationMs: 1 } }

test('happy path: all stages run, branch committed, original repo untouched', async () => {
  const s = await setup({ impl: good, config: { orchestrator: { removeWorktreeOnSuccess: false } } })
  const before = await snapshotRepo(new Git(), s.repo)
  const wf = await s.run()
  assert.equal(wf.state, 'COMPLETED', JSON.stringify(wf.blocker))
  assert.deepEqual(wf.stages.map((x) => x.backend), ['claude-cli', 'dsh-native', 'codex-cli'])
  assert.equal(wf.verification.status, 'passed'); assert.equal(wf.review.verdict, 'APPROVE')
  assert.equal(wf.delivery.merged, false); assert.equal(wf.delivery.pushed, false)
  assert.deepEqual(wf.delivery.files.sort(), ['check.js', 'lib.js'])
  assert.match(git(wf.workspace.path, 'log', '--oneline', '-1'), /orchestrate/)
  assert.deepEqual(await snapshotRepo(new Git(), s.repo), before)
  assert.equal(git(s.repo, 'branch', '--list', wf.workspace.branch).includes('orchestrate/'), true)
  assert.deepEqual(wf.history.map((h) => h.to), ['PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'COMPLETED'])
  const spec = await fs.readFile(path.join(wf.workspace.path, '.orchestrator', 'architecture.md'), 'utf8'); assert.match(spec, /Scope/)
  assert.match(await fs.readFile(path.join(s.store.dir(wf.id), 'report.md'), 'utf8'), /backend=dsh-native/)
})

test('a completed run removes its worktree but keeps the delivered branch', async () => {
  const s = await setup({ impl: good }) // default: removeWorktreeOnSuccess = true
  const wf = await s.run()
  assert.equal(wf.state, 'COMPLETED')
  assert.equal(wf.delivery.worktreeRemoved, true)
  assert.equal(await fs.access(wf.workspace.path).then(() => true, () => false), false, 'worktree must be gone')
  // The branch and its commit still exist in the repository.
  const show = execFileSync('git', ['-C', s.repo, 'show', '--stat', '--oneline', wf.delivery.commit], { encoding: 'utf8' })
  assert.match(show, /orchestrate:/)
  assert.match(execFileSync('git', ['-C', s.repo, 'branch', '--list', wf.delivery.branch], { encoding: 'utf8' }), /orchestrate\//)
})

test('verification failure → repair → pass; reviewer sees diff', async () => {
  const s = await setup({ impl: async (req, o, n) => { await fs.writeFile(path.join(req.cwd, 'check.js'), n === 1 ? 'console.log("broken");process.exit(1)' : 'process.exit(0)'); return { ok: true, backend: 'dsh-native', text: 'r' } } })
  const wf = await s.run()
  assert.equal(wf.state, 'COMPLETED'); assert.equal(wf.fixCycles, 1)
  assert.deepEqual(wf.history.map((h) => h.to), ['PLANNING', 'IMPLEMENTING', 'VERIFYING', 'FIXING', 'VERIFYING', 'REVIEWING', 'COMPLETED'])
  assert.match(s.calls.impl[1].prompt, /verification FAILED|Deterministic verification FAILED/)
  assert.match(s.calls.rev[0].prompt, /GIT DIFF/)
  assert.equal(wf.verificationHistory.length, 2)
})

test('repair loop is bounded (varying failures → repair_exhausted)', async () => {
  const s = await setup({ config: { orchestrator: { maxFixCycles: 2 } }, impl: async (req, o, n) => { await fs.writeFile(path.join(req.cwd, 'check.js'), `console.log("fail ${n}");process.exit(1)`); return { ok: true, backend: 'dsh-native', text: '' } } })
  const wf = await s.run()
  assert.equal(wf.state, 'BLOCKED'); assert.equal(wf.blocker.kind, 'repair_exhausted'); assert.equal(wf.fixCycles, 2)
  assert.equal(s.calls.impl.length, 3); assert.equal(s.calls.rev.length, 0)
  assert.notEqual(wf.verification.status, 'passed')
})

test('identical repeated failure escalates to Architect once, then blocks (no infinite loop)', async () => {
  const s = await setup({ impl: async (req) => { await fs.writeFile(path.join(req.cwd, 'check.js'), 'console.log("same");process.exit(1)'); return { ok: true, backend: 'dsh-native', text: '' } } })
  const wf = await s.run()
  assert.equal(wf.state, 'BLOCKED'); assert.equal(wf.escalations, 1); assert.equal(s.calls.arch.length, 2)
  assert.ok(s.calls.impl.length <= 6)
  assert.match(s.calls.arch[1].prompt, /PREVIOUS DESIGN/)
})

test('reviewer REQUEST_CHANGES drives a fix cycle, then APPROVE', async () => {
  const s = await setup({ impl: good, rev: (r, o, n) => ({ ok: true, backend: 'codex-cli', text: n === 1 ? review('REQUEST_CHANGES', [finding('off by one')]) : review('APPROVE') }) })
  const wf = await s.run()
  assert.equal(wf.state, 'COMPLETED'); assert.equal(wf.reviews.length, 2); assert.equal(wf.fixCycles, 1)
  assert.match(s.calls.impl[1].prompt, /off by one/)
  assert.equal(s.calls.impl.length, 2)
})

test('a rate-limited reviewer falls back to the Claude CLI and records it', async () => {
  const reviewJson = JSON.stringify({ verdict: 'APPROVE', summary: 'reviewed via claude fallback', findings: [] })
  const s = await setup({
    impl: good,
    rev: () => ({ ok: false, backend: 'codex-cli', error: { kind: 'rate_limit', message: 'usage limit' }, durationMs: 1 }),
    arch: async (req) => {
      if (/INDEPENDENT CODE REVIEWER/.test(req.prompt)) return { ok: true, backend: 'claude-cli', text: reviewJson, model: 'claude-opus-5-5', modelVerified: true, durationMs: 1 }
      return { ok: true, backend: 'claude-cli', text: archText(), model: 'claude-sonnet-5-5', modelVerified: true, durationMs: 1 }
    },
  })
  const wf = await s.run()
  assert.equal(wf.state, 'COMPLETED', JSON.stringify(wf.blocker))
  assert.equal(wf.review.verdict, 'APPROVE')
  assert.equal(wf.reviews[0].backend, 'claude-cli')
  assert.equal(wf.fallbacks.length, 1)
  assert.equal(wf.fallbacks[0].from, 'codex-cli')
  assert.equal(wf.fallbacks[0].to, 'claude-cli')
  assert.equal(wf.fallbacks[0].reason, 'rate_limit')
  assert.ok(wf.stages.some((stage) => stage.role === 'reviewer' && !stage.ok && stage.error.kind === 'rate_limit'))
  assert.ok(wf.stages.some((stage) => stage.role === 'reviewer:fallback' && stage.ok && stage.backend === 'claude-cli'))
  const report = await fs.readFile(path.join(s.store.dir(wf.id), 'report.md'), 'utf8')
  assert.match(report, /Reviewer fallbacks/)
  assert.match(report, /- \d{4}-\d\d-\d\dT[^ ]+ reviewer: codex-cli → claude-cli \(rate_limit/)
})

test('the reviewer falls back at most once per workflow', async () => {
  let reviewRound = 0
  const finding = [{ severity: 'medium', category: 'correctness', file: 'a.js', line: 1, description: 'x', suggested_fix: 'y' }]
  const s = await setup({
    impl: good,
    rev: () => ({ ok: false, backend: 'codex-cli', error: { kind: 'rate_limit', message: 'usage limit' }, durationMs: 1 }),
    arch: async (req) => {
      if (!/INDEPENDENT CODE REVIEWER/.test(req.prompt)) return { ok: true, backend: 'claude-cli', text: archText(), model: 'claude-sonnet-5-5', durationMs: 1 }
      reviewRound += 1
      return { ok: true, backend: 'claude-cli', text: JSON.stringify({ verdict: 'REQUEST_CHANGES', summary: 'again', findings: finding }), model: 'claude-opus-5-5', durationMs: 1 }
    },
  })
  const wf = await s.run()
  assert.equal(reviewRound, 1, 'only the first review may use the Claude fallback')
  assert.equal(wf.state, 'BLOCKED')
  assert.equal(wf.blocker.kind, 'rate_limit')
  assert.equal(wf.fallbacks.length, 1)
})

test('a parse retry after a fallback stays on the fallback backend', async () => {
  let claudeReviewCalls = 0
  const s = await setup({
    impl: good,
    rev: () => ({ ok: false, backend: 'codex-cli', error: { kind: 'rate_limit', message: 'usage limit' }, durationMs: 1 }),
    arch: async (req) => {
      if (!/INDEPENDENT CODE REVIEWER/.test(req.prompt)) return { ok: true, backend: 'claude-cli', text: archText(), model: 'claude-sonnet-5-5', durationMs: 1 }
      claudeReviewCalls += 1
      const text = claudeReviewCalls === 1 ? 'not json at all' : JSON.stringify({ verdict: 'APPROVE', summary: 'ok', findings: [] })
      return { ok: true, backend: 'claude-cli', text, model: 'claude-opus-5-5', durationMs: 1 }
    },
  })
  const wf = await s.run()
  assert.equal(wf.state, 'COMPLETED', JSON.stringify(wf.blocker))
  assert.equal(claudeReviewCalls, 2, 'the retry must not go back to the rate-limited Codex')
  assert.equal(wf.fallbacks.length, 1)
  assert.equal(wf.reviews[0].backend, 'claude-cli')
})

test('with the fallback disabled a rate-limited reviewer still blocks', async () => {
  const s = await setup({
    impl: good,
    rev: () => ({ ok: false, backend: 'codex-cli', error: { kind: 'rate_limit', message: 'usage limit' }, durationMs: 1 }),
    config: { roles: { reviewer: { fallbackBackend: 'none' } } },
  })
  const wf = await s.run()
  assert.equal(wf.state, 'BLOCKED')
  assert.equal(wf.blocker.kind, 'rate_limit')
  assert.equal(wf.fallbacks, undefined)
})

test('malformed reviewer output never approves', async () => {
  const s = await setup({ impl: good, rev: () => ({ ok: true, backend: 'codex-cli', text: 'LGTM!' }) })
  const wf = await s.run()
  assert.equal(wf.state, 'BLOCKED'); assert.equal(wf.blocker.kind, 'invalid_review'); assert.equal(wf.review, null)
})

test('provider auth failure blocks (no fallback) and workflow resumes from the blocked stage', async () => {
  let up = false
  const s = await setup({ impl: good, arch: (r, o, n) => (up ? { ok: true, backend: 'claude-cli', text: archText(), model: 'claude-opus-5-5' } : { ok: false, backend: 'claude-cli', error: { kind: 'rate_limit', message: 'usage limit' }, durationMs: 1 }) })
  let wf = await s.run()
  assert.equal(wf.state, 'BLOCKED'); assert.equal(wf.blocker.kind, 'rate_limit'); assert.equal(s.calls.impl.length, 0)
  assert.match(wf.blocker.message, /No silent backend switch|resume/)
  up = true
  await s.engine.resume(wf.id, { id: 'p' }); await s.engine.live.get(wf.id)?.promise
  wf = await s.store.load(wf.id)
  assert.equal(wf.state, 'COMPLETED'); assert.equal(wf.humanInterventions, 1)
})

test('generic backend failure retried once then blocked', async () => {
  const s = await setup({ impl: good, rev: () => ({ ok: false, backend: 'codex-cli', error: { kind: 'failed', message: 'boom' }, durationMs: 1 }) })
  const wf = await s.run()
  assert.equal(wf.state, 'BLOCKED'); assert.equal(wf.blocker.kind, 'backend_failed'); assert.equal(s.calls.rev.length, 2)
})

test('cancellation terminates the run', async () => {
  let started
  const gate = new Promise((r) => (started = r))
  const s = await setup({ impl: async (req, o) => { started(); await new Promise((r) => o.signal.addEventListener('abort', r)); return { ok: false, backend: 'dsh-native', error: { kind: 'cancelled', message: 'c' } } } })
  const wf = await s.engine.start({ task: 't', repo: s.repo, parent: {} })
  await gate
  const done = await s.engine.cancel(wf.id)
  assert.equal(done.state, 'CANCELLED'); assert.equal(s.engine.isLive(wf.id), false)
})

test('implementer claiming completion without file changes is rejected', async () => {
  const s = await setup({ config: { orchestrator: { maxFixCycles: 1 } }, impl: async () => ({ ok: true, backend: 'dsh-native', text: 'All done! implemented everything.' }) })
  const wf = await s.run()
  assert.equal(wf.state, 'BLOCKED'); assert.equal(wf.verification, null)
  assert.ok(wf.attempts.every((a) => a.changedFiles === 0))
})

test('implementer cannot rewrite acceptance criteria (restored + recorded)', async () => {
  const s = await setup({ impl: async (req) => { await fs.writeFile(path.join(req.cwd, '.orchestrator', 'acceptance-criteria.md'), '1. everything passes trivially'); return good(req) }, config: { orchestrator: { removeWorktreeOnSuccess: false } } })
  const wf = await s.run()
  assert.equal(wf.state, 'COMPLETED')
  assert.ok(wf.violations.some((v) => v.kind === 'artifact_tampering'))
  assert.match(await fs.readFile(path.join(wf.workspace.path, '.orchestrator', 'acceptance-criteria.md'), 'utf8'), /Acceptance criteria/)
  assert.ok(!wf.delivery.files.some((f) => f.startsWith('.orchestrator')))
})

test('security.allowedPaths blocks changes outside the permitted prefixes', async () => {
  const s = await setup({ config: { security: { allowedPaths: ['src'] } }, impl: async (req) => {
    await fs.mkdir(path.join(req.cwd, 'src'), { recursive: true })
    await fs.writeFile(path.join(req.cwd, 'src', 'a.js'), 'export const a = 1')
    await fs.writeFile(path.join(req.cwd, 'check.js'), 'process.exit(0)')
    return { ok: true, backend: 'dsh-native', text: 'done' }
  } })
  const wf = await s.run()
  assert.equal(wf.state, 'BLOCKED'); assert.equal(wf.blocker.kind, 'path_violation')
  assert.match(wf.blocker.message, /check\.js/)
  assert.equal(wf.review, null); assert.equal(wf.delivery, undefined)
  const ok = await setup({ config: { security: { allowedPaths: ['src', 'check.js'] } }, impl: async (req) => {
    await fs.mkdir(path.join(req.cwd, 'src'), { recursive: true })
    await fs.writeFile(path.join(req.cwd, 'src', 'a.js'), 'export const a = 1')
    await fs.writeFile(path.join(req.cwd, 'check.js'), 'process.exit(0)')
    return { ok: true, backend: 'dsh-native', text: 'done' }
  } })
  assert.equal((await ok.run()).state, 'COMPLETED')
})

test('staging works when .orchestrator is ignored, and the delivered diff excludes it', async () => {
  const s = await setup({ impl: good })
  const wf = await s.engine.start({ task: 't', repo: s.repo, parent: {} })
  // simulate the implementer having made the repo ignore the scaffolding
  await new Promise((r) => setTimeout(r, 150))
  assert.ok(s.engine.isLive(wf.id))
  await s.engine.cancel(wf.id)
  const repo2 = await makeRepo()
  await fs.writeFile(path.join(repo2, '.gitignore'), '.orchestrator\n')
  git(repo2, 'add', '-A'); git(repo2, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'ignore')
  const dataDir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-ign-'))
  const { createWorktree, collectChanges, commitTask } = await import('../src/workspace/worktree.js')
  const ws = await createWorktree({ git: new Git(), repo: repo2, workflowId: 'wf-ign-1', dataDir: dataDir2 })
  await fs.mkdir(path.join(ws.path, '.orchestrator'), { recursive: true })
  await fs.writeFile(path.join(ws.path, '.orchestrator', 'architecture.md'), 'spec')
  await fs.writeFile(path.join(ws.path, 'a.js'), 'export const a = 1')
  const changes = await collectChanges(new Git(), ws.path, ws.baseSha)
  assert.deepEqual(changes.files, ['a.js'])
  assert.doesNotMatch(changes.diff, /architecture\.md/)
  const commit = await commitTask(new Git(), ws.path, 'test commit')
  assert.equal(commit.committed, true)
  assert.deepEqual(git(ws.path, 'show', '--name-only', '--pretty=format:', 'HEAD').trim().split('\n'), ['a.js'])
})

test('implementer writing into the shared .git directory is detected, reverted, and blocked', async () => {
  const s = await setup({ impl: async (req) => {
    const exclude = path.join(s.repo, '.git', 'info', 'exclude')
    await fs.appendFile(exclude, '/.orchestrator/\n')
    return good(req)
  } })
  const before = await fs.readFile(path.join(s.repo, '.git', 'info', 'exclude'), 'utf8')
  const wf = await s.run()
  assert.equal(wf.state, 'BLOCKED'); assert.equal(wf.blocker.kind, 'isolation_violation')
  assert.ok(wf.violations.some((v) => v.kind === 'repo_metadata_modified'))
  assert.equal(await fs.readFile(path.join(s.repo, '.git', 'info', 'exclude'), 'utf8'), before, 'info/exclude must be restored')
})

test('an orchestrator-internal fault blocks resumably instead of dead-ending in FAILED', async () => {
  let boom = true
  const s = await setup({ impl: async (req) => {
    if (boom) { boom = false; throw new Error('simulated internal fault') }
    return good(req)
  } })
  let wf = await s.run()
  assert.equal(wf.state, 'BLOCKED'); assert.equal(wf.blocker.kind, 'internal'); assert.equal(wf.blockedFrom, 'IMPLEMENTING')
  await s.engine.resume(wf.id, {}); await s.engine.live.get(wf.id)?.promise
  wf = await s.store.load(wf.id)
  assert.equal(wf.state, 'COMPLETED')
})

test('writes to the original repository fail closed', async () => {
  const s = await setup({ impl: async (req) => { await fs.writeFile(path.join(s_repo(), 'evil.txt'), 'x'); return good(req) } })
  function s_repo() { return s.repo }
  const wf = await s.run()
  assert.equal(wf.state, 'BLOCKED', JSON.stringify(wf.blocker))
  assert.equal(wf.blocker.kind, 'isolation_violation', JSON.stringify(wf.blocker))
})

test('reviewer that mutates the worktree is detected', async () => {
  let wtp
  const s = await setup({ impl: async (req) => { wtp = req.cwd; return good(req) }, rev: async () => { await fs.writeFile(path.join(wtp, 'lib.js'), 'module.exports = 2'); return { ok: true, backend: 'codex-cli', text: review('APPROVE') } } })
  const wf = await s.run()
  assert.equal(wf.state, 'BLOCKED'); assert.ok(wf.violations.some((v) => v.kind === 'reviewer_modified_tree'))
})

test('fail closed without verification commands; verification required before review', async () => {
  const s = await setup({ impl: good, verify: [] })
  const wf = await s.run()
  assert.equal(wf.state, 'BLOCKED'); assert.equal(wf.blocker.kind, 'no_verification'); assert.equal(s.calls.rev.length, 0)
})

test('a no_verification block is fixed by resuming with explicit commands', async () => {
  const s = await setup({ impl: good, verify: [] })
  let wf = await s.run()
  assert.equal(wf.state, 'BLOCKED'); assert.equal(wf.blocker.kind, 'no_verification')
  assert.match(wf.blocker.message, /--verify/)
  await assert.rejects(s.engine.resume(wf.id, {}, { verify: ['rm -rf /'] }), /never permitted/)
  await s.engine.resume(wf.id, {}, { verify: ['node check.js'] })
  await s.engine.live.get(wf.id)?.promise
  wf = await s.store.load(wf.id)
  assert.equal(wf.state, 'COMPLETED', JSON.stringify(wf.blocker))
  assert.deepEqual(wf.verifySpecs, ['node check.js'])
})

test('a non-git target is rejected up front with an actionable message', async () => {
  const s = await setup({ impl: good })
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-plain2-'))
  await assert.rejects(s.engine.start({ task: 't', repo: plain, parent: {} }), /not a git repository[\s\S]*repo=\"/)
})

test('disallowed verification command rejected at start', async () => {
  const s = await setup({ impl: good })
  await assert.rejects(s.engine.start({ task: 't', repo: s.repo, parent: {}, verify: ['rm -rf /'] }), /never permitted/)
})

test('fast mode skips architect and review; thorough adds critique and human approval', async () => {
  let s = await setup({ impl: good })
  let wf = await s.run({ mode: 'fast' })
  assert.equal(wf.state, 'COMPLETED'); assert.equal(s.calls.arch.length, 0); assert.equal(s.calls.rev.length, 0); assert.equal(wf.review, null)
  s = await setup({ impl: good })
  wf = await s.run({ mode: 'thorough' })
  assert.equal(wf.state, 'BLOCKED'); assert.equal(wf.blocker.kind, 'awaiting_approval'); assert.equal(s.calls.arch.length, 2)
  assert.equal(wf.delivery, undefined)
  await s.engine.approve(wf.id, {}); await s.engine.live.get(wf.id)?.promise
  wf = await s.store.load(wf.id)
  assert.equal(wf.state, 'COMPLETED'); assert.equal(s.calls.rev.length, 1)
})

test('thorough mode reviews the architecture with the configured critique model', async () => {
  const models = []
  const s = await setup({
    impl: good,
    config: { roles: { architect: { model: 'sonnet', critiqueModel: 'opus' } } },
    arch: async (req, opt) => {
      models.push(`${opt.model} :: ${req.prompt.slice(0, 40).replace(/\n/g, ' ')}`)
      // Report a model id different from the requested alias, so a stage that
      // merely echoed the request cannot pass this test.
      return { ok: true, backend: 'claude-cli', text: archText(), model: opt.model === 'opus' ? 'claude-opus-5-5' : 'claude-sonnet-5-5', modelVerified: true, durationMs: 1 }
    },
  })
  const wf = await s.run({ mode: 'thorough' })
  assert.equal(wf.state, 'BLOCKED') // thorough waits for human approval
  assert.equal(wf.blocker.kind, 'awaiting_approval')
  assert.deepEqual(models.map((m) => m.split(' :: ')[0]), ['sonnet', 'opus'])
  const architectStages = wf.stages.filter((stage) => String(stage.role).startsWith('architect'))
  assert.deepEqual(architectStages.map((stage) => [stage.role, stage.model]), [['architect:design', 'claude-sonnet-5-5'], ['architect:critique', 'claude-opus-5-5']])
  // The report-model is what the CLI reported, not what we asked for.
  // The stage records only what the backend reported; the requested alias is not invented.
  assert.deepEqual(architectStages.map((stage) => stage.requestedModel), [null, null])
})

test('one workflow at a time (maxParallelWorkers=1)', async () => {
  let release
  let releaseSignal
  const reached = new Promise((r) => { releaseSignal = r })
  const s = await setup({ impl: async (req) => { releaseSignal(); await new Promise((r) => (release = r)); return good(req) } })
  const wf = await s.engine.start({ task: 'a', repo: s.repo, parent: {} })
  await reached
  await assert.rejects(s.engine.start({ task: 'b', repo: s.repo, parent: {} }), /already running/)
  release(); await s.engine.live.get(wf.id)?.promise
})

test('crash recovery: interrupted workflows become BLOCKED and resume without replaying completed stages', async () => {
  const s = await setup({ impl: good })
  const wf = await s.run()
  assert.equal(wf.state, 'COMPLETED')
  // simulate a crash during IMPLEMENTING with architecture already done
  const crashed = { ...JSON.parse(JSON.stringify(wf)), id: 'wf-crash-1', state: 'IMPLEMENTING', finishedAt: undefined, delivery: undefined, verification: null, review: null, reviews: [], verificationHistory: [], blocker: null }
  crashed.stages = crashed.stages.slice(0, 1)
  await s.store.save(crashed)
  const ids = await s.store.recoverInterrupted({ isLive: () => false })
  assert.deepEqual(ids, ['wf-crash-1'])
  let r = await s.store.load('wf-crash-1')
  assert.equal(r.state, 'BLOCKED'); assert.equal(r.blockedFrom, 'IMPLEMENTING'); assert.match(r.blocker.message, /resume wf-crash-1/)
  const archCalls = s.calls.arch.length
  await s.engine.resume('wf-crash-1', {}); await s.engine.live.get('wf-crash-1')?.promise
  r = await s.store.load('wf-crash-1')
  assert.equal(s.calls.arch.length, archCalls, 'architect stage must not be replayed')
  assert.ok(['COMPLETED', 'BLOCKED'].includes(r.state))
})

test('recovery reconciles a surviving child process before marking BLOCKED', async () => {
  const s = await setup({ impl: good })
  const wf = await s.run()
  const crashed = { ...JSON.parse(JSON.stringify(wf)), id: 'wf-crash-2', state: 'REVIEWING', finishedAt: undefined, delivery: undefined, blocker: null }
  crashed.active = { role: 'reviewer', backend: 'codex-cli', startedAt: new Date().toISOString(), pid: process.pid, executable: 'codex' }
  await s.store.save(crashed)
  const seen = []
  const ids = await s.store.recoverInterrupted({ isLive: () => false, reconcile: (x) => { seen.push(x.id); return 'reconciled (test)' } })
  assert.deepEqual(ids, ['wf-crash-2']); assert.deepEqual(seen, ['wf-crash-2'])
  assert.match((await s.store.load('wf-crash-2')).blocker.message, /reconciled \(test\)/)
})

test('persisted state contains no credentials', async () => {
  const s = await setup({ impl: async (req) => { await good(req); return { ok: true, backend: 'dsh-native', text: 'key sk-ant-abcdefghijklmnopqrstuvwxyz done' } } })
  const wf = await s.run()
  assert.doesNotMatch(await fs.readFile(path.join(s.store.dir(wf.id), 'state.json'), 'utf8'), /sk-ant-abcdef/)
})

test('worktree creation: non-git directory refused, dirty tree preserved', async () => {
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-plain-'))
  await assert.rejects(createWorktree({ git: new Git(), repo: plain, workflowId: 'wf-x1', dataDir: plain }), /not inside a Git repository/)
  const repo = await makeRepo()
  await fs.writeFile(path.join(repo, 'dirty.txt'), 'wip')
  const ws = await createWorktree({ git: new Git(), repo, workflowId: 'wf-x2', dataDir: await fs.mkdtemp(path.join(os.tmpdir(), 'orch-d-')) })
  assert.ok(ws.warnings[0].includes('uncommitted')); assert.equal(await fs.readFile(path.join(repo, 'dirty.txt'), 'utf8'), 'wip')
  await assert.rejects(fs.access(path.join(ws.path, 'dirty.txt')))
})

test('verification runner records evidence and times out', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-v-'))
  const policy = resolveConfig({}).verification
  await fs.writeFile(path.join(dir, 't.js'), 'console.log("# pass 3\\n# fail 1");process.exit(1)')
  const r = await runVerification({ cwd: dir, specs: ['node t.js'], policy })
  assert.equal(r.status, 'failed'); assert.equal(r.results[0].exitCode, 1); assert.deepEqual(r.results[0].testSummary, { pass: 3, fail: 1 })
  assert.equal((await runVerification({ cwd: dir, specs: [], policy })).status, 'not_configured')
  await fs.writeFile(path.join(dir, 's.js'), 'setTimeout(()=>{},60000)')
  const t = await runVerification({ cwd: dir, specs: [{ command: 'node', args: ['s.js'], timeoutMs: 300 }], policy })
  assert.equal(t.results[0].timedOut, true); assert.equal(t.status, 'failed')
})

// ---------------------------------------------------------------- review mode

test('review mode: both reviewers read the repo, nothing is written, findings merged', async () => {
  const finding = (file, line, severity) => ({ severity, category: 'correctness', file, line, description: `${file} bug`, suggested_fix: 'fix it' })
  const s = await setup({
    impl: async () => { throw new Error('the implementer must not run in review mode') },
    arch: async (req, opt) => {
      assert.match(req.prompt, /read-only review of an existing codebase/)
      assert.equal(opt.permissionMode, 'plan')
      return { ok: true, backend: 'claude-cli', model: 'claude-opus-5-5', durationMs: 1, text: JSON.stringify({ verdict: 'REQUEST_CHANGES', summary: 'claude', findings: [finding('a.js', 3, 'medium'), finding('b.js', 9, 'low')] }) }
    },
    rev: async () => ({ ok: true, backend: 'codex-cli', model: 'gpt-6-astra', durationMs: 1, text: JSON.stringify({ verdict: 'REQUEST_CHANGES', summary: 'codex', findings: [finding('a.js', 3, 'high')] }) }),
  })
  const before = git(s.repo, 'status', '--porcelain')
  const wf = await s.run({ mode: 'review' })
  assert.equal(wf.state, 'COMPLETED', JSON.stringify(wf.blocker))
  assert.equal(wf.workspace, undefined, 'no worktree is created')
  assert.equal(git(s.repo, 'status', '--porcelain'), before)
  assert.equal(wf.review.verdict, 'REQUEST_CHANGES')
  assert.equal(wf.review.findings.length, 2, 'a.js:3 reported by both is merged')
  assert.equal(wf.review.findings[0].file, 'a.js')
  assert.equal(wf.review.findings[0].severity, 'high', JSON.stringify({ review: wf.review, outcomes: wf.reviewOutcomes }))
  assert.deepEqual([...wf.review.findings[0].reviewers].sort(), ['claude-cli', 'codex-cli'])
  assert.equal(wf.reviews.length, 2)
})

test('review mode: one reviewer rate-limited still completes with the other', async () => {
  const s = await setup({
    arch: async () => ({ ok: true, backend: 'claude-cli', model: 'claude-opus-5-5', durationMs: 1, text: JSON.stringify({ verdict: 'APPROVE', summary: 'fine', findings: [] }) }),
    rev: async () => ({ ok: false, backend: 'codex-cli', durationMs: 1, error: { kind: 'rate_limit', message: 'usage limit' } }),
  })
  const wf = await s.run({ mode: 'review' })
  assert.equal(wf.state, 'COMPLETED')
  assert.deepEqual(wf.reviewOutcomes.map((o) => [o.backend, o.ok]), [['claude-cli', true], ['codex-cli', false]])
})

test('review mode works on a directory that is not a git repository', async () => {
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-plain-review-'))
  await fs.writeFile(path.join(plain, 'x.js'), 'export const x = 1\n')
  const s = await setup({
    arch: async () => ({ ok: true, backend: 'claude-cli', durationMs: 1, text: JSON.stringify({ verdict: 'APPROVE', summary: 'ok', findings: [] }) }),
    rev: async () => ({ ok: true, backend: 'codex-cli', durationMs: 1, text: JSON.stringify({ verdict: 'APPROVE', summary: 'ok', findings: [] }) }),
  })
  const wf = await s.engine.start({ task: '审查 x.js', repo: plain, parent: {}, mode: 'review' })
  await s.engine.live.get(wf.id)?.promise
  const done = await s.store.load(wf.id)
  assert.equal(done.state, 'COMPLETED', JSON.stringify(done.blocker))
})

test('no verify list: commands are inferred from package.json instead of blocking', async () => {
  const s = await setup({
    verify: [],
    impl: async (req) => {
      await good(req)
      await fs.writeFile(path.join(req.cwd, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node check.js' } }))
      return { ok: true, backend: 'dsh-native', text: 'done', model: 'deepseek-flash', durationMs: 1 }
    },
  })
  const wf = await s.run()
  assert.equal(wf.state, 'COMPLETED', JSON.stringify(wf.blocker))
  assert.equal(wf.verification.status, 'passed')
  assert.ok(wf.verification.results.some((r) => /npm (run )?test/.test(r.name)), JSON.stringify(wf.verification.results.map((r) => r.name)))
})

test('only a genuine "not a git repository" gets the typed NOT_GIT_REPO error', async () => {
  const s = await setup({ impl: good })
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-typed-'))
  await assert.rejects(s.engine.start({ task: 't', repo: plain, parent: {} }), (error) => error.code === 'NOT_GIT_REPO')
  const broken = { exec: async () => ({ exitCode: 128, stdout: '', stderr: "fatal: detected dubious ownership in repository" }) }
  const engine2 = new (s.engine.constructor)({ config: s.cfg, store: s.store, backends: {}, git: broken })
  await assert.rejects(engine2.start({ task: 't', repo: plain, parent: {} }), (error) => error.code !== 'NOT_GIT_REPO' && /dubious ownership/.test(error.message))
})

test('read-only review ignores --verify and detects writes in a non-git directory', async () => {
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-nongit-write-'))
  await fs.writeFile(path.join(plain, 'x.js'), 'export const x = 1\n')
  const s = await setup({
    arch: async () => {
      await fs.writeFile(path.join(plain, 'x.js'), 'tampered\n') // a reviewer that writes
      return { ok: true, backend: 'claude-cli', durationMs: 1, text: JSON.stringify({ verdict: 'APPROVE', summary: 'ok', findings: [] }) }
    },
    rev: async () => ({ ok: true, backend: 'codex-cli', durationMs: 1, text: JSON.stringify({ verdict: 'APPROVE', summary: 'ok', findings: [] }) }),
  })
  // A disallowed verify value must not break a review (review runs no verification).
  const wf = await s.engine.start({ task: '审查', repo: plain, parent: {}, mode: 'review', verify: ['npx something'] })
  await s.engine.live.get(wf.id)?.promise
  const done = await s.store.load(wf.id)
  assert.equal(done.state, 'BLOCKED')
  assert.equal(done.blocker.kind, 'isolation_violation')
})
