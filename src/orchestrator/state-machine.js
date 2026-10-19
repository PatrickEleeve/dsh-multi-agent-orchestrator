/** Workflow state machine: explicit transition table, recorded history. */

export const STATES = ['CREATED', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'FIXING', 'COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED']
export const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED'])

const T = {
  CREATED: ['PLANNING', 'IMPLEMENTING', 'REVIEWING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  PLANNING: ['IMPLEMENTING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  IMPLEMENTING: ['VERIFYING', 'FIXING', 'PLANNING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  VERIFYING: ['REVIEWING', 'FIXING', 'COMPLETED', 'PLANNING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  REVIEWING: ['COMPLETED', 'FIXING', 'PLANNING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  FIXING: ['VERIFYING', 'FIXING', 'PLANNING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  // BLOCKED may be resumed into the stage it was blocked from (or cancelled).
  BLOCKED: ['CREATED', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'FIXING', 'COMPLETED', 'CANCELLED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
}

export class TransitionError extends Error {
  constructor(from, to) {
    super(`illegal workflow transition ${from} -> ${to}`)
    this.name = 'TransitionError'
  }
}

export function canTransition(from, to) {
  return (T[from] ?? []).includes(to)
}

/** Mutating transition; appends to wf.history. */
export function transition(wf, to, reason = '', detail = {}) {
  if (!canTransition(wf.state, to)) throw new TransitionError(wf.state, to)
  const now = new Date().toISOString()
  wf.history.push({ from: wf.state, to, at: now, reason, ...detail })
  if (to === 'BLOCKED') wf.blockedFrom = wf.state === 'BLOCKED' ? wf.blockedFrom : wf.state
  wf.state = to
  wf.updatedAt = now
  if (TERMINAL.has(to)) wf.finishedAt = now
  return wf
}

export function isTerminal(wf) {
  return TERMINAL.has(wf.state)
}
