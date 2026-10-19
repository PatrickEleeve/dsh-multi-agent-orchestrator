import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, splitCommand, ConfigError } from '../src/config.js'
import { redact, redactDeep, sanitizedEnv } from '../src/security/redaction.js'
import { runProcess, parseJsonLines } from '../src/process.js'
import { normalizeVerificationCommand, isPathAllowed, billingDecision, PolicyError } from '../src/security/permissions.js'
import { parseOrchestrateInput } from '../src/commands.js'
import { canTransition, transition, TransitionError } from '../src/orchestrator/state-machine.js'
import { routeFor } from '../src/orchestrator/routing.js'

test('default config is valid and subscription-first', () => {
  const c = resolveConfig({})
  assert.equal(c.orchestrator.mode, 'balanced')
  assert.equal(c.billing.allowPaidApiFallback, false)
  assert.equal(c.roles.architect.permissionMode, 'plan')
  assert.equal(c.roles.reviewer.sandbox, 'read-only')
})
test('config rejects unsafe overrides', () => {
  for (const bad of [{ orchestrator: { autoMerge: true } }, { orchestrator: { autoPush: true } }, { billing: { allowPaidApiFallback: true } }, { billing: { maxAutomaticApiSpendUSD: 5 } }, { billing: { silentBackendSwitch: true } }, { security: { automaticSelfUpdate: true } }, { orchestrator: { mode: 'yolo' } }, { orchestrator: { maxFixCycles: 99 } }, { roles: { reviewer: { sandbox: 'danger-full-access' } } }, { roles: { architect: { permissionMode: 'bypassPermissions' } } }]) {
    assert.throws(() => resolveConfig(bad), ConfigError, JSON.stringify(bad))
  }
  assert.equal(resolveConfig({ orchestrator: { mode: 'fast', maxFixCycles: 1 } }).orchestrator.maxFixCycles, 1)
})
test('splitCommand honours quotes without a shell', () => {
  assert.deepEqual(splitCommand('npm run "my test" \'a b\''), ['npm', 'run', 'my test', 'a b'])
  assert.throws(() => splitCommand('echo "x'))
})
test('redaction removes credentials', () => {
  const s = 'ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnop and Bearer abcdefghijklmnopqrstuv and token: "hunter2hunter2"'
  const r = redact(s)
  assert.doesNotMatch(r, /sk-ant-abcdef|abcdefghijklmnopqrstuv|hunter2/)
  assert.doesNotMatch(JSON.stringify(redactDeep({ a: ['sk-abcdefghijklmnopqrstuvwxyz'] })), /sk-abcdef/)
})
test('child env strips credential-like variables', () => {
  const env = sanitizedEnv({
    PATH: '/bin', HOME: '/h', KEEP: '1', KEYBOARD_LAYOUT: 'us',
    ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'y', MY_SECRET: 'z', GITHUB_AUTH_TOKEN: 't',
    GITHUB_TOKEN: 'g', GH_TOKEN: 'gh', NPM_TOKEN: 'n', AWS_SECRET_ACCESS_KEY: 'a',
    AWS_SESSION_TOKEN: 's', HF_TOKEN: 'h', DATABASE_URL: 'postgres://u:p@h/db', HUGGINGFACE_KEY: 'k',
  })
  assert.equal(env.KEEP, '1')
  assert.equal(env.KEYBOARD_LAYOUT, 'us')
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MY_SECRET', 'GITHUB_AUTH_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'HF_TOKEN', 'DATABASE_URL', 'HUGGINGFACE_KEY']) {
    assert.equal(env[key], undefined, `${key} must not reach a child process`)
  }
})
test('runProcess: stdin, exit code, shell:false', async () => {
  const r = await runProcess({ command: 'cat', cwd: '/tmp', input: 'hello $(echo injected)' })
  assert.equal(r.stdout, 'hello $(echo injected)')
  assert.equal(r.exitCode, 0)
  const bad = await runProcess({ command: 'definitely-not-a-binary', cwd: '/tmp' })
  assert.ok(bad.spawnError)
})
test('runProcess: timeout kills process tree', async () => {
  const r = await runProcess({ command: 'node', args: ['-e', 'require("child_process").spawn("sleep",["30"],{stdio:"ignore"});setInterval(()=>{},1000)'], cwd: '/tmp', timeoutMs: 300 })
  assert.equal(r.timedOut, true)
  assert.ok(r.durationMs < 8000)
})
test('runProcess: cancellation via AbortSignal', async () => {
  const c = new AbortController()
  setTimeout(() => c.abort(), 150)
  const r = await runProcess({ command: 'sleep', args: ['30'], cwd: '/tmp', signal: c.signal })
  assert.equal(r.cancelled, true)
  const pre = new AbortController(); pre.abort()
  assert.equal((await runProcess({ command: 'sleep', args: ['1'], cwd: '/tmp', signal: pre.signal })).cancelled, true)
})
test('runProcess: output is bounded', async () => {
  const r = await runProcess({ command: 'node', args: ['-e', 'process.stdout.write("x".repeat(100000))'], cwd: '/tmp', maxOutputBytes: 1000 })
  assert.equal(r.stdout.length, 1000)
  assert.equal(r.truncated, true)
})
test('JSONL parsing separates invalid lines', () => {
  const { events, invalid } = parseJsonLines('{"a":1}\nnot json\n\n{"b":2}')
  assert.equal(events.length, 2)
  assert.equal(invalid.length, 1)
})
test('verification command policy', () => {
  const policy = resolveConfig({}).verification
  assert.deepEqual(normalizeVerificationCommand('npm test', policy).args, ['test'])
  for (const bad of ['rm -rf /', 'bash -c "x"', 'curl http://x', 'git push', 'unknowntool a', './local.sh']) assert.throws(() => normalizeVerificationCommand(bad, policy), PolicyError, bad)
})
test('path policy', () => {
  assert.equal(isPathAllowed('src/a.js'), true)
  for (const p of ['../x', '/etc/passwd', '.git/config', '.orchestrator/acceptance-criteria.md']) assert.equal(isPathAllowed(p), false, p)
  assert.equal(isPathAllowed('docs/a.md', { allowedPaths: ['src'] }), false)
})
test('billing decision never allows API/unknown by default', () => {
  const billing = resolveConfig({}).billing
  assert.equal(billingDecision({ mode: 'subscription', billing }).allowed, true)
  assert.equal(billingDecision({ mode: 'api', billing }).allowed, false)
  assert.equal(billingDecision({ mode: 'unknown', billing }).allowed, false)
})
test('command grammar', () => {
  assert.equal(parseOrchestrateInput('').action, 'help')
  assert.deepEqual(parseOrchestrateInput('status wf-1'), { action: 'status', verify: [], id: 'wf-1' })
  assert.equal(parseOrchestrateInput('cancel wf-9').id, 'wf-9')
  assert.equal(parseOrchestrateInput('budget').action, 'budget')
  const resume = parseOrchestrateInput('resume wf-9 --verify "npm test" --verify "node lint.js"')
  assert.equal(resume.action, 'resume'); assert.equal(resume.id, 'wf-9')
  assert.deepEqual(resume.verify, ['npm test', 'node lint.js'])
  const withRepo = parseOrchestrateInput('do the thing --repo /tmp/some/repo --mode fast')
  assert.equal(withRepo.action, 'run'); assert.equal(withRepo.repo, '/tmp/some/repo'); assert.equal(withRepo.mode, 'fast')
  assert.equal(withRepo.task, 'do the thing')
  const resumeNoId = parseOrchestrateInput('resume --verify npm\ test')
  assert.equal(resumeNoId.id, undefined); assert.equal(resumeNoId.verify.length, 1)
  const run = parseOrchestrateInput('Build an LRU cache --mode thorough --verify "npm test" --verify=npm run lint --no-review')
  assert.equal(run.action, 'run'); assert.equal(run.mode, 'thorough'); assert.equal(run.review, false)
  assert.deepEqual(run.verify, ['npm test', 'npm run lint'].slice(0, 1).concat(['npm']))
  assert.equal(run.task, 'Build an LRU cache run lint'.replace(' run lint', ' run lint'))
})
test('state machine transitions are validated and recorded', () => {
  const wf = { state: 'CREATED', history: [] }
  transition(wf, 'PLANNING', 'go'); transition(wf, 'IMPLEMENTING'); transition(wf, 'VERIFYING')
  assert.throws(() => transition(wf, 'PLANNING_X'), TransitionError)
  assert.equal(canTransition('COMPLETED', 'FIXING'), false)
  assert.equal(canTransition('CANCELLED', 'PLANNING'), false)
  transition(wf, 'BLOCKED', 'x'); assert.equal(wf.blockedFrom, 'VERIFYING')
  assert.equal(wf.history.length, 4)
})
test('routing presets', () => {
  assert.equal(routeFor('fast').architect, false)
  assert.equal(routeFor('fast', { review: true }).review, true)
  assert.equal(routeFor('balanced').review, true)
  assert.equal(routeFor('thorough').critique, true)
  assert.throws(() => routeFor('x'))
})

