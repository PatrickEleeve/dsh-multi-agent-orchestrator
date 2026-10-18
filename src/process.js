/**
 * Bounded, cancellable subprocess execution. Always spawn(file, args[]) with
 * shell:false; prompts travel over stdin; the process group is terminated on
 * timeout or cancellation (killing a CLI does NOT undo filesystem changes).
 */
import { spawn } from 'node:child_process'
import { sanitizedEnv } from './security/redaction.js'

const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024

/**
 * @typedef {object} RunOptions
 * @property {string} command
 * @property {string[]} [args]
 * @property {string} cwd
 * @property {string} [input]            written to stdin then closed
 * @property {Record<string,string>} [env]  extra env (merged over sanitized env)
 * @property {number} [timeoutMs]
 * @property {AbortSignal} [signal]
 * @property {number} [maxOutputBytes]
 * @property {(line: string) => void} [onStdoutLine]
 * @property {(pid: number) => void} [onSpawn]
 */

/**
 * @param {RunOptions} options
 * @returns {Promise<{exitCode:number|null, signal:string|null, stdout:string, stderr:string, truncated:boolean, timedOut:boolean, cancelled:boolean, durationMs:number, spawnError?:string}>}
 */
export function runProcess(options) {
  const {
    command,
    args = [],
    cwd,
    input,
    env = {},
    timeoutMs = 0,
    signal,
    maxOutputBytes = DEFAULT_MAX_OUTPUT,
    onStdoutLine,
    onSpawn,
  } = options
  const started = Date.now()
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ exitCode: null, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false, cancelled: true, durationMs: 0 })
      return
    }
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let cancelled = false
    let settled = false
    let lineBuffer = ''
    let killTimer
    let timeoutTimer

    /** @type {import('node:child_process').ChildProcess} */
    let child
    try {
      child = spawn(command, args, {
        cwd,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: sanitizedEnv(process.env, env),
      })
    } catch (error) {
      resolve(result({ spawnError: String(error?.message ?? error) }))
      return
    }

    function result(extra = {}) {
      return {
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        truncated,
        timedOut,
        cancelled,
        durationMs: Date.now() - started,
        ...extra,
      }
    }
    function finish(extra) {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
      if (lineBuffer !== '' && onStdoutLine) safeLine(lineBuffer)
      resolve(result(extra))
    }
    function safeLine(line) {
      try {
        onStdoutLine?.(line)
      } catch {
        /* observer errors must not break execution */
      }
    }
    function terminate() {
      const pid = child.pid
      if (pid === undefined) return
      const send = (sig) => {
        try {
          if (process.platform !== 'win32') process.kill(-pid, sig)
          else child.kill(sig)
        } catch {
          try {
            child.kill(sig)
          } catch {
            /* already gone */
          }
        }
      }
      send('SIGTERM')
      killTimer = setTimeout(() => send('SIGKILL'), 3000)
      killTimer.unref?.()
    }
    function onAbort() {
      cancelled = true
      terminate()
    }
    function append(kind, chunk) {
      const text = chunk.toString('utf8')
      if (kind === 'out') {
        if (stdout.length < maxOutputBytes) stdout += text.slice(0, maxOutputBytes - stdout.length)
        else truncated = true
        if (onStdoutLine) {
          lineBuffer += text
          let index
          while ((index = lineBuffer.indexOf('\n')) >= 0) {
            const line = lineBuffer.slice(0, index)
            lineBuffer = lineBuffer.slice(index + 1)
            if (line.trim() !== '') safeLine(line)
          }
        }
      } else if (stderr.length < maxOutputBytes) stderr += text.slice(0, maxOutputBytes - stderr.length)
      else truncated = true
    }

    child.stdout.on('data', (chunk) => append('out', chunk))
    child.stderr.on('data', (chunk) => append('err', chunk))
    child.stdin.on('error', () => undefined)
    child.on('error', (error) => finish({ spawnError: String(error?.message ?? error) }))
    child.on('close', (code, sig) => finish({ exitCode: code, signal: sig }))
    if (child.pid !== undefined) onSpawn?.(child.pid)

    signal?.addEventListener('abort', onAbort, { once: true })
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true
        terminate()
      }, timeoutMs)
      timeoutTimer.unref?.()
    }
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

/**
 * Reconcile a child process left behind by an interrupted run (spec: recover
 * after a Desktop restart without replaying work). Only the recorded process
 * group is signalled, and only when `ps` still shows the expected executable,
 * so a recycled pid is never killed. Injected for testing.
 */
export async function terminateOrphan(active, { isAlive, commandOf, kill } = {}) {
  const pid = active?.pid
  if (!Number.isInteger(pid) || pid <= 1) return { killed: false, note: 'no recorded child process to reconcile' }
  const alive = await (isAlive ?? defaultIsAlive)(pid)
  if (!alive) return { killed: false, note: `recorded ${active.executable ?? 'child'} process ${pid} is no longer running` }
  const command = await (commandOf ?? defaultCommandOf)(pid)
  const expected = String(active.executable ?? '').trim()
  if (expected === '' || !command.toLowerCase().includes(path_basename(expected).toLowerCase())) {
    return { killed: false, note: `pid ${pid} is now running "${command.slice(0, 80)}", not ${expected || 'the recorded executable'}; left untouched` }
  }
  ;(kill ?? defaultKill)(pid)
  return { killed: true, note: `terminated the surviving ${expected} process group (pid ${pid}) left by the interrupted run` }
}

const path_basename = (p) => p.split('/').filter(Boolean).at(-1) ?? p

async function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function defaultCommandOf(pid) {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 5000 }, (error, stdout) => resolve(error ? '' : String(stdout).trim()))
  })
}

function defaultKill(pid) {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
}

/** Parse newline-delimited JSON, collecting unparseable lines separately. */
export function parseJsonLines(text) {
  const events = []
  const invalid = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      invalid.push(trimmed.slice(0, 200))
    }
  }
  return { events, invalid }
}
