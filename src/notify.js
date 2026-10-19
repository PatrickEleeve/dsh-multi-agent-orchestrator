/**
 * In-chat notifications. A workflow runs in the background, so without this the
 * user sees nothing between "started" and their next question. The notice is
 * delivered the same way shipped background tools do it: `followup()` wakes an
 * idle agent, `inject()` otherwise (see @deepseek-ai/dsh-tool-jobs).
 */
import { randomUUID } from 'node:crypto'
import { redact } from './security/redaction.js'
import { explainBlocker } from './explain.js'

const SEVERITY_ICON = { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪', info: '·' }

const ICON = { COMPLETED: '✅', BLOCKED: '⛔', FAILED: '❌', CANCELLED: '🚫' }

/** Terminal/blocked states worth a chat notice; everything else stays silent. */
export function isNotifiable(wf) {
  if (!wf || !['COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED'].includes(wf.state)) return false
  // The approval gate has its own interactive card; a notice would wake the
  // agent redundantly while that card is still unanswered.
  return !(wf.state === 'BLOCKED' && wf.blocker?.kind === 'awaiting_approval')
}

/** One compact, evidence-based notice. Never claims a model/verdict it lacks. */
export function renderWorkflowNotice(wf) {
  const icon = ICON[wf.state] ?? '•'
  const stats = [
    `verification: ${wf.verification?.status ?? 'not run'}`,
    `review: ${wf.review?.verdict ?? 'n/a'}`,
    `fix cycles: ${wf.fixCycles ?? 0}/${wf.config?.maxFixCycles ?? '-'}`,
  ].join(' · ')
  const lines = [`${icon} Orchestrator ${wf.id} — ${wf.state} (${wf.mode})`, `Task: ${wf.task}`]
  if (wf.delivery) {
    lines.push(`Branch: ${wf.delivery.branch} @ ${String(wf.delivery.commit ?? '').slice(0, 10)} (not merged or pushed)`)
    lines.push(`Files: ${wf.delivery.files.slice(0, 10).join(', ')}${wf.delivery.files.length > 10 ? ` (+${wf.delivery.files.length - 10} more)` : ''}`)
    lines.push(`Worktree: ${wf.delivery.worktree}`)
  }
  if (wf.mode === 'review' && wf.state === 'COMPLETED') {
    const findings = wf.review?.findings ?? []
    const who = (wf.reviewOutcomes ?? []).map((o) => `${o.backend}${o.model ? `(${o.model})` : ''}${o.ok ? '' : ' ✗'}`).join(' + ')
    lines.push(`Read-only review by ${who || 'reviewers'} — verdict ${wf.review?.verdict ?? 'n/a'}, ${findings.length} finding(s). Nothing was changed.`)
    if (wf.review?.summary) lines.push(wf.review.summary)
    for (const f of findings.slice(0, 15)) {
      const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '-'
      lines.push(`${SEVERITY_ICON[f.severity] ?? '•'} [${f.severity}] ${where} — ${f.description}${f.suggested_fix ? `\n    fix: ${f.suggested_fix}` : ''}${(f.reviewers ?? []).length > 1 ? '  (both reviewers)' : ''}`)
    }
    if (findings.length > 15) lines.push(`(+${findings.length - 15} more in /orchestrate report ${wf.id})`)
    const failed = (wf.reviewOutcomes ?? []).filter((o) => !o.ok)
    for (const o of failed) lines.push(`Note: ${o.backend} did not finish (${o.error}); the result above is from the other reviewer only.`)
    lines.push('Say "修复这些问题" if you want them fixed through the full pipeline.')
    return redact(lines.join('\n'))
  }
  lines.push(stats)
  if ((wf.fallbacks ?? []).length) lines.push(`Reviewer fallback: ${wf.fallbacks.map((entry) => `${entry.from}→${entry.to} (${entry.reason})`).join(', ')} — primary backend was unavailable; this is recorded, not silent.`)
  const explained = explainBlocker(wf.blocker)
  if (explained) {
    lines.push(`原因：${explained.what}`)
    lines.push(`下一步：${explained.next}`)
    lines.push(`(detail ${explained.kind}: ${wf.blocker.message})`)
  }
  if (wf.state === 'COMPLETED') lines.push('Say "merge"/"push" explicitly if you want more: the orchestrator never does either automatically.')
  return redact(lines.join('\n'))
}

export function createNoticeMessage(wf) {
  const text = renderWorkflowNotice(wf)
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'orchestrator', form: 'notice', summary: `${wf.id} ${wf.state}` },
  }
}

/**
 * Deliver one notice to the session agent. Never throws: a broken notice must
 * not disturb the workflow or the Host.
 * @returns {'woke'|'injected'|'skipped'}
 */
export function deliverNotice(agent, wf) {
  try {
    if (!isNotifiable(wf) || !agent || typeof agent.followup !== 'function') return 'skipped'
    const message = createNoticeMessage(wf)
    if (agent.status === 'idle') {
      agent.followup(message)
      return 'woke'
    }
    if (typeof agent.inject === 'function') {
      agent.inject(message)
      return 'injected'
    }
    return 'skipped'
  } catch {
    return 'skipped'
  }
}
