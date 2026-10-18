# DSH Multi-Agent Orchestrator (`@local/dsh-multi-agent-orchestrator`)

`/orchestrate <task> [--mode fast|balanced|thorough] [--repo /path/to/repo] [--verify "npm test"] [--review|--no-review]`
plus `status|cancel|resume|approve|report|models|test-connections|config` (same operations as the `orchestrate` agent tool).

By default the target is the chat's working directory, which must be a git repository (the isolated worktree is the isolation boundary). `--repo <path>` (tool field `repo`) points a run at a different repository; a non-git target is rejected immediately with an actionable message. Pipeline: Claude Opus (CLI, plan mode, read-only) → DeepSeek native child (isolated worktree `orchestrate/<id>`) → deterministic verification (explicit allow-listed commands, fail-closed) → Codex CLI (read-only, schema-validated verdict) → bounded repair loop (default 3, no-progress detection, one Architect escalation) → commit on the task branch. Never merges, pushes, or falls back to paid APIs.

Security/billing: child env strips credential variables; CLIs are refused unless login is subscription mode; no credential files are read; state/reports are redacted; the implementer cannot rewrite the specification (`.orchestrator/` hashes are verified and restored) and the original working tree is snapshotted and re-checked.

Docs: [architecture](docs/architecture.md) · [security](docs/security.md) · [provider integration](docs/provider-integration.md) · [compatibility report](docs/compatibility-report.md) · [example config](examples/config.yaml).
Data: `~/.dsh/multi-agent-orchestrator/{workflows,worktrees}`. Tests: `npm test` (56 unit/integration tests, no paid model calls).
## Panel in the Web GUI

A sidebar entry **「多模型编排器 / Multi-Agent Orchestrator」** opens a panel with real visualisations built from Host data only:

- a 264px navigation list (no boxes, hairline dividers) with one muted status line per row: state · mode · duration · verification `3/4` · review verdict;
- a **stage pipeline** for the five canonical steps with real per-step status (filled = done, brand ring = current, ✕ = failed, hollow = not reached), real stage durations underneath, and repair loops as a single `↻N` badge instead of duplicated nodes;
- a four-metric summary strip (duration · verification n/m · review verdict + finding count · fix cycles);
- findings first, as rows with a 2px severity edge, the description, and `file:line` in monospace;
- disclosure sections (verification, stage runs, delivery, timeline, usage & cost, policy) that open automatically when they matter — verification when something failed, delivery when the run completed;
- stage runs as an aligned grid (role · backend · reported model · duration bar · time), tokens and costs with an explicit “not reported” instead of a fabricated `$0`.

Design rules (from two Opus 5.5 design reviews): 4/8/12/16/24 spacing, an 11/12/13/15 type scale, 0.5px hairline dividers instead of nested borders, tinted chips via `color-mix` on theme tokens, brand colour only for “live now / you can act”, no invented progress (the workflow list carries real `visited`/`verificationCounts` data from the Host), one abortable poll loop with exponential backoff, and the stylesheet injected once for the bundle's lifetime. **Approve / Reject** buttons drive the thorough-mode gate, and **Cancel** stops a running or blocked workflow — all through the Host `GET/POST /orchestrate-api` routes (same-origin, behind the composition's trust fence). The panel polls every 3 s; nothing it shows is inferred client-side.

## Where to watch a run

- **Chat notice** when it finishes (completed / blocked / failed / cancelled), with branch, commit, files, verification, review verdict and the blocker if any.
- **Jobs panel**: each workflow registers as a native background job (`orchestrate-<id>`) with a live progress line such as `balanced: IMPLEMENTING · implementer (dsh-native) · 2 stages done`. The shipped job tools read its log (`job_output`) and stop it (`job_kill`), which cancels the workflow.
- **`/orchestrate status [id]`** prints the stage timeline; the id is optional.

## Approving a workflow (thorough mode)

Thorough mode stops before committing and asks you **in the chat**: a question card shows the branch, changed files, verification result, review verdict and findings, with **Approve** / **Reject**. No workflow id and no slash command is needed. If the card cannot be shown (no UI attached), the same gate is reachable from plain language via the `orchestrate` tool (`action: approve|reject`) or `/orchestrate approve` — the id is optional there too: it targets the newest workflow awaiting approval.

## Limitations

- The Anthropic API backend is not implemented (paid path, disabled by design).
- Codex and the DeepSeek child runtime do not echo the model they used; those stages are reported as unverified unless a concrete model was requested (Codex) or found in the provider catalog (DeepSeek).
- The DeepSeek child inherits the Session's permissions: with `danger-full-access` the worktree is isolation, not a sandbox. The orchestrator detects and fails closed on the common violations, but cannot prevent them; use a restrictive DSH permission preset.
- Cancelling stops processes; it does not revert file edits already made in the worktree.
- Recovery kills a surviving child only when `ps` still shows the recorded executable; a grandchild that left the process group is not found.
- Subscription rate limits are reported per stage, never converted into monetary budget.
