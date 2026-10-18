/** Configuration defaults and validation (plain JS; no external schema lib). */
import os from 'node:os'
import path from 'node:path'

export const MODES = ['fast', 'balanced', 'thorough']

export const DEFAULTS = Object.freeze({
  orchestrator: {
    mode: 'balanced',
    maxFixCycles: 3,
    maxParallelWorkers: 1,
    autoMerge: false,
    autoPush: false,
    persistState: true,
    dataDir: '',
  },
  roles: {
    architect: {
      backend: 'claude-cli',
      executable: 'claude',
      model: 'opus',
      // Thorough mode runs a second, independent architecture pass. It defaults
      // to a stronger model so the design is reviewed by Opus even when the
      // first pass used a cheaper one.
      critiqueModel: 'opus',
      permissionMode: 'plan',
      timeoutMs: 15 * 60_000,
    },
    implementer: {
      backend: 'dsh-native',
      provider: 'deepseek-account',
      model: 'auto',
      reasoning: 'max',
      timeoutMs: 45 * 60_000,
    },
    reviewer: {
      backend: 'codex-cli',
      executable: 'codex',
      model: 'default',
      sandbox: 'read-only',
      timeoutMs: 15 * 60_000,
      // When Codex is rate-limited or unavailable, review with the Claude CLI
      // (subscription login) instead of blocking. Recorded and reported, never
      // silent; 'none' keeps the strict fail-closed behaviour.
      fallbackBackend: 'claude-cli',
      fallbackModel: 'opus',
    },
  },
  verification: {
    enabled: true,
    requiredBeforeReview: true,
    failClosed: true,
    autodetect: false,
    commands: [],
    allowedExecutables: ['npm', 'npx', 'node', 'pnpm', 'yarn', 'tsc', 'pytest', 'python3', 'python', 'cargo', 'go', 'make', 'ruff', 'eslint', 'mypy'],
    timeoutMs: 10 * 60_000,
  },
  billing: {
    subscriptionFirst: true,
    allowPaidApiFallback: false,
    requireExplicitApproval: true,
    maxAutomaticApiSpendUSD: 0,
    silentBackendSwitch: false,
  },
  security: {
    isolatedWorkspace: true,
    approvalForDestructiveActions: true,
    approvalForExternalPublication: true,
    credentialRedaction: true,
    automaticSelfUpdate: false,
    // Repository-relative prefixes the implementer may change. Empty = whole worktree.
    allowedPaths: [],
  },
})

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function merge(base, override) {
  if (!isObject(base)) return override === undefined ? base : override
  const out = {}
  for (const key of Object.keys(base)) out[key] = merge(base[key], isObject(override) ? override[key] : undefined)
  if (isObject(override)) for (const key of Object.keys(override)) if (!(key in base)) out[key] = override[key]
  return out
}

/**
 * Validate and normalise a raw config. Throws ConfigError listing every problem.
 * Hard invariants: no auto merge/push/self-update, no automatic API spend,
 * no silent backend switching — these cannot be enabled through config.
 */
export function resolveConfig(raw = {}) {
  const config = merge(DEFAULTS, isObject(raw) ? raw : {})
  const errors = []
  const o = config.orchestrator
  if (!MODES.includes(o.mode)) errors.push(`orchestrator.mode must be one of ${MODES.join(', ')}`)
  if (!Number.isInteger(o.maxFixCycles) || o.maxFixCycles < 0 || o.maxFixCycles > 10) errors.push('orchestrator.maxFixCycles must be an integer 0..10')
  if (o.maxParallelWorkers !== 1) errors.push('orchestrator.maxParallelWorkers must be 1 (one writer per workspace)')
  if (o.autoMerge !== false) errors.push('orchestrator.autoMerge must be false')
  if (o.autoPush !== false) errors.push('orchestrator.autoPush must be false')
  const b = config.billing
  if (b.maxAutomaticApiSpendUSD !== 0) errors.push('billing.maxAutomaticApiSpendUSD must be 0')
  if (b.silentBackendSwitch !== false) errors.push('billing.silentBackendSwitch must be false')
  if (b.allowPaidApiFallback !== false) errors.push('billing.allowPaidApiFallback must be false (no paid API backend is implemented)')
  if (config.security.automaticSelfUpdate !== false) errors.push('security.automaticSelfUpdate must be false')
  if (!Array.isArray(config.security.allowedPaths) || config.security.allowedPaths.some((p) => typeof p !== 'string')) errors.push('security.allowedPaths must be an array of repository-relative prefixes')
  if (config.security.isolatedWorkspace !== true) errors.push('security.isolatedWorkspace must be true')
  const r = config.roles
  if (r.architect.backend !== 'claude-cli') errors.push('roles.architect.backend must be claude-cli')
  if (r.implementer.backend !== 'dsh-native') errors.push('roles.implementer.backend must be dsh-native')
  if (r.reviewer.backend !== 'codex-cli') errors.push('roles.reviewer.backend must be codex-cli')
  if (r.architect.permissionMode !== 'plan') errors.push('roles.architect.permissionMode must be plan (read-only)')
  if (typeof r.architect.critiqueModel !== 'string' || r.architect.critiqueModel.trim() === '') errors.push('roles.architect.critiqueModel must be a non-empty string')
  if (r.reviewer.sandbox !== 'read-only') errors.push('roles.reviewer.sandbox must be read-only')
  if (!['claude-cli', 'none'].includes(r.reviewer.fallbackBackend)) errors.push("roles.reviewer.fallbackBackend must be 'claude-cli' or 'none' (the paid API backend cannot be a fallback)")
  if (typeof r.reviewer.fallbackModel !== 'string' || r.reviewer.fallbackModel.trim() === '') errors.push('roles.reviewer.fallbackModel must be a non-empty string')
  for (const [name, role] of Object.entries(r)) {
    if (typeof role.model !== 'string' || role.model.trim() === '') errors.push(`roles.${name}.model must be a non-empty string`)
    if (!Number.isFinite(role.timeoutMs) || role.timeoutMs < 1000) errors.push(`roles.${name}.timeoutMs must be >= 1000`)
  }
  if (!['off', 'low', 'high', 'max'].includes(r.implementer.reasoning)) errors.push('roles.implementer.reasoning must be off|low|high|max')
  if (!Array.isArray(config.verification.commands)) errors.push('verification.commands must be an array')
  else
    config.verification.commands.forEach((cmd, i) => {
      if (typeof cmd === 'string') return
      if (!isObject(cmd) || typeof cmd.command !== 'string') errors.push(`verification.commands[${i}] must be a string or {name, command, args?}`)
    })
  if (errors.length > 0) throw new ConfigError(errors)
  config.orchestrator.dataDir = o.dataDir !== '' ? o.dataDir : defaultDataDir()
  return config
}

export class ConfigError extends Error {
  constructor(errors) {
    super(`Invalid orchestrator configuration:\n- ${errors.join('\n- ')}`)
    this.name = 'ConfigError'
    this.errors = errors
  }
}

export function defaultDataDir() {
  const profile = process.env.DSH_PROFILE_DIR
  return profile ? path.join(profile, 'multi-agent-orchestrator') : path.join(os.homedir(), '.dsh', 'multi-agent-orchestrator')
}

/** Tokenise a command line into argv without a shell (supports single/double quotes). */
export function splitCommand(line) {
  const argv = []
  let current = ''
  let quote = null
  let has = false
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (has || current !== '') argv.push(current)
      current = ''
      has = false
    } else current += ch
  }
  if (quote) throw new Error('unterminated quote in command')
  if (has || current !== '') argv.push(current)
  return argv
}
