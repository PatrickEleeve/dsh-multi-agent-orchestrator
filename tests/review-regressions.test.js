/**
 * Regressions for the independent code review of v1.3.3: every test here maps to
 * a finding that was reproduced against the old code.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Engine } from '../src/orchestrator/engine.js'
import { WorkflowStore } from '../src/orchestrator/persistence.js'
import { Git, createWorktree, stageChanges, commitTask, snapshotRepo } from '../src/workspace/worktree.js'
import { resolveConfig } from '../src/config.js'
import { runProcess } from '../src/process.js'
import { ARTIFACT_FILES } from '../src/agents/architect.js'

const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
async function repo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-reg-'))
  g(dir, 'init', '-q', '-b', 'main')
  await fs.writeFile(path.join(dir, 'README.md'), '# r\n')
  g(dir, 'add', '-A')
  g(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  return dir
}
const doc = (n) => `# ${n}\n## Scope\nlong enough content to satisfy the minimum validation rules for artifacts.\n## Non-goals\nn\n## Decisions module\nx\n## Failure modes risks\nx\n## Security\nx\n## Task order dependencies\n- t\n## Test requirements\ninterface API\n## Acceptance criteria\n1. a\n2. b\n3. c\n`
const docs = () => ARTIFACT_FILES.map((n) => `=====FILE: ${n}=====\n${doc(n)}\n=====END FILE=====`).join('\n')
const ok = (backend, text) => ({ ok: true, backend, text, model: `${backend}-model`, durationMs: 1 })
const good = async (req) => {
  await fs.writeFile(path.join(req.cwd, 'check.js'), 'process.exit(0)')
  await fs.writeFile(path.join(req.cwd, 'lib.js'), 'module.exports = 1')
  return ok('dsh-native', 'done')
}

function makeEngine({ impl = good, mode = 'balanced', repoDir, verify = ['node check.js'] } = {}) {
  const dataDir = path.join(os.tmpdir(), `orch-reg-data-${Math.random().toString(16).slice(2)}`)
  const config = resolveConfig({ orchestrator: { dataDir, mode }, verification: { commands: verify } })
  const store = new WorkflowStore(dataDir)
  let implCalls = 0
  const backends = {
    architect: { execute: async () => ok('claude-cli', docs()) },
    implementer: { execute: async (req, opt, n) => { implCalls++; return impl(req, opt, n) } },
    reviewer: { execute: async () => ok('codex-cli', JSON.stringify({ verdict: 'APPROVE', summary: 'ok', findings: [] })) },
  }
  const engine = new Engine({ config, store, backends, git: new Git() })
  return { engine, store, config, implCalls: () => implCalls }
}

test('two concurrent resumes of one workflow: exactly one wins', async () => {
  const dir = await repo()
  const { engine, store, implCalls } = makeEngine({ repoDir: dir, verify: [] })
  const wf = await engine.start({ task: 't', repo: dir, parent: {}, mode: 'fast' })
  await engine.live.get(wf.id)?.promise
  const blocked = await store.load(wf.id)
  assert.equal(blocked.state, 'BLOCKED')
  const results = await Promise.allSettled([
    engine.resume(wf.id, {}, { verify: ['node check.js'] }),
    engine.resume(wf.id, {}, { verify: ['node check.js'] }),
  ])
  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')
  assert.equal(fulfilled.length, 1, JSON.stringify(results.map((r) => r.status)))
  assert.equal(rejected.length, 1)
  assert.match(String(rejected[0].reason?.message), /already being started|already running/)
  await engine.live.get(wf.id)?.promise
  assert.equal(implCalls(), 1, 'the implementer must not run twice for one workflow')
})

test('two concurrent starts respect maxParallelWorkers', async () => {
  const dir = await repo()
  const { engine } = makeEngine({ repoDir: dir })
  const results = await Promise.allSettled([
    engine.start({ task: 'a', repo: dir, parent: {}, mode: 'fast' }),
    engine.start({ task: 'b', repo: dir, parent: {}, mode: 'fast' }),
  ])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(results.map((r) => r.status)))
  for (const id of [...engine.live.keys()]) await engine.cancel(id)
})

test('a file literally named * cannot smuggle .orchestrator into the delivery', async () => {
  const dir = await repo()
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-star-'))
  const ws = await createWorktree({ git: new Git(), repo: dir, workflowId: 'wf-star-1', dataDir })
  await fs.writeFile(path.join(ws.path, 'a.js'), 'export const a = 1')
  await fs.writeFile(path.join(ws.path, '*'), 'wildcard')
  await fs.mkdir(path.join(ws.path, '.orchestrator'), { recursive: true })
  await fs.writeFile(path.join(ws.path, '.orchestrator', 'architecture.md'), 'spec')
  await stageChanges(new Git(), ws.path)
  const staged = g(ws.path, 'diff', '--cached', '--name-only').split('\n').filter(Boolean)
  assert.deepEqual(staged.sort(), ['*', 'a.js'])
  assert.ok(!staged.some((f) => f.startsWith('.orchestrator/')), 'scaffolding must never be staged')
  await commitTask(new Git(), ws.path, 'c')
  const committed = g(ws.path, 'show', '--name-only', '--pretty=format:', 'HEAD').split('\n').filter(Boolean)
  assert.deepEqual(committed.sort(), ['*', 'a.js'])
})

test('a planted git hook never runs at delivery, and a changed hooks dir is detected', async () => {
  const dir = await repo()
  const marker = path.join(os.tmpdir(), `hook-marker-${Math.random().toString(16).slice(2)}`)
  const hooksDir = path.join(dir, '.git', 'hooks')
  await fs.mkdir(hooksDir, { recursive: true })
  const hookFile = path.join(hooksDir, 'pre-commit')
  await fs.writeFile(hookFile, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`)
  await fs.chmod(hookFile, 0o755)
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-hook-'))
  const ws = await createWorktree({ git: new Git(), repo: dir, workflowId: 'wf-hook-1', dataDir })
  const before = await snapshotRepo(new Git(), dir)
  await fs.writeFile(path.join(ws.path, 'a.js'), 'x')
  await commitTask(new Git(), ws.path, 'c')
  assert.equal(await fs.access(marker).then(() => true, () => false), false, 'pre-commit hook must not execute')
  // Snapshot fingerprints the hooks directory, so planting one later is visible.
  await fs.writeFile(hookFile, '#!/bin/sh\ntrue\n')
  const after = await snapshotRepo(new Git(), dir)
  assert.notEqual(after.hooksHash, before.hooksHash)
})

test('changing the worktree between review and approval blocks the delivery', async () => {
  const dir = await repo()
  const { engine, store } = makeEngine({ repoDir: dir, mode: 'thorough' })
  const wf = await engine.start({ task: 't', repo: dir, parent: {} })
  for (let i = 0; i < 200; i++) {
    const w = await store.load(wf.id)
    if (w.state === 'BLOCKED') break
    await new Promise((r) => setTimeout(r, 50))
  }
  const blocked = await store.load(wf.id)
  assert.equal(blocked.blocker.kind, 'awaiting_approval')
  // Someone (or something) edits the worktree after the reviewer signed off.
  await fs.writeFile(path.join(blocked.workspace.path, 'lib.js'), 'module.exports = 999')
  await engine.approve(wf.id, {})
  await engine.live.get(wf.id)?.promise
  const after = await store.load(wf.id)
  assert.equal(after.state, 'BLOCKED')
  assert.equal(after.blocker.kind, 'tree_changed')
  assert.equal(after.delivery, undefined)
})

test('a workflow blocked before its worktree exists is resumable (BLOCKED -> CREATED)', async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-empty-'))
  g(empty, 'init', '-q', '-b', 'main') // no commits
  const { engine, store } = makeEngine({ repoDir: empty })
  const wf = await engine.start({ task: 't', repo: empty, parent: {} })
  await engine.live.get(wf.id)?.promise
  let w = await store.load(wf.id)
  assert.equal(w.state, 'BLOCKED')
  assert.equal(w.blockedFrom, 'CREATED')
  await engine.resume(wf.id, {}) // must not throw TransitionError
  await engine.live.get(wf.id)?.promise
  w = await store.load(wf.id)
  assert.ok(['BLOCKED', 'IMPLEMENTING', 'COMPLETED'].includes(w.state))
  assert.doesNotMatch(JSON.stringify(w.blocker), /illegal workflow transition/)
})

test('runProcess settles even when a grandchild keeps stdout open', async () => {
  const started = Date.now()
  const result = await runProcess({
    command: 'node',
    args: ['-e', 'const {spawn}=require("child_process"); spawn("sleep",["30"],{detached:true,stdio:"inherit"}); process.exit(0)'],
    cwd: '/tmp',
    timeoutMs: 500,
  })
  assert.ok(Date.now() - started < 10_000, 'must not wait for the orphaned grandchild')
  assert.ok(result.exitCode === 0 || result.timedOut, JSON.stringify(result))
})
