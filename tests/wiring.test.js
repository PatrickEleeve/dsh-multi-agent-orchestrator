import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { apply, inject, buildRuntime } from '../index.js'
import { terminateOrphan } from '../src/process.js'
import { createOps } from '../src/ops.js'

/** Minimal Cordis-like ctx that records registrations and runs effects. */
function fakeCtx(services = {}) {
  const registered = { commands: [], tools: [], disposers: [], routes: [] }
  const injectedDeps = []
  const ctx = {
    logger: () => ({ warn: () => undefined }),
    get: (key) => services[key],
    commands: { register: (def) => { registered.commands.push(def); return () => undefined } },
    tools: { register: (def) => { registered.tools.push(def); return () => undefined } },
    workingDirectory: { ensure: async () => '/tmp' },
    effect: (fn, label) => { const d = fn(); registered.disposers.push({ label, dispose: typeof d === 'function' ? d : () => undefined }); return d },
    // Cordis waits for injected services before running the callback.
    inject: (deps, callback) => {
      injectedDeps.push(...deps)
      callback({ ...ctx, webServer: { register: (route) => { registered.routes.push(route); return () => undefined } }, get: (key) => services[key] })
    },
  }
  return { ctx, registered, injectedDeps }
}
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'orch-wire-'))

test('plugin wiring: declares injections and registers command + tool', async () => {
  assert.deepEqual(inject, ['tools', 'commands', 'subagents', 'workingDirectory'])
  const { ctx, registered, injectedDeps } = fakeCtx()
  apply(ctx, { orchestrator: { dataDir: await tmp() } })
  assert.deepEqual(registered.commands.map((c) => c.name), ['orchestrate'])
  assert.deepEqual(registered.tools.map((t) => t.name), ['orchestrate'])
  assert.equal(registered.disposers.length, 4) // workflows-on-unload, routes, command, tool
  assert.deepEqual(injectedDeps, ['webServer'])
  assert.equal(registered.routes.length, 1)
  assert.equal(registered.routes[0].path, '/orchestrate-api')
  // every registered tool parameter is a valid JSON-schema object
  for (const tool of registered.tools) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  }
  // unloading must not throw and must be idempotent
  for (const d of registered.disposers) d.dispose()
  for (const d of registered.disposers) d.dispose()
})

test('invalid config fails activation instead of registering unsafe behaviour', async () => {
  const { ctx } = fakeCtx()
  assert.throws(() => apply(ctx, { billing: { allowPaidApiFallback: true } }), /Invalid orchestrator configuration/)
  assert.throws(() => buildRuntime(fakeCtx().ctx, { orchestrator: { autoPush: true } }), /autoPush/)
})

test('/orchestrate command handler: help/config succeed, errors surface as error kind', async () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, { orchestrator: { dataDir: await tmp() } })
  const handler = registered.commands[0].handler
  const help = await handler({ agent: undefined, rawInput: '' })
  assert.equal(help.kind, 'success'); assert.match(help.text, /\/orchestrate <development task>/)
  const config = await handler({ agent: undefined, rawInput: 'config' })
  assert.equal(config.kind, 'success'); assert.match(config.text, /subscriptionFirst/)
  const bad = await handler({ agent: undefined, rawInput: 'cancel' })
  assert.equal(bad.kind, 'error'); assert.match(bad.text, /no running workflow/)
  const noAgent = await handler({ agent: undefined, rawInput: 'run do something' })
  assert.equal(noAgent.kind, 'error'); assert.match(noAgent.text, /no agent context/)
})

test('orchestrate tool: action routing and required arguments', async () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, { orchestrator: { dataDir: await tmp() } })
  const tool = registered.tools[0]
  const exec = { agent: { id: 'a' }, signal: new AbortController().signal }
  assert.match((await tool.execute({ action: 'config' }, exec)).text, /Effective configuration/)
  assert.match((await tool.execute({ action: 'status' }, exec)).text, /No workflows yet/)
  await assert.rejects(tool.execute({ action: 'run' }, exec), /task is required/)
  await assert.rejects(tool.execute({ action: 'nope' }, exec), /unknown action/)
  assert.match((await tool.output.render({}, { text: 'hi' }))[0].text, /hi/)
})

