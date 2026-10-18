/**
 * Credential redaction for logs, artifacts and exported reports.
 * Redaction is defence in depth: the orchestrator never reads credential
 * files, but model/tool output may still echo secrets from the environment.
 */

const PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED:anthropic-key]'],
  [/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED:api-key]'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED:github-token]'],
  [/AKIA[0-9A-Z]{16}/g, '[REDACTED:aws-key]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED:jwt]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]'],
  [
    /((?:api[_-]?key|secret|token|password|passwd|authorization|credential)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)(?![0-9.]+[\s"',;}\]]|[0-9.]+$)[^\s"',;]{6,}/gi,
    '$1[REDACTED]',
  ],
]

/** @param {unknown} value @returns {string} */
export function redact(value) {
  let out = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** Deep-redact every string inside a JSON-like value (returns a copy). */
export function redactDeep(value) {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(redactDeep)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item)
    return out
  }
  return value
}

// Deny by shape, not by a lucky suffix: TOKEN/KEY/SECRET/PASSWORD anywhere in
// the name, plus the well-known credential DB URLs and AWS variables.
const ENV_DENY =
  /(^|_)(API_?KEY|APIKEY|AUTH|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIAL|CREDENTIALS|SESSION_COOKIE|ACCESS_KEY)(_|$)|DATABASE_URL|(^|_)AWS_(SECRET|SESSION|ACCESS)|^(GITHUB|GH|NPM|HF|HUGGINGFACE|OPENAI|ANTHROPIC|GOOGLE|AZURE)_(TOKEN|KEY)$/i

/**
 * Environment for child processes: the parent env minus every credential-like
 * variable. This also guarantees ANTHROPIC_API_KEY / OPENAI_API_KEY can never
 * silently push a CLI from subscription login onto pay-as-you-go billing.
 * @param {NodeJS.ProcessEnv} [base]
 * @param {Record<string,string>} [extra]
 */
export function sanitizedEnv(base = process.env, extra = {}) {
  const env = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || ENV_DENY.test(key)) continue
    env[key] = value
  }
  const path = env.PATH ?? ''
  const more = ['/opt/homebrew/bin', '/usr/local/bin', `${env.HOME ?? ''}/.local/bin`]
  env.PATH = [...path.split(':'), ...more.filter((entry) => !path.split(':').includes(entry))].filter(Boolean).join(':')
  return { ...env, ...extra }
}
