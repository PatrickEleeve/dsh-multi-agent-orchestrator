import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = await fs.readFile(path.join(here, '..', 'client.js'), 'utf8')

/**
 * Load client.js the way the Web bundle loader does — `window.__ModuleLoader__`
 * + `require('react')` — and capture what it registers, without a browser.
 */
function loadClient() {
  let registration
  const window = { __ModuleLoader__: { load: (entry) => { registration = entry } } }
  const reactStub = {
    // A minimal but faithful hook surface: every hook the panel may use must be
    // present here, and the smoke test below actually renders it.
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => undefined],
    useEffect: () => undefined,
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    memo: (fn) => fn,
  }
  const context = vm.createContext({ window, location: { origin: 'http://127.0.0.1:1' }, document: { visibilityState: 'visible' }, console, URL, fetch: () => Promise.reject(new Error('no network in tests')) })
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.ok(registration, 'client.js must call window.__ModuleLoader__.load')
  return { registration, require: (name) => (name === 'react' ? reactStub : {}) }
}

test('client half declares its id and registers a main panel plus a sidebar entry', () => {
  const { registration, require } = loadClient()
  assert.equal(registration.id, '@local/dsh-multi-agent-orchestrator')
  const exported = registration.factory(require)
  assert.deepEqual([...exported.inject], ['slots', 'locale'])

  const registered = []
  const injected = []
  const dicts = []
  const ctx = {
    effect: (fn) => fn(),
    locale: {
      register: (ns, dictionaries) => { dicts.push([ns, dictionaries]); return () => undefined },
      bind: (ns) => (key) => `${ns}:${key}`,
    },
    slots: {
      inject: (name, callback) => { injected.push(name); callback() },
      register: (options, component) => { registered.push({ options, component }); return () => undefined },
    },
  }
  exported.apply(ctx)

  assert.deepEqual([...injected], ['main', 'sidebar.panellist'])
  const main = registered.find((r) => r.options.name === 'main')
  const sidebar = registered.find((r) => r.options.name === 'sidebar.panellist')
  assert.equal(main.options.key, 'multi-agent-orchestrator')
  assert.equal(sidebar.options.id, 'multi-agent-orchestrator')
  assert.equal(typeof main.component, 'function')
  assert.equal(typeof sidebar.component, 'function')
  assert.equal(dicts.length, 1)
  assert.equal(dicts[0][0], 'plugin.multi-agent-orchestrator')
  const zh = dicts[0][1].zh
  const en = dicts[0][1].en
  assert.deepEqual([...Object.keys(zh)].sort(), [...Object.keys(en)].sort(), 'zh and en must be key-identical')
  assert.equal(zh['panel.title'], '多模型编排器')
  assert.equal(en['panel.title'], 'Multi-Agent Orchestrator')
  assert.equal(en['action.approve'], 'Approve')
  assert.equal(sidebar.options.label(), 'plugin.multi-agent-orchestrator:panel.title')
})

test('package manifest exposes the client half to the web loader', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(here, '..', 'package.json'), 'utf8'))
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'))
  assert.ok(pkg.files.includes('client.js'))
})


test('the panel actually renders (catches missing hooks/identifiers, not just syntax)', () => {
  const { registration, require } = loadClient()
  const exported = registration.factory(require)
  const registered = []
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: () => () => undefined, bind: () => (key) => key },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => { registered.push({ options, component }); return () => undefined },
    },
  }
  exported.apply(ctx)
  for (const { options, component } of registered) {
    const element = component({ t: (key) => key })
    assert.ok(element && typeof element === 'object', `${options.name} must return an element`)
    // The empty state must name the next action rather than render nothing.
    const serialized = JSON.stringify(element, (key, value) => (typeof value === 'function' ? '[fn]' : value))
    assert.ok(serialized.length > 100, `${options.name} rendered nothing useful`)
    assert.doesNotMatch(serialized, /undefined/, `${options.name} rendered undefined content`)
  }
})