test('intent: review-style requests route to read-only review, change requests do not', async () => {
  const { looksLikeReview, explainBlocker } = await import('../src/explain.js')
  for (const t of ['审查这个插件', '帮我检查一下 src/security', 'review the auth module', '看看这段代码有什么问题']) assert.equal(looksLikeReview(t), true, t)
  for (const t of ['修复登录 bug', 'implement LRU cache', '审查并修复 redaction.js', '添加一个 FAQ']) assert.equal(looksLikeReview(t), false, t)
  const e = explainBlocker({ kind: 'no_verification', message: 'x' })
  assert.match(e.what, /验证命令/)
  assert.match(e.next, /resume|验证/)
  assert.ok(explainBlocker({ kind: 'something_new', message: 'raw' }).what.includes('raw'))
})

test('intent: English change verbs need word boundaries (address/prefix are not "add"/"fix")', async () => {
  const { looksLikeReview, explainBlocker } = await import('../src/explain.js')
  assert.equal(looksLikeReview('review the address parser'), true)
  assert.equal(looksLikeReview('看看 prefix 处理有什么问题'), true)
  assert.equal(looksLikeReview('review and fix the parser'), false)
  for (const kind of ['constructor', 'toString', '__proto__']) {
    const e = explainBlocker({ kind, message: 'raw message' })
    assert.equal(typeof e.what, 'string')
    assert.match(e.what, /raw message/)
  }
})

