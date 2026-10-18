/**
 * Security policy: real boundaries come from CLI sandbox flags, process
 * isolation and approval gates. The checks here are additional guards for the
 * parts the orchestrator itself executes (verification commands, paths).
 */
import path from 'node:path'
import { splitCommand } from '../config.js'

const NEVER = new Set(['sudo', 'su', 'rm', 'rmdir', 'dd', 'mkfs', 'chmod', 'chown', 'curl', 'wget', 'ssh', 'scp', 'sh', 'bash', 'zsh', 'git'])

/**
 * Normalise a verification command spec into {name, command, args, timeoutMs?}.
 * Executable must be on the allow-list; shell interpreters and destructive
 * tools are always refused. Commands originate from config or the human's
 * request, never from model output.
 */
export function normalizeVerificationCommand(spec, policy) {
  let command
  let args
  let name
  let timeoutMs
  if (typeof spec === 'string') {
    const argv = splitCommand(spec)
    if (argv.length === 0) throw new PolicyError('empty verification command')
    ;[command, ...args] = argv
    name = spec
  } else {
    command = spec.command
    args = Array.isArray(spec.args) ? spec.args.map(String) : []
    name = spec.name ?? [command, ...args].join(' ')
    timeoutMs = spec.timeoutMs
  }
  const exe = path.basename(command)
  if (NEVER.has(exe)) throw new PolicyError(`executable "${exe}" is never permitted for verification`)
  if (!policy.allowedExecutables.includes(exe)) throw new PolicyError(`executable "${exe}" is not in verification.allowedExecutables`)
  if (command.includes('/') && !path.isAbsolute(command)) throw new PolicyError('relative executable paths are not permitted')
  return { name, command, args, timeoutMs }
}

export class PolicyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PolicyError'
  }
}

/** Reject paths escaping the workspace or touching protected locations. */
export function isPathAllowed(relPath, { allowedPaths = [] } = {}) {
  const normalized = path.posix.normalize(relPath.replaceAll('\\', '/'))
  if (normalized.startsWith('../') || normalized === '..' || path.isAbsolute(normalized)) return false
  if (normalized === '.git' || normalized.startsWith('.git/')) return false
  if (normalized === '.orchestrator' || normalized.startsWith('.orchestrator/')) return false
  if (allowedPaths.length === 0) return true
  return allowedPaths.some((prefix) => normalized === prefix || normalized.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))
}

/** Billing guard shared by the CLI backends. */
export function billingDecision({ mode, billing }) {
  // mode: 'subscription' | 'api' | 'unknown'
  if (mode === 'subscription') return { allowed: true }
  if (mode === 'api' && billing.allowPaidApiFallback === true) return { allowed: true, warning: 'paid API billing explicitly enabled' }
  if (mode === 'api') return { allowed: false, reason: 'backend would use pay-as-you-go API billing; explicit user authorization is required' }
  return { allowed: false, reason: 'authentication mode could not be determined; refusing to risk unexpected API charges until confirmed' }
}
