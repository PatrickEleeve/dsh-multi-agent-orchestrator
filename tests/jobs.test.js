import test from 'node:test'
import assert from 'node:assert/strict'
import { attachWorkflowJob, jobProgress } from '../src/job-bridge.js'
import { createOps } from '../src/ops.js'

function fakeJobs() {
  const specs = []
  const job = {
    progress: [],
    appended: [],
    updateProgress(line) { this.progress.push(line) },
    append(text) { this.appended.push(text) },
  }
  const service = {
    start(spec) {
      specs.push(spec)
      const hooks = spec.run(job)
      job.hooks = hooks
      return `${spec.kind}-deadbeefdeadbeef`
    },
  }
  return { service, specs, job }
}

function fakeEngine() {
  const observers = new Set()
  const cancelled = []
  return {
    observers,
    cancelled,
    observe(fn) { observers.add(fn); return () => observers.delete(fn) },
    cancel(id) { cancelled.push(id); return Promise.resolve({ id, state: 'CANCELLED' }) },
    emit(next) { for (const fn of [...observers]) fn(next) },
  }
}

const wf = () => ({
  id: 'wf-job1', task: 'build x', repo: '/repo', mode: 'balanced', state: 'CREATED',
  history: [], stages: [], fixCycles: 0, config: { maxFixCycles: 3 },
})

test('jobProgress is a compact, honest line', () => {
  assert.equal(jobProgress(undefined), 'starting')
  assert.match(jobProgress({ ...wf(), state: 'IMPLEMENTING', active: { role: 'implementer', backend: 'dsh-native' }, stages: [{}] }), /balanced: IMPLEMENTING · implementer \(dsh-native\) · 1 stage done/)
  assert.match(jobProgress({ ...wf(), state: 'BLOCKED', blocker: { kind: 'awaiting_approval' } }), /awaiting your approval/)
  assert.match(jobProgress({ ...wf(), state: 'BLOCKED', blocker: { kind: 'rate_limit' } }), /BLOCKED/)
})

test('attachWorkflowJob registers a native job and settles it with the workflow', async () => {
  const { service, specs, job } = fakeJobs()
  const engine = fakeEngine()
  const w = wf()
  const id = attachWorkflowJob({ jobs: service, engine, wf: w, sessionId: 'sess-1' })
  assert.equal(id, 'orchestrate-deadbeefdeadbeef')
  assert.equal(specs[0].kind, 'orchestrate')
  assert.equal(specs[0].owner, 'sess-1')
  assert.equal(specs[0].label, 'build x')
  assert.match(job.appended[0], /workflow wf-job1 started \(balanced\)/)

  engine.emit({ ...w, state: 'IMPLEMENTING', active: { role: 'implementer', backend: 'dsh-native' }, stages: [{}], history: [{ at: 't1', from: 'CREATED', to: 'IMPLEMENTING', reason: 'workspace ready' }] })
  assert.match(job.progress.at(-1), /IMPLEMENTING · implementer/)
  assert.match(job.appended.at(-1), /CREATED → IMPLEMENTING: workspace ready/)

  engine.emit({ ...w, state: 'COMPLETED', delivery: { branch: 'orchestrate/wf-job1', commit: 'abc123456789', files: ['a.js'], worktree: '/w' }, verification: { status: 'passed' }, review: { verdict: 'APPROVE' }, history: [] })
  const outcome = await job.hooks.done
  assert.equal(outcome.status, 'completed')
  assert.match(outcome.result, /COMPLETED/)
  assert.equal(engine.observers.size, 0, 'observer released after settlement')
})

test('cancelling the job cancels the workflow; blocked settles as failed', async () => {
  const { service, job } = fakeJobs()
  const engine = fakeEngine()
  const w = wf()
  attachWorkflowJob({ jobs: service, engine, wf: w, sessionId: 's' })
  job.hooks.cancel()
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(engine.cancelled, ['wf-job1'])
  engine.emit({ ...w, state: 'BLOCKED', blocker: { kind: 'repair_exhausted', message: 'no more cycles' }, history: [] })
  const outcome = await job.hooks.done
  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.detail, 'repair_exhausted')
})

test('the bridge is advisory: it never throws or blocks the workflow', () => {
  const engine = fakeEngine()
  assert.equal(attachWorkflowJob({ jobs: undefined, engine, wf: wf(), sessionId: 's' }), undefined)
  assert.equal(attachWorkflowJob({ jobs: { start() { throw new Error('no controller') } }, engine, wf: wf(), sessionId: 's' }), undefined)
  assert.equal(attachWorkflowJob({ jobs: { start() {} }, engine, wf: wf(), sessionId: undefined }), undefined)
  assert.equal(attachWorkflowJob({ jobs: { start() {} }, engine, wf: { ...wf(), state: 'COMPLETED' }, sessionId: 's' }), undefined)
  const throwingEngine = { observe() { throw new Error('x') }, cancel() {} }
  assert.equal(attachWorkflowJob({ jobs: { start() {} }, engine: throwingEngine, wf: wf(), sessionId: 's' }), undefined)
})

test('ops.run reports the background job id when the jobs service is available', async () => {
  const { service, specs } = fakeJobs()
  const started = { id: 'wf-ops1', task: 't', repo: '/r', mode: 'balanced', state: 'CREATED', history: [], stages: [] }
  const engine = { ...fakeEngine(), start: async () => started }
  const ops = createOps({
    ctx: {}, config: { roles: { architect: { model: 'opus' }, implementer: { provider: 'deepseek-account', model: 'auto', reasoning: 'max' }, reviewer: { model: 'default' } }, orchestrator: { maxFixCycles: 3 } },
    store: { list: async () => [], load: async () => undefined, dir: () => '/tmp' },
    engine, backends: {}, resolveRepo: async () => '/r', jobs: service,
  })
  const text = await ops.run({ task: 'do it', verify: [] }, { session: { id: 'sess-9' } })
  assert.match(text, /Background job: orchestrate-deadbeefdeadbeef/)
  assert.match(text, /notification in this chat/)
  assert.equal(specs[0].owner, 'sess-9')
})
