# Compatibility report (verified locally, 2026-10-17)

Environment: macOS 27.0.1 arm64, Node 26.3.1, DSH Desktop (profile `desktop`), Claude Code 2.1.302, codex-cli 0.163.0.

| Capability | Finding | Used |
|---|---|---|
| Plugin format | Bundle (`dsh.bundle.patch`) + Host ESM `apply(ctx, config)`; no build step | yes |
| Commands | `ctx.commands.register({name, handler})` → `/orchestrate` | yes |
| Tools | `ctx.tools.register` → model tool `orchestrate` | yes |
| Native DeepSeek child | `ctx.subagents.startActivation({provider:'spawn', delivery:'caller', request:{agentOptions}})`; real child session, route `deepseek-account/deepseek-flash`, reasoning `max` | yes (verified live) |
| Model identity (DeepSeek) | result does not echo the model; catalog membership checked via `ctx.llm.listModels`. No "V4.1-Flash-1017" id exists locally; `auto` resolves to `deepseek-flash` | limitation |
| Claude CLI | `claude -p --model opus --permission-mode plan --output-format stream-json --verbose --tools Read,Glob,Grep --strict-mcp-config --disable-slash-commands --no-session-persistence`; init event reports `claude-opus-5-5`, `apiKeySource:"none"`, `authMethod: claude.ai` | yes. No `--max-turns` flag in 2.1.302 → bounded by timeout |
| Codex CLI | `codex exec --sandbox read-only --json --ephemeral --output-last-message --output-schema -C <dir> -`; `codex login status` = ChatGPT; `codex debug models` lists catalog (gpt-6.1-sol, gpt-6-astra, ...) | yes. JSONL does not report the model → "unverified" |
| Web UI panel | Client half registers `sidebar.panellist` + `main` slots; Host serves the same `/orchestrate-api` prefix from a `ctx.inject(['webServer'], …)` callback, because activation order is not guaranteed and a service read at activation time returned undefined (observed as HTTP 404 in the panel until fixed) |
| Web UI panel (detail) | Client half registers `sidebar.panellist` + `main` slots; Host serves `/orchestrate-api` behind `ctx.connection.requestRejection` |
| Persistence | local JSON per workflow under `~/.dsh/multi-agent-orchestrator` (Host has no `DSH_PROFILE_DIR`); `dataDir` configurable | yes |
| Anthropic API backend | intentionally NOT implemented (paid; disabled by design) | no |
| Not used | `workflowEngine`, `ctx.worktrees` (plain `git worktree` gives exact control of branch/base) | no |

Crash recovery: on activation, non-terminal workflows are reconciled (recorded child pid is signalled only when `ps` still shows the expected executable) and marked BLOCKED with a resume hint; no stage is replayed.

`/orchestrate status` was executed live from the Web GUI composer on 2026-10-17 and returned the three completed workflows, so the native slash-command surface (`ctx.commands.register`) is verified end to end, not only by unit test.

Live `/orchestrate test-connections` (2026-10-17, after the `--skip-git-repo-check` fix): claude CLI+auth PASS, claude authenticated execution PASS (`claude-opus-5-5`, apiKeySource none, plan mode, Read/Glob/Grep), codex CLI+auth PASS, codex model catalog PASS, codex read-only execution PASS, deepseek native runtime PASS, deepseek independent child PASS (child session id, stopReason completed).

Fast mode never runs the Architect, so the implementer prompt omits the `.orchestrator/` requirement instead of pointing at documents that do not exist (unit tested).

Jobs/notices: workflows register through `ctx.get('jobs')` with a custom kind (the registry validates only non-empty kind/label, not the kind set), so they appear in the shipped Jobs panel and settle into the shipped completion notice; `agent.followup`/`agent.inject` deliver the chat notice. Covered by unit tests; live panel rendering is verified by starting a run and reading `job_list`.

Approval UX: the thorough-mode gate is presented through `ctx.userQuestions.ask()` (Host service `user-questions`); the request shape was read from the installed package and covered by unit tests with a mocked answerer. Live GUI rendering of that card is verified only when a thorough run is answered from the chat. Incident 2026-10-17: the first card implementation read `ctx.userQuestions` without declaring it in `inject`, the resulting unhandled rejection killed the Host (crash log `crash-2026-10-17T19-40-20-316Z-host.log`); the accessor is now `ctx.get(...)` inside try/catch and every background callback resolves instead of rejecting. Pending gates are re-offered on the next agent interaction after a restart.

Client panel incidents: (1) the first panel build read `ctx.userQuestions` without `inject` and crashed the Host — fixed with `ctx.get` in try/catch; (2) a later build used `useMemo` without importing it, so the panel rendered blank — fixed, and `tests/client.test.js` now renders every registered component with a stubbed React so a missing hook or identifier fails the suite instead of the UI. Client changes need an app restart to be rebuilt into the web bundle.

No-verification blocks are recoverable without editing config: `resume` accepts `--verify "…"` (tool action `resume` takes `verify`), validates against the same allow-list, and persists the commands into the workflow. Covered by an engine test and an ops-layer test.

Target selection: `--repo <path>` / tool field `repo` (absolute, or relative to the chat directory) overrides the session working directory; a non-git path is rejected before a workflow is created. Covered by command-grammar, engine and ops tests.

Independent code review of v1.3.3 (Opus 5.5) produced 5 Critical + 8 High findings; all are fixed in 1.4.0 with regression tests (`tests/review-regressions.test.js`) except the lesser items listed in docs/security.md.

Reviewer fallback: `codex-cli` rate-limit/auth/unavailable/timeout now falls back once to the subscribed Claude CLI, recorded in `wf.fallbacks` + stage `reviewer:fallback` + report/notice; `fallbackBackend: 'none'` keeps fail-closed. Unit-tested both ways.

Architecture review model: `roles.architect.critiqueModel` (default `opus`) drives thorough mode's second architecture pass, independent from `roles.architect.model`; live verification pending a thorough run in which `architect:design` and `architect:critique` report different models.

1.7.0 hardening: verification args refuse inline evaluation (`node -e`, `python -c`) and `npx`; persistence writes are serialised per workflow; cancel cannot be raced by resume/approve; completed runs remove their worktree (`removeWorktreeOnSuccess`); `/orchestrate budget` aggregates real spend/usage. All covered by tests (110).

Not verified: DSH-level sandbox restriction of the native child (profile runs danger-full-access; child inherits parent permissions). Mitigation: post-run checks that the original repo is untouched and `.orchestrator/` spec is intact; worktree is not a security sandbox.