test('ops dispatch covers every command action without a live agent', async () => {
  const dataDir = await tmp()
  const calls = []
  const ops = createOps({
    ctx: {}, config: { roles: { architect: { model: 'opus' }, implementer: { provider: 'deepseek-account', model: 'auto' }, reviewer: { model: 'default' } }, billing: {}, orchestrator: { maxFixCycles: 3 } }, store: { list: async () => [], load: async () => undefined, dir: (id) => path.join(dataDir, id) },
    engine: { start: async () => { throw new Error('no') }, cancel: async () => ({}), resume: async () => ({}), approve: async () => ({}), isLive: () => false },
    backends: { architect: { discoverModels: async () => [{ id: 'opus' }], healthCheck: async () => ({ ok: false, available: false, error: 'no' }) }, reviewer: { discoverModels: async () => [], healthCheck: async () => ({ ok: false, available: false, error: 'no' }) }, implementer: { discoverModels: async () => [], resolveModel: async () => ({ model: 'deepseek-flash', verified: true }), healthCheck: async () => ({ ok: false, available: false, checks: {} }) } },
    resolveRepo: async () => { calls.push('repo'); return '/tmp' },
  })
  assert.match(await ops.handle('help'), /orchestrate/)
  assert.match(await ops.handle('status'), /No workflows yet/)
  assert.match(await ops.handle('models'), /Architect \(claude-cli\)/)
  assert.match(await ops.handle('test-connections'), /FAIL/)
  assert.match(await ops.handle('config'), /maxFixCycles/)
  assert.match(await ops.handle(''), /orchestrate/)
  await assert.rejects(ops.handle('cancel'), /no running workflow/)
  await assert.rejects(ops.handle('approve'), /no workflow awaiting approval/)
  await assert.rejects(ops.handle('resume'), /no blocked workflow/)
  await assert.rejects(ops.handle('report wf-unknown'), /unknown workflow/)
  assert.ok(calls.length >= 2)
})

test('recovery of live workflows does not touch running ones', async () => {
  const dataDir = await tmp()
  const { ctx } = fakeCtx()
  const { store, engine } = buildRuntime(ctx, { orchestrator: { dataDir } })
  await store.save({ id: 'wf-live-1', state: 'IMPLEMENTING', createdAt: '2026-01-01T00:00:00.000Z', history: [], stages: [], violations: [], reviews: [], verificationHistory: [] })
  engine.live.set('wf-live-1', { controller: new AbortController(), promise: Promise.resolve() })
  assert.deepEqual(await store.recoverInterrupted({ isLive: (id) => engine.isLive(id) }), [])
  assert.equal((await store.load('wf-live-1')).state, 'IMPLEMENTING')
})

test('terminateOrphan: only signals the recorded process group when ps still matches', async () => {
  const killed = []
  const kill = (pid) => killed.push(pid)
  assert.match((await terminateOrphan({})).note, /no recorded child process/)
  assert.match((await terminateOrphan({ pid: 42, executable: 'codex' }, { isAlive: async () => false, commandOf: async () => 'codex', kill })).note, /no longer running/)
  const mismatch = await terminateOrphan({ pid: 42, executable: 'codex' }, { isAlive: async () => true, commandOf: async () => 'node unrelated.js', kill })
  assert.equal(mismatch.killed, false); assert.deepEqual(killed, [])
  const match = await terminateOrphan({ pid: 42, executable: '/usr/local/bin/codex' }, { isAlive: async () => true, commandOf: async () => '/usr/local/bin/codex exec -', kill })
  assert.equal(match.killed, true); assert.deepEqual(killed, [42])
  assert.match(match.note, /terminated the surviving/)
})

test('terminateOrphan kills a real surviving process (integration)', async () => {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  await new Promise((r) => child.on('spawn', r))
  const exited = new Promise((r) => child.on('exit', r))
  const result = await terminateOrphan({ pid: child.pid, executable: 'sleep' })
  assert.equal(result.killed, true, result.note)
  await exited
  assert.equal(child.exitCode !== null || child.signalCode !== null, true)
})


