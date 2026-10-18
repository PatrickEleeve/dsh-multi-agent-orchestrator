# Architecture

## Pipeline

```
/orchestrate <task>
   └─ Engine.start → worktree (branch orchestrate/<id>, base = HEAD)
        CREATED
          ├─ architect disabled (fast) ──────────────┐
          └─ PLANNING (Claude Code CLI, plan mode)  │
                architecture.md implementation-plan.md interfaces.md acceptance-criteria.md
                → artifacts stored per workflow + mirrored to <worktree>/.orchestrator/
          IMPLEMENTING (DSH native child, DeepSeek route) ──┘
                └─ no file changes → rejected as a failed attempt
          VERIFYING (local allow-listed commands, fail-closed)
                ├─ failed → FIXING (≤ maxFixCycles) → VERIFYING
                └─ passed → REVIEWING
          REVIEWING (Codex CLI, read-only, schema-validated JSON verdict)
                ├─ REQUEST_CHANGES → FIXING → VERIFYING → REVIEWING
                ├─ APPROVE → COMPLETED (commit on task branch, never merged/pushed)
                └─ BLOCKED → workflow BLOCKED
   repeated identical failure → one Architect escalation (PLANNING anew) → then BLOCKED
```

## Modules

| Module | Responsibility |
|---|---|
| `src/orchestrator/engine.js` | driver loop, stage handlers, guards, repair budget, reports, `describe()` |
| `src/orchestrator/state-machine.js` | transition table + history recording (illegal transitions throw) |
| `src/orchestrator/persistence.js` | atomic JSON per workflow, crash recovery (BLOCKED + orphan reconciliation) |
| `src/orchestrator/routing.js` | fast/balanced/thorough presets (which stages run; never which backend) |
| `src/backends/*.js` | provider adapters: claude-cli, codex-cli, dsh-native (common result shape) |
| `src/agents/*.js` | prompt construction and strict output validation (no model text is trusted) |
| `src/verification/runner.js` | run commands, record exit codes/output/test summaries, fingerprint failures |
| `src/workspace/worktree.js` | git worktree lifecycle, diff collection, commit, original-tree snapshot |
| `src/security/*` | redaction, sanitised child env, executable/path allow-lists, billing decision |
| `src/process.js` | spawn (shell:false), timeouts, process-group kill, JSONL parsing, orphan termination |
| `src/ops.js`, `src/commands.js` | user-facing operations and `/orchestrate` grammar |

## Invariants

1. A stage is complete only with real evidence: implementation requires changed files, review requires a schema-valid verdict, completion requires `verification.status ∈ {passed, skipped}` and (when routed) `review.verdict === APPROVE`.
2. The implementer can never change the specification: `.orchestrator/` hashes are checked after every implementation and restored on mismatch (recorded as a policy event). The Architect may revise them only through an escalation, which is logged.
3. The original repository is snapshotted (HEAD + porcelain status) before work and re-checked before every review/completion; a change fails closed (`isolation_violation`).
4. A backend that is unavailable, rate-limited, unauthenticated or billed per-token blocks the workflow; there is no fallback and no silent substitution.
5. Every transition and every backend call (with the actual reported model) is persisted, so a report can be rendered after a crash.
6. One workflow at a time (`maxParallelWorkers` is fixed at 1): two agents never write the same worktree.

## Web GUI panel (client half)

`client.js` is the bundle's browser half: it registers a `sidebar.panellist` entry and a `main` panel (`key: 'multi-agent-orchestrator'`) with dictionaries in the locale namespace `plugin.multi-agent-orchestrator`. It reads `GET /orchestrate-api/workflows|workflow` and writes `POST /orchestrate-api/action` (`approve`, `reject`, `cancel`, `resume`); the Host half registers that prefix route through `ctx.webServer` and applies `ctx.connection.requestRejection` as the trust fence. The panel renders only values the Host returns, and a failed fetch shows an explicit error instead of stale claims. Two Opus 5.5 design reviews drove the panel's visual rules: no boxed dashboard cards, hairline dividers, a fixed five-step pipeline with per-step status (never “active” for finished stages), real per-step durations, no fabricated progress, disclosure instead of walls of sections, and honest “not reported” values. Its styling is limited to the tokens `cordis_inspect_query Theme` exposes (a unit test fails the build if client.js references an unknown token or a hardcoded colour), and its visualisations (stage-flow graph, pass-rate bar, fix-cycle gauge, duration bars, severity chips) are derived from `history`, `verificationResults`, `stages` and `metrics`.

## Approval gate presentation

In thorough mode the engine blocks in `REVIEWING` after an `APPROVE` verdict. The plugin turns that blocked state into a `ctx.userQuestions.ask()` question addressed to the exact live root Agent that started the workflow (`src/approval.js`), so the GUI renders it as an interactive card with Approve/Reject. The question is presentation only: the engine still owns the decision, the answer maps to `engine.approve()`/`engine.cancel()`, and any failure (no answerer, dismissed card, headless host) falls back to the `orchestrate` tool or `/orchestrate approve` without changing workflow state. A superseded driver never re-writes state, and `approve`/`resume` wait for a just-blocked driver to settle so an immediate answer is not refused as "already running".

## Native Jobs + chat notices

`src/job-bridge.js` registers a running workflow as an owned background job (`kind: 'orchestrate'`, label = task) so the existing Jobs panel shows a live progress line and `job_kill` maps to workflow cancellation; the job settles with the workflow's terminal state. `src/notify.js` posts one in-chat notice per notifiable state, using the same followup/inject delivery as shipped background tools. Both are advisory: the engine exposes `observe()` observers, and every observer/bridge error is swallowed so the workflow never depends on them.

## Persistence layout

`~/.dsh/multi-agent-orchestrator/` (`orchestrator.dataDir` to override):
`workflows/<id>/state.json`, `workflows/<id>/report.md`, `workflows/<id>/artifacts/*.md`, `worktrees/<id>/`.

## Recovery

An orchestrator-internal fault blocks the workflow (kind `internal`) instead of dead-ending it, so the work is resumable after the cause is fixed.

On activation the store scans workflows. A workflow that is not terminal and not live was interrupted: surviving child pids recorded in `active` are terminated only when `ps` still shows the expected executable (pid-reuse safe), then the workflow becomes `BLOCKED` with a resume hint. `resume` re-enters the recorded stage; completed stages are not re-run, and edits already in the worktree are re-verified rather than replayed.
