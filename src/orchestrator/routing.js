/** Routing presets. Backends are never substituted silently; modes only choose which stages run. */

export const PRESETS = {
  fast: { architect: false, critique: false, review: false, humanApproval: false, description: 'DeepSeek implementation + deterministic verification (review opt-in)' },
  balanced: { architect: true, critique: false, review: true, humanApproval: false, description: 'Claude architecture, DeepSeek implementation, verification, Codex review' },
  thorough: { architect: true, critique: true, review: true, humanApproval: true, description: 'Balanced + second architecture critique + human approval before commit' },
  review: { architect: false, critique: false, review: true, humanApproval: false, readOnly: true, description: 'Read-only review: Claude (Opus) and Codex read the repository directly; nothing is implemented or written' },
}

/** @param {string} mode @param {{review?:boolean}} [overrides] */
export function routeFor(mode, overrides = {}) {
  const preset = PRESETS[mode]
  if (!preset) throw new Error(`unknown mode "${mode}"`)
  return { ...preset, review: overrides.review ?? preset.review }
}
