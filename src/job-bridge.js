/**
 * DSH Jobs bridge: a running workflow is also a native background job, so it
 * appears in the existing Jobs panel with a live progress line, is readable
 * through the shipped job tools, and can be stopped with job_kill. The bridge
 * is strictly advisory: every failure is swallowed and the workflow keeps
 * running even if the jobs service is absent or rejects the registration.
 */
import { renderWorkflowNotice } from './notify.js'

const TERMINAL = new Set(['COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED'])

/** Compact progress line for the Jobs panel. */
export function jobProgress(wf) {
  if (!wf) return 'starting'
  if (wf.state === 'BLOCKED' && wf.blocker?.kind === 'awaiting_approval') return `${wf.mode}: awaiting your approval`
  const active = wf.active ? ` · ${wf.active.role} (${wf.active.backend})` : ''
  const done = (wf.stages ?? []).length
  return `${wf.mode}: ${wf.state}${active}${done > 0 ? ` · ${done} stage${done === 1 ? '' : 's'} done` : ''}`
}

function outcomeFor(wf) {
  const result = renderWorkflowNotice(wf)
  if (wf.state === 'COMPLETED') return { status: 'completed', detail: `delivered on ${wf.delivery?.branch ?? 'task branch'}`, result }
  if (wf.state === 'CANCELLED') return { status: 'killed', detail: 'workflow cancelled', result }
  return { status: 'failed', detail: wf.blocker?.kind ?? wf.state, result }
}

/**
 * Register the workflow as an owned background job. Never throws.
 * @param {{jobs:any, engine:any, wf:object, sessionId:string}} p
 * @returns {string|undefined} job id when registered
 */
export function attachWorkflowJob({ jobs, engine, wf, sessionId }) {
  try {
    if (!jobs || typeof jobs.start !== 'function' || typeof engine?.observe !== 'function') return undefined
    if (!sessionId || !wf?.id || TERMINAL.has(wf.state)) return undefined
    let handle
    let settled = false
    let resolveDone
    const done = new Promise((resolve) => {
      resolveDone = resolve
    })
    const seen = new Set((wf.history ?? []).map((h) => `${h.at}:${h.to}`))
    const finish = () => {
      if (settled) return
      settled = true
      try {
        unsubscribe()
      } catch {
        /* ignore */
      }
      resolveDone(outcomeFor(wf))
    }
    const unsubscribe = engine.observe((next) => {
      if (settled || next?.id !== wf.id) return
      Object.assign(wf, next)
      try {
        handle?.updateProgress(jobProgress(next))
      } catch {
        /* panel-only */
      }
      for (const h of next.history ?? []) {
        const key = `${h.at}:${h.to}`
        if (seen.has(key)) continue
        seen.add(key)
        try {
          handle?.append(`${h.at} ${h.from} → ${h.to}: ${h.reason}\n`)
        } catch {
          /* panel-only */
        }
      }
      if (TERMINAL.has(next.state)) finish()
    })
    return jobs.start({
      kind: 'orchestrate',
      label: wf.task.slice(0, 120),
      owner: sessionId,
      run: (jobHandle) => {
        handle = jobHandle
        try {
          jobHandle.updateProgress(jobProgress(wf))
          jobHandle.append(`workflow ${wf.id} started (${wf.mode})\nrepository: ${wf.repo}\n`)
        } catch {
          /* panel-only */
        }
        return {
          cancel: () => {
            void Promise.resolve(engine.cancel(wf.id)).catch(() => undefined)
          },
          done,
        }
      },
    })
  } catch {
    return undefined
  }
}
