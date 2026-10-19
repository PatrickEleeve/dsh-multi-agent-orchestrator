/** Non-git handling in ops.run: exact consent, all-or-nothing init, honest messages. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createOps } from '../src/ops.js'
import { Git } from '../src/workspace/worktree.js'

const config = { roles: { architect: { model: 'sonnet', critiqueModel: 'opus' }, implementer: { provider: 'p', model: 'm', reasoning: 'max' }, reviewer: { model: 'gpt' } }, orchestrator: { maxFixCycles: 3 } }

function harness({ answer, git = new Git(), askAvailable = true }) {
  const started = []
  const engine = {
    git,
    start: async (request) => {
      const isRepo = await fs.lstat(path.join(request.repo, '.git')).then(() => true, () => false)
      if (!isRepo && request.mode !== 'review') {
        const error = new Error('not a git repository')
        error.code = 'NOT_GIT_REPO'
        throw error
      }
      started.push(request)
      return { id: 'wf-x', mode: request.mode ?? 'balanced', route: { readOnly: request.mode === 'review' } }
    },
  }
  const ops = createOps({
    ctx: {}, config, engine, store: { list: async () => [] }, backends: {}, jobs: undefined,
    resolveRepo: async () => '/tmp',
    askQuestions: askAvailable ? () => async () => answer : () => undefined,
  })
  return { ops, started }
}
const plainDir = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-ops-plain-'))
  await fs.writeFile(path.join(dir, 'a.js'), 'x')
  return dir
}

test('free text starting with 初始化 is not consent', async () => {
  const dir = await plainDir()
  const { ops, started } = harness({ answer: { answers: [{ custom: '初始化会不会影响现有文件？' }] } })
  const text = await ops.run({ task: '修复 a.js', repo: dir }, { id: 'agent' })
  assert.match(text, /已取消/)
  assert.equal(started.length, 0)
  assert.equal(await fs.lstat(path.join(dir, '.git')).then(() => true, () => false), false)
})

test('the exact init option initialises git once and runs the task', async () => {
  const dir = await plainDir()
  const { ops, started } = harness({ answer: { answers: [{ selected: ['初始化 git 并继续'] }] } })
  await ops.run({ task: '修复 a.js', repo: dir }, { id: 'agent' })
  assert.equal(started.length, 1)
  assert.match(await fs.readFile(path.join(dir, '.gitignore'), 'utf8'), /node_modules\/[\s\S]*\.env/)
  const log = await new Git().exec(dir, ['log', '--oneline'])
  assert.match(log.stdout, /initial import/)
})

test('a failed first commit leaves nothing half-initialised', async () => {
  const dir = await plainDir()
  const real = new Git()
  const failingGit = { exec: (cwd, args, opts) => (args.includes('commit') ? Promise.reject(new Error('gpg failed to sign')) : real.exec(cwd, args, opts)) }
  const { ops } = harness({ answer: { answers: [{ selected: ['初始化 git 并继续'] }] }, git: failingGit })
  await assert.rejects(ops.run({ task: '修复 a.js', repo: dir }, { id: 'agent' }), /failed at git commit[\s\S]*only files this attempt created were removed/)
  assert.equal(await fs.lstat(path.join(dir, '.git')).then(() => true, () => false), false, '.git must be removed')
  assert.equal(await fs.lstat(path.join(dir, '.gitignore')).then(() => true, () => false), false, 'the .gitignore we wrote is removed')
})

test('choosing read-only review drops a contradictory review override', async () => {
  const dir = await plainDir()
  const { ops, started } = harness({ answer: { answers: [{ selected: ['改为只读审查'] }] } })
  const text = await ops.run({ task: '修复 a.js', repo: dir, review: false }, { id: 'agent' })
  assert.equal(started[0].mode, 'review')
  assert.equal(started[0].review, undefined)
  assert.match(text, /只读审查/)
})

test('no question card available: says so instead of "repeat the task"', async () => {
  const dir = await plainDir()
  const { ops } = harness({ askAvailable: false })
  const text = await ops.run({ task: '修复 a.js', repo: dir }, { id: 'agent' })
  assert.match(text, /弹不出选择卡片/)
  assert.doesNotMatch(text, /再说一次任务/)
})

test('review-style wording routes to review mode without a git repo', async () => {
  const dir = await plainDir()
  const { ops, started } = harness({})
  await ops.run({ task: '审查 a.js 有什么问题', repo: dir }, { id: 'agent' })
  assert.equal(started[0].mode, 'review')
})

test('ambiguous wording asks; the answer decides, and cancel does nothing', async () => {
  const dir = await plainDir()
  const run = async (selected) => {
    const { ops, started } = harness({ answer: { answers: [{ selected: [selected] }] } })
    const text = await ops.run({ task: '审查 a.js 的实现', repo: dir }, { id: 'agent' })
    return { text, started }
  }
  assert.equal((await run('只读审查（不改代码）')).started[0].mode, 'review')
  const cancelled = await run('取消')
  assert.equal(cancelled.started.length, 0)
  assert.match(cancelled.text, /已取消/)
})

test('ambiguous wording without a card falls back to the safe read-only review and says so', async () => {
  const dir = await plainDir()
  const { ops, started } = harness({ askAvailable: false })
  const text = await ops.run({ task: '看看这次修复有没有问题', repo: dir }, { id: 'agent' })
  assert.equal(started[0].mode, 'review')
  assert.match(text, /无法弹卡片确认[\s\S]*--mode balanced/)
})

test('an inferred review says it was inferred', async () => {
  const dir = await plainDir()
  const { ops } = harness({})
  assert.match(await ops.run({ task: '审查 a.js', repo: dir }, { id: 'agent' }), /按你的措辞判断为只读审查/)
})

test('a dismissed card is a cancel, not "cannot show a card"', async () => {
  const dir = await plainDir()
  const engine = { git: new Git(), start: async () => { const e = new Error('nope'); e.code = 'NOT_GIT_REPO'; throw e } }
  const ops = createOps({ ctx: {}, config, engine, store: { list: async () => [] }, backends: {}, resolveRepo: async () => '/tmp', askQuestions: () => async () => { throw new Error('dismissed') } })
  const text = await ops.run({ task: '修复 a.js', repo: dir }, { id: 'agent' })
  assert.match(text, /已取消/)
  assert.doesNotMatch(text, /弹不出/)
})

test('if the run cannot start after a fresh init, the init is rolled back', async () => {
  const dir = await plainDir()
  let calls = 0
  const engine = {
    git: new Git(),
    start: async () => {
      calls += 1
      if (calls === 1) { const e = new Error('not a git repository'); e.code = 'NOT_GIT_REPO'; throw e }
      throw new Error('a workflow is already running')
    },
  }
  const ops = createOps({ ctx: {}, config, engine, store: { list: async () => [] }, backends: {}, resolveRepo: async () => '/tmp', askQuestions: () => async () => ({ answers: [{ selected: ['初始化 git 并继续'] }] }) })
  await assert.rejects(ops.run({ task: '修复 a.js', repo: dir }, { id: 'agent' }), /already running[\s\S]*removed again/)
  assert.equal(await fs.lstat(path.join(dir, '.git')).then(() => true, () => false), false)
  assert.equal(await fs.lstat(path.join(dir, '.gitignore')).then(() => true, () => false), false)
})

test('an existing .gitignore is never deleted by a failed init', async () => {
  const dir = await plainDir()
  await fs.writeFile(path.join(dir, '.gitignore'), 'mine\n')
  const real = new Git()
  const failingGit = { exec: (cwd, args, opts) => (args.includes('commit') ? Promise.reject(new Error('boom')) : real.exec(cwd, args, opts)) }
  const { ops } = harness({ answer: { answers: [{ selected: ['初始化 git 并继续'] }] }, git: failingGit })
  await assert.rejects(ops.run({ task: '修复 a.js', repo: dir }, { id: 'agent' }), /only files this attempt created were removed/)
  assert.equal(await fs.readFile(path.join(dir, '.gitignore'), 'utf8'), 'mine\n')
  assert.equal(await fs.lstat(path.join(dir, '.git')).then(() => true, () => false), false)
})

test('git init is refused for the home directory and filesystem roots', async () => {
  for (const target of [os.homedir(), path.parse(os.homedir()).root]) {
    const { ops } = harness({ answer: { answers: [{ selected: ['初始化 git 并继续'] }] } })
    await assert.rejects(ops.run({ task: '修复 a.js', repo: target }, { id: 'agent' }), /refusing to run git init/)
  }
})

test('two concurrent inits of one directory: one initialises, the other reuses it; nothing is deleted', async () => {
  const dir = await plainDir()
  const mk = () => harness({ answer: { answers: [{ selected: ['初始化 git 并继续'] }] } }).ops
  const results = await Promise.allSettled([mk().run({ task: '修复 a.js', repo: dir }, { id: 'a' }), mk().run({ task: '修复 a.js', repo: dir }, { id: 'b' })])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2, JSON.stringify(results.map((r) => r.reason?.message ?? 'ok')))
  const log = await new Git().exec(dir, ['log', '--oneline'])
  assert.equal(log.stdout.trim().split('\n').length, 1, 'exactly one initial commit')
  assert.match(log.stdout, /initial import/)
  assert.match(await fs.readFile(path.join(dir, '.gitignore'), 'utf8'), /node_modules/)
})

test('choosing "change" never falls back to a read-only default mode', async () => {
  const dir = await plainDir()
  await new Git().exec(dir, ['init', '-q'])
  const started = []
  const engine = { git: new Git(), start: async (r) => { started.push(r); return { id: 'wf', mode: r.mode, route: { readOnly: r.mode === 'review' } } } }
  const reviewDefault = { ...config, orchestrator: { ...config.orchestrator, mode: 'review' } }
  const ops = createOps({ ctx: {}, config: reviewDefault, engine, store: { list: async () => [] }, backends: {}, resolveRepo: async () => '/tmp', askQuestions: () => async () => ({ answers: [{ selected: ['修改代码'] }] }) })
  await ops.run({ task: '审查 a.js 的实现', repo: dir }, { id: 'agent' })
  assert.equal(started[0].mode, 'balanced')
})

test('a provider that throws synchronously is "unavailable", not a crash', async () => {
  const dir = await plainDir()
  const engine = { git: new Git(), start: async (r) => ({ id: 'wf', mode: r.mode, route: { readOnly: r.mode === 'review' } }) }
  const ops = createOps({ ctx: {}, config, engine, store: { list: async () => [] }, backends: {}, resolveRepo: async () => '/tmp', askQuestions: () => { throw new Error('no service') } })
  assert.match(await ops.run({ task: '审查 a.js 的实现', repo: dir }, { id: 'agent' }), /无法弹卡片确认/)
})

test('a symlink or case alias of the home directory cannot bypass the init guard', async () => {
  const link = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'orch-homelink-')), 'home')
  await fs.symlink(os.homedir(), link, 'dir')
  const targets = [link]
  if (process.platform === 'darwin') targets.push(os.homedir().toUpperCase())
  for (const target of targets) {
    const { ops } = harness({ answer: { answers: [{ selected: ['初始化 git 并继续'] }] } })
    await assert.rejects(ops.run({ task: '修复 a.js', repo: target }, { id: 'agent' }), /refusing to run git init/, target)
  }
})

test('a repo created while the card was open is used, not re-initialised', async () => {
  const dir = await plainDir()
  let first = true
  const engine = {
    git: new Git(),
    start: async (r) => {
      if (first) { first = false; await new Git().exec(dir, ['init', '-q']); const e = new Error('x'); e.code = 'NOT_GIT_REPO'; throw e }
      return { id: 'wf', mode: r.mode, route: { readOnly: false } }
    },
  }
  const ops = createOps({ ctx: {}, config, engine, store: { list: async () => [] }, backends: {}, resolveRepo: async () => '/tmp', askQuestions: () => async () => ({ answers: [{ selected: ['初始化 git 并继续'] }] }) })
  await ops.run({ task: '修复 a.js', repo: dir }, { id: 'agent' })
  assert.equal(await fs.lstat(path.join(dir, '.gitignore')).then(() => true, () => false), false, 'no init happened')
})