test('native approval card: thorough mode asks in chat and approves without a slash command', async () => {
  const fs = await import('node:fs/promises')
  const { execFileSync } = await import('node:child_process')
  const { ARTIFACT_FILES } = await import('../src/agents/architect.js')
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-card-'))
  g(repo, 'init', '-q', '-b', 'main')
  await fs.writeFile(path.join(repo, 'README.md'), '# x')
  g(repo, 'add', '-A'); g(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')

  const doc = (n) => `# ${n}\n## Scope\nlong enough content to satisfy validation rules for the architect artifacts.\n## Non-goals\nn\n## Decisions module\nx\n## Failure modes risks\nx\n## Security\nx\n## Task order dependencies\n- t\n## Test requirements\ninterface API\n## Acceptance criteria\n1. a\n2. b\n3. c\n`
  const docs = ARTIFACT_FILES.map((n) => `=====FILE: ${n}=====\n${doc(n)}\n=====END FILE=====`).join('\n')
  const asked = []
  const { ctx } = fakeCtx({
    userQuestions: {
      ask: async (request) => {
        asked.push(request)
        return { answers: [{ id: 'approval', selected: ['Approve'] }] }
      },
    },
  })
  const { engine, store, backends } = buildRuntime(ctx, { orchestrator: { dataDir: await tmp(), mode: 'thorough' }, verification: { commands: ['node check.js'] } })
  const ok = (backend, text) => ({ ok: true, backend, text, model: `${backend}-model`, durationMs: 1 })
  backends.architect.execute = async () => ok('claude-cli', docs)
  backends.implementer.execute = async (req) => {
    await fs.writeFile(path.join(req.cwd, 'check.js'), 'process.exit(0)')
    await fs.writeFile(path.join(req.cwd, 'lib.js'), 'module.exports = 1')
    return ok('dsh-native', 'done')
  }
  backends.reviewer.execute = async () => ok('codex-cli', JSON.stringify({ verdict: 'APPROVE', summary: 'fine', findings: [] }))

  const rootAgent = { id: 'root-agent' }
  const wf = await engine.start({ task: 'build x', repo, parent: rootAgent })
  const deadline = Date.now() + 30_000
  let state
  for (;;) {
    state = (await store.load(wf.id)) ?? {}
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(state.state) || Date.now() > deadline) break
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.equal(state.state, 'COMPLETED', JSON.stringify({ blocker: state.blocker, asked: asked.length }))
  assert.equal(asked.length, 1)
  assert.equal(asked[0].agent, rootAgent)
  assert.equal(asked[0].questions[0].id, 'approval')
  assert.match(asked[0].questions[0].detail, /Codex|Review:/)
  assert.ok(state.delivery?.commit)
})

test('approval card: rejection cancels, and a failing card falls back to the command path', async () => {
  const { promptApproval, approvalQuestion, interpretApproval } = await import('../src/approval.js')
  const wf = { id: 'wf-x', state: 'BLOCKED', mode: 'thorough', blocker: { kind: 'awaiting_approval' }, changes: { files: ['a.js'] }, review: { verdict: 'APPROVE', summary: 'ok', findings: [] }, verification: { status: 'passed', results: [{ name: 'npm test', passed: true }] }, workspace: { branch: 'orchestrate/wf-x' } }
  assert.match(approvalQuestion(wf).question, /wf-x/)
  assert.match(approvalQuestion(wf).detail, /orchestrate\/wf-x/)
  assert.equal(interpretApproval({ answers: [{ id: 'a', selected: ['Approve'] }] }), 'approve')
  assert.equal(interpretApproval({ answers: [{ id: 'a', selected: [], custom: 'approve it' }] }), 'approve')
  assert.equal(interpretApproval({ answers: [{ id: 'a', selected: ['Reject'] }] }), 'reject')
  assert.equal(interpretApproval({ answers: [] }), 'unknown')
  assert.equal(interpretApproval(undefined), 'unknown')

  const calls = []
  const fakeEngine = { approve: async (id) => calls.push(['approve', id]), cancel: async (id) => calls.push(['cancel', id]) }
  assert.equal(await promptApproval({ wf: { ...wf, state: 'REVIEWING' }, ask: async () => ({}), engine: fakeEngine, agent: {} }), 'skipped')
  assert.equal(await promptApproval({ wf, ask: undefined, engine: fakeEngine, agent: {} }), 'skipped')
  assert.equal(await promptApproval({ wf, ask: async () => ({ answers: [{ id: 'a', selected: ['Approve'] }] }), engine: fakeEngine, agent: undefined }), 'skipped')
  assert.deepEqual(calls, [])
  assert.equal(await promptApproval({ wf, ask: async () => ({ answers: [{ id: 'a', selected: ['Reject'] }] }), engine: fakeEngine, agent: {} }), 'rejected')
  assert.equal(await promptApproval({ wf, ask: async () => ({ answers: [{ id: 'a', selected: ['Approve'] }] }), engine: fakeEngine, agent: {} }), 'approved')
  assert.deepEqual(calls, [['cancel', 'wf-x'], ['approve', 'wf-x']])
  const logs = []
  assert.equal(await promptApproval({ wf, ask: async () => { throw Object.assign(new Error('none'), { code: 'NO_PROVIDER' }) }, engine: fakeEngine, agent: {}, log: (m) => logs.push(m) }), 'skipped')
  assert.match(logs[0], /NO_PROVIDER/)
})

test('workflow ids are optional: the newest matching workflow is chosen', async () => {
  const dataDir = await tmp()
  const { store, engine } = buildRuntime(fakeCtx().ctx, { orchestrator: { dataDir } })
  const base = { task: 't', mode: 'balanced', createdAt: '2026-01-01T00:00:00.000Z', fixCycles: 0, config: { maxFixCycles: 3 }, history: [], stages: [], violations: [], reviews: [], verificationHistory: [] }
  await store.save({ ...base, id: 'wf-old-block', createdAt: '2026-01-01T00:00:00.000Z', state: 'BLOCKED', blocker: { kind: 'repair_exhausted' } })
  await store.save({ ...base, id: 'wf-new-block', createdAt: '2026-01-02T00:00:00.000Z', state: 'BLOCKED', awaitingApproval: true, blocker: { kind: 'awaiting_approval' } })
  const ops = createOps({
    ctx: {}, config: { roles: { architect: { model: 'opus' }, implementer: {}, reviewer: {} }, orchestrator: { maxFixCycles: 3 }, billing: {} },
    store, engine, backends: {}, resolveRepo: async () => '/tmp',
  })
  const seen = []
  engine.approve = async (id) => { seen.push(['approve', id]); return { ...(await store.load(id)), state: 'REVIEWING' } }
  engine.resume = async (id) => { seen.push(['resume', id]); return { ...(await store.load(id)), state: 'IMPLEMENTING' } }
  engine.cancel = async (id) => { seen.push(['cancel', id]); return { ...(await store.load(id)), state: 'CANCELLED' } }
  await ops.handle('approve')
  await ops.handle('resume')
  await ops.handle('cancel')
  assert.deepEqual(seen, [['approve', 'wf-new-block'], ['resume', 'wf-new-block'], ['cancel', 'wf-new-block']])
})


test('approval plumbing never rejects: a ctx without an injectable userQuestions is tolerated', async () => {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-safe-'))
  const hostileCtx = {
    logger: () => ({ warn: () => undefined }),
    // Cordis throws exactly this when a non-injected service property is read.
    get: () => { throw new Error('cannot get property "userQuestions" without inject') },
    commands: { register: () => () => undefined },
    tools: { register: () => () => undefined },
    workingDirectory: { ensure: async () => '/tmp' },
    effect: (fn) => fn(),
  }
  const rt = buildRuntime(hostileCtx, { orchestrator: { dataDir } })
  const blocked = {
    id: 'wf-blocked-1', task: 't', mode: 'thorough', state: 'BLOCKED', createdAt: '2026-01-01T00:00:00.000Z',
    fixCycles: 0, config: { maxFixCycles: 3 }, history: [], stages: [], violations: [], reviews: [], verificationHistory: [],
    awaitingApproval: true, blocker: { kind: 'awaiting_approval', message: 'gate' },
  }
  await rt.store.save(blocked)
  assert.equal(await rt.notifyPendingApproval({ id: 'agent' }), undefined) // must resolve, never reject
  assert.equal(await rt.maybePromptApproval(blocked, { id: 'agent' }), 'skipped')
})

test('a pending approval gate is re-offered when an agent next interacts', async () => {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-reoffer-'))
  const asked = []
  const { ctx } = fakeCtx({ userQuestions: { ask: async (r) => { asked.push(r); return { answers: [{ id: 'approval', selected: ['Approve'] }] } } } })
  const rt = buildRuntime(ctx, { orchestrator: { dataDir } })
  const approved = []
  rt.engine.approve = async (id) => { approved.push(id) }
  await rt.store.save({
    id: 'wf-gate-1', task: 't', mode: 'thorough', state: 'BLOCKED', createdAt: '2026-01-01T00:00:00.000Z',
    fixCycles: 0, config: { maxFixCycles: 3 }, history: [], stages: [], violations: [], reviews: [], verificationHistory: [],
    awaitingApproval: true, blocker: { kind: 'awaiting_approval', message: 'gate' },
  })
  await rt.notifyPendingApproval({ id: 'root' })
  assert.equal(asked.length, 1)
  assert.deepEqual(approved, ['wf-gate-1'])
})


test('resume forwards explicit verification commands through the ops layer', async () => {
  const dataDir = await tmp()
  const { store, engine } = buildRuntime(fakeCtx().ctx, { orchestrator: { dataDir } })
  await store.save({
    id: 'wf-noverify', task: 't', mode: 'balanced', state: 'BLOCKED', createdAt: '2026-01-01T00:00:00.000Z',
    fixCycles: 0, config: { maxFixCycles: 3 }, history: [], stages: [], violations: [], reviews: [], verificationHistory: [],
    blocker: { kind: 'no_verification', message: 'no commands' }, verifySpecs: [],
  })
  const seen = []
  engine.resume = async (id, agent, options) => { seen.push([id, options]); return { id, state: 'IMPLEMENTING' } }
  const ops = createOps({
    ctx: {}, config: { roles: { architect: { model: 'opus' }, implementer: {}, reviewer: {} }, orchestrator: { maxFixCycles: 3 }, billing: {} },
    store, engine, backends: {}, resolveRepo: async () => '/tmp',
  })
  const text = await ops.handle('resume --verify "npm test"', { id: 'a' })
  assert.match(text, /with verification: npm test/)
  assert.equal(seen.length, 1)
  assert.equal(seen[0][0], 'wf-noverify')
  assert.deepEqual([...seen[0][1].verify], ['npm test'])
})


test('an explicit repo argument overrides the chat working directory', async () => {
  const dataDir = await tmp()
  const seen = []
  const ops = createOps({
    ctx: {}, config: { roles: { architect: { model: 'opus' }, implementer: { provider: 'p', model: 'm', reasoning: 'max' }, reviewer: { model: 'default' } }, orchestrator: { maxFixCycles: 3 } },
    store: { list: async () => [], load: async () => undefined, dir: () => '/tmp' },
    engine: { start: async (request) => { seen.push(request); return { id: 'wf-r1', mode: 'fast' } }, cancel: async () => ({}), resume: async () => ({}), approve: async () => ({}), isLive: () => false },
    backends: {}, resolveRepo: async () => { throw new Error('cwd must not be used') }, jobs: undefined,
  })
  const text = await ops.run({ task: 't', mode: 'fast', verify: [], repo: dataDir }, { id: 'a' })
  assert.match(text, /Repository: /)
  assert.equal(seen[0].repo, dataDir)
  await assert.rejects(ops.run({ task: 't', verify: [], repo: '/definitely/not/here' }, { id: 'a' }), /is not a directory/)
})
