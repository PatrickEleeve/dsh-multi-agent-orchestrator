import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = await fs.readFile(path.join(here, '..', 'client.js'), 'utf8')

/** The exact tokens `cordis_inspect_query Theme.listTokens` exposes to client plugins. */
/**
 * Tokens the shipped Harness theme actually defines (read from
 * dsh-client-ui-theme: 403 custom properties). Only semantic families are
 * allowed here; the raw `--dsw-static-*` palette is intentionally excluded so
 * the panel cannot hardcode a shade that ignores light/dark.
 */
const ALLOWED_EXACT = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-label-caption',
  '--dsw-alias-label-primary-inverted',
  '--dsw-alias-brand-primary',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-settings-card-fill',
  '--dsw-alias-settings-card-stroke',
  '--dsw-alias-scrollbar-bg-l2',
  '--dsw-alias-scrollbar-hover-l2',
  '--dsw-font-family',
  '--dsw-font-mono',
])
const ALLOWED_PREFIXES = [
  '--dsw-radius-',
  '--dsw-font-',
  '--dsw-focus-ring-',
  '--dsw-elevation-',
  '--dsw-shadow-',
  '--dsw-specific-sidebar-fill',
]
const allowed = (token) => ALLOWED_EXACT.has(token) || ALLOWED_PREFIXES.some((prefix) => (prefix.endsWith('-') ? token.startsWith(prefix) : token === prefix))

test('client styles use only the tokens the DSH theme actually exposes', () => {
  const used = new Set(source.match(/--dsw-[a-z0-9-]+/g) ?? [])
  const unknown = [...used].filter((token) => !allowed(token))
  assert.deepEqual(unknown, [], `unknown theme tokens: ${unknown.join(', ')}`)
  assert.ok(used.size >= 8, 'the panel should be themed, not unstyled')
})

test('client styles contain no hardcoded colours (theme-consistent in light and dark)', () => {
  const css = source.slice(source.indexOf('const CSS = `'), source.indexOf('`\n\n    /* ------------------------------------------------------------- panel'))
  const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
  assert.deepEqual(hex, [], `hardcoded colours: ${hex.join(', ')}`)
  const rgb = css.match(/\b(rgb|rgba|hsl|hsla)\(/g) ?? []
  assert.deepEqual(rgb, [], `hardcoded colour functions: ${rgb.join(', ')}`)
})

test('visualisations are derived from Host data, never invented', () => {
  // Pipeline status is computed per canonical step from real history/stages.
  assert.match(source, /const PIPELINE = \['PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'COMPLETED'\]/)
  assert.match(source, /function pipelineSteps\(wf\)/)
  assert.match(source, /function stageDurations\(wf\)/)
  assert.match(source, /function verificationCounts\(wf\)/)
  assert.match(source, /pipelineSteps\(detail\)/)
  assert.match(source, /pipelineSteps\(wf\)/)
  // A repair loop is shown as a repeat count, not as a duplicate filled stage.
  assert.match(source, /step\.loops > 0/)
  // The panel states what it does not know instead of guessing.
  assert.match(source, /detail\.modelUnknown/)
  assert.match(source, /paidApiCostUSD/)
  // No fake progress: the old hardcoded segment bar is gone.
  assert.doesNotMatch(source, /orch-mini/)
})
