/** Reviewer contract: prompt, JSON schema, strict verdict validation. */
import { fence, UNTRUSTED_NOTICE } from './architect.js'

export const VERDICTS = ['APPROVE', 'REQUEST_CHANGES', 'BLOCKED']
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']

/** JSON schema handed to `codex exec --output-schema` (strict-mode compatible). */
export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'findings'],
  properties: {
    verdict: { type: 'string', enum: VERDICTS },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'category', 'file', 'line', 'description', 'suggested_fix'],
        properties: {
          severity: { type: 'string', enum: SEVERITIES },
          category: { type: 'string' },
          file: { type: ['string', 'null'] },
          line: { type: ['integer', 'null'] },
          description: { type: 'string' },
          suggested_fix: { type: ['string', 'null'] },
        },
      },
    },
  },
}

/** @param {{task:string, docs:Record<string,string>, changes:{files:string[],stat:string,diff:string}, verification:object, baseSha:string}} p */
export function buildReviewPrompt({ task, docs, changes, verification, baseSha }) {
  const vsum = verification.results.length
    ? verification.results.map((r) => `- ${r.name}: ${r.passed ? 'PASS' : 'FAIL'} (exit ${r.exitCode}, ${r.durationMs}ms)${r.testSummary ? ` tests=${JSON.stringify(r.testSummary)}` : ''}`).join('\n')
    : '(no verification evidence)'
  return `You are an INDEPENDENT CODE REVIEWER. You must not modify any file (read-only sandbox). Inspect the repository yourself (git diff ${baseSha}, changed files, surrounding code) — do not rely solely on the excerpt below.
${UNTRUSTED_NOTICE}
${fence('ORIGINAL REQUIREMENTS', task)}
${fence('ARCHITECT SPECIFICATION', Object.entries(docs).map(([k, v]) => `## ${k}\n${v.slice(0, 12000)}`).join('\n\n'))}
Changed files (${changes.files.length}):
${changes.files.map((f) => `- ${f}`).join('\n')}
${changes.stat}
${fence('GIT DIFF vs base', changes.diff)}
Deterministic verification (already executed by the orchestrator; passed means exit code 0):
${vsum}

Note: .orchestrator/ in the worktree holds the orchestrator-owned plan/acceptance documents. It is untracked by design and excluded from the delivered diff; do not report its presence as a defect and do not ask for it to be ignored, removed or hidden.

Review for: logical correctness, compliance with the architecture and acceptance criteria, edge cases, error handling, security, concurrency, resource management, performance, and test quality (are the tests meaningful, not vacuous?).
Verdict rules: APPROVE only if there are no critical/high/medium defects and acceptance criteria are met. REQUEST_CHANGES if fixable defects exist. BLOCKED only if the review cannot be done.
Respond with ONLY one JSON object, no prose, no code fences:
{"verdict":"APPROVE|REQUEST_CHANGES|BLOCKED","summary":"...","findings":[{"severity":"critical|high|medium|low|info","category":"correctness|security|...","file":"path or null","line":123,"description":"...","suggested_fix":"..."}]}`
}

/** Extract + validate. Returns {ok, review?, error?}. A malformed review never approves. */
export function parseReview(text) {
  const raw = String(text ?? '').trim()
  let candidate = raw
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) candidate = fenced[1].trim()
  if (!candidate.startsWith('{')) {
    const a = candidate.indexOf('{')
    const b = candidate.lastIndexOf('}')
    if (a >= 0 && b > a) candidate = candidate.slice(a, b + 1)
  }
  let j
  try {
    j = JSON.parse(candidate)
  } catch {
    return { ok: false, error: 'review output is not valid JSON' }
  }
  if (j === null || typeof j !== 'object') return { ok: false, error: 'review is not an object' }
  if (!VERDICTS.includes(j.verdict)) return { ok: false, error: `invalid verdict ${JSON.stringify(j.verdict)}` }
  if (typeof j.summary !== 'string') return { ok: false, error: 'summary must be a string' }
  if (!Array.isArray(j.findings)) return { ok: false, error: 'findings must be an array' }
  const findings = []
  for (const [i, f] of j.findings.entries()) {
    if (f === null || typeof f !== 'object') return { ok: false, error: `finding ${i} is not an object` }
    if (!SEVERITIES.includes(f.severity)) return { ok: false, error: `finding ${i} has invalid severity` }
    if (typeof f.description !== 'string' || f.description === '') return { ok: false, error: `finding ${i} lacks description` }
    findings.push({
      severity: f.severity,
      category: String(f.category ?? 'other'),
      file: typeof f.file === 'string' ? f.file : null,
      line: Number.isInteger(f.line) ? f.line : null,
      description: f.description,
      suggested_fix: typeof f.suggested_fix === 'string' ? f.suggested_fix : null,
    })
  }
  // Consistency guard: APPROVE cannot coexist with blocking findings.
  if (j.verdict === 'APPROVE' && findings.some((f) => ['critical', 'high'].includes(f.severity))) {
    return { ok: false, error: 'APPROVE verdict contradicts critical/high findings' }
  }
  if (j.verdict === 'REQUEST_CHANGES' && findings.length === 0) {
    return { ok: false, error: 'REQUEST_CHANGES without actionable findings' }
  }
  return { ok: true, review: { verdict: j.verdict, summary: j.summary, findings } }
}