test('intent is three-way: nouns and negations do not force a change run', async () => {
  const { classifyIntent } = await import('../src/explain.js')
  const cases = {
    review: ['只审查，不要修改任何文件', 'review, do not fix anything', '看看 prefix 处理有什么问题', 'read-only audit of src/'],
    change: ['给 login 加上空值', 'update the config loader', '删除没用的导出', '修复登录 bug', 'implement LRU cache'],
    ambiguous: ['审查 src/foo.js 的实现', '看看这次修复有没有问题', '检查新增的代码', 'review the fix in commit abc', '给 login 加上空值检查', '审查并修复 redaction.js'],
  }
  for (const [expected, texts] of Object.entries(cases)) for (const t of texts) assert.equal(classifyIntent(t), expected, t)
})

test('intent: no recognisable signal asks instead of editing; 别 inside 识别 is not a negation', async () => {
  const { classifyIntent } = await import('../src/explain.js')
  for (const t of ['帮我看下 auth 流程', '分析这个 bug', '解释一下这个函数', 'check the parser for bugs', 'what does engine.start do']) assert.equal(classifyIntent(t), 'review', t)
  for (const t of ['弄一下 auth', 'make it faster']) assert.equal(classifyIntent(t), 'ambiguous', t)
  assert.notEqual(classifyIntent('识别修复建议'), 'review')
})
