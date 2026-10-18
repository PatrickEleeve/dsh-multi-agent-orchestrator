/** `/orchestrate` grammar (pure; unit tested). */
import { splitCommand } from './config.js'

export const SUBCOMMANDS = ['run', 'status', 'cancel', 'models', 'test-connections', 'config', 'budget', 'resume', 'approve', 'report', 'help']

/**
 * @param {string} rawInput text after "/orchestrate"
 * @returns {{action:string, task?:string, id?:string, mode?:string, verify:string[], review?:boolean}}
 */
export function parseOrchestrateInput(rawInput) {
  const input = rawInput.trim()
  if (input === '') return { action: 'help', verify: [] }
  // Tokenise once with quote support: `--verify "npm test"` must survive.
  let tokens
  try {
    tokens = splitCommand(input)
  } catch {
    tokens = input.split(/\s+/)
  }
  const [first, ...rest] = tokens
  if (SUBCOMMANDS.includes(first) && first !== 'run') {
    const out = { action: first, verify: [] }
    const id = rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined
    if (['cancel', 'resume', 'approve', 'report', 'status'].includes(first) && id) out.id = id
    if (first === 'resume') {
      for (let i = 0; i < rest.length; i++) {
        const token = rest[i]
        if (token.startsWith('--verify=')) out.verify.push(token.slice(9))
        else if (token === '--verify') out.verify.push(rest[++i] ?? '')
      }
    }
    return out
  }
  const body = first === 'run' ? tokens.slice(1) : tokens
  const out = { action: 'run', verify: [], task: '' }
  const words = []
  for (let i = 0; i < body.length; i++) {
    const token = body[i]
    if (token === '--review') out.review = true
    else if (token === '--no-review') out.review = false
    else if (token.startsWith('--mode=')) out.mode = token.slice(7)
    else if (token === '--mode') out.mode = body[++i]
    else if (token.startsWith('--repo=')) out.repo = token.slice(7)
    else if (token === '--repo') out.repo = body[++i]
    else if (token.startsWith('--verify=')) out.verify.push(token.slice(9))
    else if (token === '--verify') out.verify.push(body[++i] ?? '')
    else words.push(token)
  }
  out.task = words.join(' ').trim()
  if (out.task === '') return { action: 'help', verify: [] }
  return out
}

export const HELP = `/orchestrate <development task> [--mode fast|balanced|thorough] [--repo /path/to/repo] [--verify "npm test"]... [--review|--no-review]
/orchestrate status [workflow-id]
/orchestrate cancel <workflow-id>
/orchestrate resume [workflow-id] [--verify "npm test"]...
/orchestrate approve <workflow-id>     (thorough mode human gate)
/orchestrate report <workflow-id>
/orchestrate models
/orchestrate test-connections
/orchestrate config
/orchestrate budget
Pipeline: Claude architect (CLI) → DeepSeek implementer (DSH native child) → deterministic verification → Codex reviewer (CLI) → repair loop → delivery on an isolated branch (never merged or pushed).`
