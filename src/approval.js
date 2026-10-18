/**
 * Human approval gate presentation. The gate itself lives in the engine
 * (thorough mode blocks before committing); this module turns the blocked
 * workflow into a question the GUI can render and maps the answer back to an
 * approve/reject decision, so the user never has to type a workflow id.
 */

/** @param {object} wf blocked workflow (blocker.kind === 'awaiting_approval') */
export function approvalQuestion(wf) {
  const files = wf.changes?.files ?? []
  const findings = wf.review?.findings ?? []
  const verification = wf.verification
  const lines = [
    `Branch: ${wf.workspace?.branch ?? '-'}`,
    `Changed files (${files.length}): ${files.slice(0, 12).join(', ')}${files.length > 12 ? ` (+${files.length - 12} more)` : ''}`,
    `Verification: ${verification?.status ?? 'not run'}${
      verification?.results?.length ? ` — ${verification.results.map((r) => `${r.name}: ${r.passed ? 'pass' : 'FAIL'}`).join(', ')}` : ''
    }`,
    `Review: ${wf.review?.verdict ?? 'n/a'} — ${wf.review?.summary ?? ''}`,
    findings.length > 0 ? `Findings: ${findings.map((f) => `[${f.severity}] ${f.description}`).join(' | ').slice(0, 800)}` : 'Findings: none',
    'Approving commits the task branch; nothing is merged or pushed. Rejecting cancels the workflow and keeps the worktree for inspection.',
  ]
  return {
    id: 'approval',
    header: 'Approve delivery?',
    question: `Workflow ${wf.id} (${wf.mode}) passed deterministic verification and independent review. Commit the task branch?`,
    detail: lines.join('\n'),
    options: [
      { label: 'Approve', description: 'Commit the task branch (never merged or pushed)' },
      { label: 'Reject', description: 'Cancel the workflow and keep the worktree for inspection' },
    ],
  }
}

/** @returns {'approve'|'reject'|'unknown'} */
export function interpretApproval(answer) {
  const first = answer?.answers?.[0]
  const label = (first?.custom?.trim() || first?.selected?.[0] || '').trim()
  if (/^approve\b/i.test(label)) return 'approve'
  if (/^reject\b/i.test(label)) return 'reject'
  return 'unknown'
}

/**
 * Ask once per blocked workflow and apply the answer through the engine.
 * Any failure (no answerer, no live root agent, dismissed card) is swallowed:
 * the `/orchestrate approve` command and the `orchestrate` tool remain usable.
 *
 * @param {{wf:object, ask?:Function, engine:object, agent:any, log?:(m:string)=>void}} p
 * @returns {Promise<'approved'|'rejected'|'skipped'>}
 */
export async function promptApproval({ wf, ask, engine, agent, log }) {
  if (wf?.state !== 'BLOCKED' || wf.blocker?.kind !== 'awaiting_approval' || typeof ask !== 'function' || !agent) return 'skipped'
  try {
    const answer = await ask({ agent, questions: [approvalQuestion(wf)] })
    const decision = interpretApproval(answer)
    if (decision === 'approve') {
      await engine.approve(wf.id, agent)
      return 'approved'
    }
    if (decision === 'reject') {
      await engine.cancel(wf.id)
      return 'rejected'
    }
    log?.('approval card dismissed without a decision')
    return 'skipped'
  } catch (error) {
    log?.(`approval prompt unavailable (${error?.code ?? error?.message ?? error}); use the orchestrate approve tool or command`)
    return 'skipped'
  }
}
