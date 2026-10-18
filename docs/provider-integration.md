# Provider integration

All three adapters return the same result shape: `{ok, backend, text, model, requestedModel, modelVerified, durationMs, usage, billing, stopReason?, error?: {kind, message}}`, where `kind ∈ {auth, rate_limit, billing, unavailable, timeout, cancelled, failed}`. The engine maps `auth|rate_limit|billing|unavailable|timeout` to `BLOCKED`, `cancelled` to `CANCELLED`, and retries `failed` once.

## Claude Code CLI (Architect)

```
claude -p --model opus --permission-mode plan --output-format stream-json --verbose \
       --tools Read,Glob,Grep --strict-mcp-config --disable-slash-commands --no-session-persistence
```
Prompt on stdin. `system/init` yields the concrete model (`claude-opus-5-5` at time of writing), `apiKeySource`, the effective tool list and permission mode; `result` yields text, usage, `total_cost_usd` and `is_error`. Preflight is `claude auth status` (`authMethod: claude.ai` = subscription; `api_key` = refused). Claude Code 2.1.302 has **no** `--max-turns`; the run is bounded by `roles.architect.timeoutMs`. Optional `--effort` is exposed through `buildArgs` but not wired to config.

## Codex CLI (Reviewer)

```
codex exec --sandbox read-only --json --ephemeral --skip-git-repo-check \
           --output-last-message <tmp> [--output-schema <tmp/schema.json>] [-m <model>] -C <worktree> -
```
Prompt on stdin. JSONL events consumed: `thread.started`, `item.completed` (`agent_message`, `error`), `turn.completed` (usage), `turn.failed`. The final message is read from `--output-last-message`. Preflight is `codex login status` (`Logged in using ChatGPT` = subscription; `API key` = refused) and `codex debug models` for the catalog (`gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, ...). **The JSONL stream does not report the model**, so a Codex stage is always `modelVerified: false` unless a concrete `-m` was requested, and reports say so.

## DSH native child (Implementer)

```js
ctx.subagents.startActivation({
  provider: 'spawn',
  delivery: 'caller',
  request: { cwd, prompt: [{type:'text', text}], parent,
             agentOptions: { provider: 'deepseek-account', model, reasoningEffort: 'max' } },
  signal,
})
```
`delivery: 'caller'` returns `{childId, result, dispose}` so the orchestrator awaits the child instead of relying on a parent notice. Result `output` is the child's final assistant text, `stopReason: 'completed'` means success. The result does **not** echo the model, so identity comes from `ctx.llm.listModels(provider)` membership (`modelVerified` = catalog membership) — never from the child's prose. `roles.implementer.model: auto` resolves to the advertised id containing `1017`, else `*flash*`, else the first entry; with the current profile that is `deepseek-flash`. No token usage is exposed by the activation result; the report shows `null` rather than an estimate.

## Architecture critique model

`roles.architect.critiqueModel` (default `opus`) is used for the second architecture pass that thorough mode adds after the design. Both passes run through the Claude CLI in plan mode; the stage list records `architect:design`/`architect:critique` with their reported models, so the panel and report show exactly which model reviewed the architecture.

## Reviewer fallback (Codex → Claude CLI)

`roles.reviewer.fallbackBackend` (default `claude-cli`) is used only when the Codex CLI result is `rate_limit`, `unavailable`, `auth` or `timeout`. The same review prompt is sent to `claude -p --model <fallbackModel> --permission-mode plan --setting-sources user`; the answer is parsed by the same schema validator, so a malformed fallback review still cannot approve. The workflow records `fallbacks: [{role, from, to, reason, model}]`, the stage appears as `reviewer:fallback`, and the report/notice state the substitution. `none` keeps strict fail-closed.

## Optional Anthropic API backend (not implemented)

Deliberately absent: it is a paid path. If added later it must (1) stay disabled unless `billing.allowPaidApiFallback` is explicitly turned on by a human, (2) require an explicit per-workflow approval, (3) implement the same result shape and error kinds, and (4) never be selected automatically as a fallback. The `billingDecision()` seam already rejects `mode: 'api'` unless that flag is set.

## Adding a backend

Implement `healthCheck()`, `discoverModels()`, `execute(request, options)`, `cancel(runId)`, return the common shape, classify errors into the kinds above, and pass `options.onPid?.(pid, executable)` to `runProcess` so crash recovery can reconcile a surviving child. Register it in `src/index.js#buildRuntime`; routing presets choose stages, not backends, so no preset change is needed.
