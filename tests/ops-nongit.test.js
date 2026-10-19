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
  await assert.rejects(ops.run({ task: '修复 a.js', repo: dir }, { id: 'agent' }), /failed at git commit[\s\S]*nothing was left behind/)
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
