/**
 * Deterministic verification. Commands come only from configuration or the
 * human's request (never from model output), pass the executable allow-list,
 * and run with shell:false in the isolated worktree. Evidence is recorded
 * independently of any model claim.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { runProcess } from '../process.js'
import { normalizeVerificationCommand } from '../security/permissions.js'
import { redact } from '../security/redaction.js'

const TAIL = 6000

/** Opt-in autodetect (verification.autodetect): npm scripts from the worktree's package.json. */
export async function detectCommands(cwd) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'))
    const scripts = pkg.scripts ?? {}
    return ['typecheck', 'lint', 'build', 'test'].filter((s) => typeof scripts[s] === 'string').map((s) => ({ name: `npm run ${s}`, command: 'npm', args: ['run', s, '--silent'] }))
  } catch {
    return []
  }
}

/**
 * @param {{cwd:string, specs:Array<string|object>, policy:object, signal?:AbortSignal, run?:typeof runProcess}} p
 * @returns {Promise<{status:'passed'|'failed'|'not_configured'|'cancelled', results:object[], durationMs:number}>}
 */
export async function runVerification({ cwd, specs, policy, signal, run = runProcess }) {
  const started = Date.now()
  let list = specs
  if ((!list || list.length === 0) && policy.autodetect) list = await detectCommands(cwd)
  if (!list || list.length === 0) return { status: 'not_configured', results: [], durationMs: 0 }
  const results = []
  let failed = false
  for (const spec of list) {
    const cmd = normalizeVerificationCommand(spec, policy)
    if (signal?.aborted) return { status: 'cancelled', results, durationMs: Date.now() - started }
    const out = await run({ command: cmd.command, args: cmd.args, cwd, timeoutMs: cmd.timeoutMs ?? policy.timeoutMs, signal, env: { CI: '1' } })
    if (out.cancelled) return { status: 'cancelled', results, durationMs: Date.now() - started }
    const passed = out.exitCode === 0 && !out.timedOut && !out.spawnError
    const combined = `${out.stdout}\n${out.stderr}`.trim()
    results.push({
      name: cmd.name,
      command: cmd.command,
      args: cmd.args,
      cwd,
      exitCode: out.exitCode,
      timedOut: out.timedOut,
      durationMs: out.durationMs,
      passed,
      error: out.spawnError,
      output: redact(combined.length > TAIL ? `…${combined.slice(-TAIL)}` : combined),
      testSummary: summarizeTests(combined),
    })
    if (!passed) failed = true
  }
  return { status: failed ? 'failed' : 'passed', results, durationMs: Date.now() - started }
}

/** Best-effort parse of common test-runner summaries (node:test, jest, pytest). */
export function summarizeTests(text) {
  const g = (re) => {
    const m = text.match(re)
    return m ? Number(m[1]) : undefined
  }
  const summary = {
    pass: g(/^# pass (\d+)/m) ?? g(/Tests:\s+(?:\d+ failed, )?(\d+) passed/) ?? g(/(\d+) passed/),
    fail: g(/^# fail (\d+)/m) ?? g(/Tests:\s+(\d+) failed/) ?? g(/(\d+) failed/),
  }
  return summary.pass === undefined && summary.fail === undefined ? null : summary
}

export function verificationFingerprint(verification) {
  return verification.results
    .filter((r) => !r.passed)
    .map((r) => `${r.name}:${r.exitCode}:${r.output.replace(/\d+(\.\d+)?\s?ms/g, '').replace(/\s+/g, ' ').slice(-300)}`)
    .join('|')
}
