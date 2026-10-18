import test from 'node:test'
import assert from 'node:assert/strict'
import { isNotifiable, renderWorkflowNotice, createNoticeMessage, deliverNotice } from '../src/notify.js'
import { progressLine } from '../src/orchestrator/engine.js'

const completed = {
  id: 'wf-abc123', state: 'COMPLETED', mode: 'balanced', task: 'build x', fixCycles: 1,
  config: { maxFixCycles: 3 }, verification: { status: 'passed' }, review: { verdict: 'APPROVE' },
  delivery: { branch: 'orchestrate/wf-abc123', commit: 'deadbeefcafe1234', files: ['a.js', 'b.js'], worktree: '/w' },
}
test('notifications only for terminal states, and never for the approval gate', () => {
  assert.equal(isNotifiable(completed), true)
  assert.equal(isNotifiable({ ...completed, state: 'REVIEWING' }), false)
  assert.equal(isNotifiable({ ...completed, state: 'BLOCKED', blocker: { kind: 'awaiting_approval' } }), false)
  assert.equal(isNotifiable({ ...completed, state: 'BLOCKED', blocker: { kind: 'repair_exhausted' } }), true)
  assert.equal(isNotifiable(undefined), false)
})
test('notice states real evidence and never invents a verdict', () => {
  const text = renderWorkflowNotice(completed)
  assert.match(text, /✅ Orchestrator wf-abc123 — COMPLETED/)
  assert.match(text, /orchestrate\/wf-abc123 @ deadbeefca/)
  assert.match(text, /verification: passed · review: APPROVE · fix cycles: 1\/3/)
  assert.match(text, /not merged or pushed/)
  const blocked = renderWorkflowNotice({ ...completed, state: 'BLOCKED', delivery: undefined, blocker: { kind: 'rate_limit', message: 'usage limit' } })
  assert.match(blocked, /⛔/)
  assert.match(blocked, /Blocker \(rate_limit\): usage limit/)
  const missing = renderWorkflowNotice({ ...completed, review: null, verification: null, delivery: undefined })
  assert.match(missing, /verification: not run · review: n\/a/)
})
test('notice message shape is a user-role notice and is redacted', () => {
  const message = createNoticeMessage({ ...completed, task: 'use sk-ant-abcdefghijklmnopqrstuvwxyz' })
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'orchestrator')
  assert.equal(typeof message.id, 'string')
  assert.doesNotMatch(message.content[0].text, /sk-ant-abcdef/)
})
test('delivery wakes an idle agent, injects into a busy one, and never throws', () => {
  const calls = []
  const idle = { status: 'idle', followup: (m) => calls.push(['followup', m]), inject: (m) => calls.push(['inject', m]) }
  assert.equal(deliverNotice(idle, completed), 'woke')
  assert.equal(calls[0][0], 'followup')
  const busy = { status: 'running', followup: (m) => calls.push(['followup', m]), inject: (m) => calls.push(['inject', m]) }
  assert.equal(deliverNotice(busy, completed), 'injected')
  assert.equal(calls.at(-1)[0], 'inject')
  assert.equal(deliverNotice(busy, { ...completed, state: 'REVIEWING' }), 'skipped')
  assert.equal(deliverNotice(undefined, completed), 'skipped')
  assert.equal(deliverNotice({ status: 'idle' }, completed), 'skipped')
  const broken = { status: 'idle', followup: () => { throw new Error('boom') } }
  assert.equal(deliverNotice(broken, completed), 'skipped')
})
test('progress line summarizes the real transition path', () => {
  const wf = {
    history: [{ to: 'PLANNING' }, { to: 'IMPLEMENTING' }, { to: 'VERIFYING' }, { to: 'FIXING' }, { to: 'VERIFYING' }, { to: 'COMPLETED' }],
    stages: [{ role: 'architect:design', ok: true }, { role: 'implementer', ok: true }, { role: 'implementer:fix', ok: false }],
  }
  const line = progressLine(wf)
  assert.match(line, /PLANNING → IMPLEMENTING → VERIFYING → FIXING → COMPLETED/)
  assert.match(line, /implementer:fix\(failed\)/)
})