test('pipeline + duration logic is correct for real workflow shapes', () => {
  const { registration, require } = loadClient()
  const { __test } = registration.factory(require)
  const completed = {
    state: 'COMPLETED',
    history: [{ to: 'PLANNING' }, { to: 'IMPLEMENTING' }, { to: 'VERIFYING' }, { to: 'REVIEWING' }, { to: 'VERIFYING' }, { to: 'REVIEWING' }, { to: 'COMPLETED' }],
    stages: [{ role: 'architect:design', durationMs: 1000 }, { role: 'implementer', durationMs: 2000 }, { role: 'reviewer', durationMs: 500 }],
    verificationResults: [{ passed: true, durationMs: 100 }, { passed: false, durationMs: 50 }],
  }
  const steps = __test.pipelineSteps(completed)
  assert.equal(JSON.stringify(steps.map((s) => s.step)), JSON.stringify(['PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'COMPLETED']))
  assert.equal(JSON.stringify([...new Set(steps.map((s) => s.status))]), JSON.stringify(['done']))
  assert.equal(steps.find((s) => s.step === 'VERIFYING').loops, 1, 'a second verification pass is one repair loop')
  assert.equal(steps.find((s) => s.step === 'PLANNING').durationMs, 1000)
  assert.equal(steps.find((s) => s.step === 'VERIFYING').durationMs, 150)
  assert.equal(__test.formatShortDuration(1234), '1s')
  assert.equal(__test.formatShortDuration(65000), '1m05s')
  assert.equal(__test.formatShortDuration(undefined), '')

  const blocked = { state: 'BLOCKED', history: [{ to: 'PLANNING' }, { to: 'IMPLEMENTING' }, { to: 'FIXING' }], stages: [], verificationResults: [] }
  const blockedSteps = __test.pipelineSteps(blocked)
  assert.equal(blockedSteps.find((s) => s.step === 'IMPLEMENTING').status, 'failed')
  assert.equal(blockedSteps.find((s) => s.step === 'REVIEWING').status, 'pending')

  const running = { state: 'REVIEWING', history: [{ to: 'PLANNING' }, { to: 'IMPLEMENTING' }, { to: 'VERIFYING' }, { to: 'REVIEWING' }], stages: [], verificationResults: [] }
  assert.equal(__test.pipelineSteps(running).find((s) => s.step === 'REVIEWING').status, 'current')
  assert.equal(__test.verificationCounts(completed).total, 2)
  // Missing shapes must not throw: a blank panel is the worst outcome.
  assert.doesNotThrow(() => __test.pipelineSteps({ state: 'CREATED' }))
})

/** Render the panel with a seeded selection/detail (useState call order: list, selected, detail, …). */
function renderWithDetail(detail, open = {}) {
  const { registration } = loadClient()
  let calls = 0
  const seeds = { 1: detail.id, 2: detail, 8: { __for: detail.id, ...open } } // 8 = disclosure state
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => { const i = calls++; return [i in seeds ? seeds[i] : (typeof initial === 'function' ? initial() : initial), () => undefined] },
    useEffect: () => undefined,
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    memo: (fn) => fn,
  }
  const exported = registration.factory((name) => (name === 'react' ? react : {}))
  let Panel
  exported.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => undefined, bind: () => (k) => k },
    slots: { inject: (_n, cb) => cb(), register: (o, c) => { if (o.name === 'main') Panel = c; return () => undefined } },
  })
  // Resolve nested function components so their output is inspectable.
  const expand = (node) => {
    if (Array.isArray(node)) return node.map(expand)
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }))
    return { ...node, children: expand(node.children), props: { ...node.props, children: undefined } }
  }
  return JSON.stringify(expand(Panel({ t: (k) => k })), (k, v) => (typeof v === 'function' ? '[fn]' : v))
}

const base = { id: 'wf-1', task: 't', createdAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:02:00.000Z', history: [], stages: [], verificationResults: [], violations: [], reviews: [], metrics: {} }

test('review-mode detail: Review→Done track, reviewers, fixes, no verification/delivery sections', () => {
  const out = renderWithDetail({
    ...base, mode: 'review', readOnly: true, state: 'COMPLETED', review: 'REQUEST_CHANGES',
    history: [{ at: base.createdAt, from: 'CREATED', to: 'REVIEWING' }, { at: base.finishedAt, from: 'REVIEWING', to: 'COMPLETED' }],
    reviewOutcomes: [{ backend: 'claude-cli', model: 'claude-opus-5-5', ok: true }, { backend: 'codex-cli', model: null, ok: false, error: 'usage limit' }],
    findings: [{ severity: 'high', file: 'a.js', line: 3, description: 'bug', suggestedFix: 'do x', reviewers: ['claude-cli', 'codex-cli'] }],
    readOnlyCheck: { method: 'git', partial: false },
  })
  assert.doesNotMatch(out, /state\.PLANNING|state\.IMPLEMENTING|state\.VERIFYING/, 'a review never shows plan/implement/verify steps')
  assert.match(out, /state\.REVIEWING/)
  assert.match(out, /Claude ✓ · Codex ✗/)
  assert.match(out, /finding\.fixdo x/)
  assert.match(out, /finding\.both/)
  assert.match(out, /readOnly\.note/)
  assert.doesNotMatch(out, /section\.verification|section\.delivery|summary\.fix/)
  assert.doesNotMatch(out, /undefined/)
})

test('blocked detail: plain-language reason, next step and a Resume button', () => {
  const out = renderWithDetail({
    ...base, mode: 'balanced', state: 'BLOCKED', finishedAt: null,
    history: [{ at: base.createdAt, from: 'CREATED', to: 'PLANNING' }, { at: base.createdAt, from: 'PLANNING', to: 'BLOCKED' }],
    blocker: { kind: 'rate_limit', message: 'usage limit' },
    blockerExplained: { kind: 'rate_limit', what: '额度用完了', next: '恢复后继续' },
  })
  assert.match(out, /额度用完了/)
  assert.match(out, /callout\.next恢复后继续/)
  assert.match(out, /action\.resume/)
})

test('completed change run: removed worktree is stated, not offered for copying', () => {
  const out = renderWithDetail({
    ...base, mode: 'balanced', state: 'COMPLETED',
    delivery: { branch: 'orchestrate/wf-1', commit: 'abc123', files: ['a.js'], worktree: '/x/wf-1', worktreeRemoved: true },
  }, { delivery: true })
  assert.match(out, /delivery\.worktreeRemoved/)
  assert.doesNotMatch(out, /\/x\/wf-1/)
})
