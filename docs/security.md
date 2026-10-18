# Security

## Assets and threats

Assets: the user's subscriptions and credentials, the original repository, the machine (subprocesses run with the user's OS identity), and the integrity of the review verdict.

Threats considered: prompt injection inside repository content or model output, credential exfiltration via child environments or logs, unintended paid API usage, destructive git operations, a review that approves without evidence, and pid-based process mistakes during recovery.

## Boundaries actually enforced

| Control | Mechanism | Where |
|---|---|---|
| Credential isolation | Child env is built from `process.env` minus every `*API_KEY`, `*AUTH_TOKEN`, `*SECRET`, `*PASSWORD`, `PRIVATE_KEY`, `*SESSION_COOKIE` | `security/redaction.js#sanitizedEnv` |
| No credential file access | The orchestrator never opens `~/.codex/auth.json`, keychains or DSH credential stores; auth is only observed through `claude auth status` / `codex login status` | `backends/*` |
| Reviewer fallback | On rate limit / unavailability the review may fall back to the Claude CLI **subscription** login only; it is recorded in `wf.fallbacks`, the stage table and the report, never twice, never to the paid API (`fallbackBackend: 'none'` disables it) | `engine.js#stageReview`, `config.js` |
| No unintended paid billing | Claude runs are rejected when `apiKeySource !== "none"`; both CLIs are refused when their login mode is API-key based; `maxAutomaticApiSpendUSD` must be 0 at config load | `security/permissions.js#billingDecision`, `backends/claude-cli.js` |
| Read-only planning/review | Claude `--permission-mode plan --tools Read,Glob,Grep --strict-mcp-config --disable-slash-commands`; Codex `--sandbox read-only --ephemeral` | `backends/claude-cli.js`, `backends/codex-cli.js` |
| Path policy | `security.allowedPaths` (repository-relative prefixes) is enforced on the changed-file list after implementation and again before commit; changes outside it fail closed | `engine.js#enforceAllowedPaths` |
| Specification integrity | SHA-256 of each architect artifact checked after implementation; mismatch → restored + violation recorded | `engine.js#guardArtifacts` |
| Original tree integrity | HEAD/status/branch snapshot compared before review and before completion; mismatch → `BLOCKED` | `engine.js#guardOriginal`, `workspace/worktree.js#originalUntouched` |
| Shared git metadata | The common `.git` dir's `info/exclude` and `config` are hashed at start; a change (worktrees share them) is detected, `info/exclude` is restored to its snapshot bytes, and the workflow blocks | `workspace/worktree.js#snapshotRepo`, `restoreInfoExclude` |
| Verification argument policy | `node -e/--eval/--print/-p`, `python -c`, and `npx` are refused, so `verify` (which a model may supply) cannot execute inline code through an allow-listed interpreter | `security/permissions.js#normalizeVerificationCommand` |
| Command execution | `spawn(file, argv, {shell:false})`, explicit cwd, executable allow-list, `sudo/rm/curl/git/...` always refused, bounded output, timeout, process-group kill | `process.js`, `security/permissions.js` |
| Prompt injection | Untrusted content is fenced with markers plus a "data, not instructions" notice; the architect output must match a strict file-wrapper grammar; the reviewer verdict must match a JSON schema and consistency rules | `agents/architect.js`, `agents/reviewer.js` |
| Verdict integrity | `APPROVE` with critical/high findings is rejected; `REQUEST_CHANGES` without findings is rejected; malformed output never approves | `agents/reviewer.js#parseReview` |
| Destructive git | The plugin only runs `worktree add`, `add`, `diff`, `commit` on a dedicated branch; `autoMerge`/`autoPush` are rejected at config load; nothing pushes or merges | `workspace/worktree.js`, `config.js` |
| Log secrecy | All persisted state, reports and captured output pass through `redact()` | `security/redaction.js` |

## Hardening from the independent code review (1.4.0)

An Opus 5.5 review of v1.3.3 reproduced these defects; each is now fixed and covered by `tests/review-regressions.test.js`:

| Defect | Fix |
|---|---|
| Two drivers could run one workflow concurrently (`resume`/`approve` checked liveness after an `await`; `launch` replaced entries) | Synchronous operation claims (`Engine.claim`) before any await, `launch` refuses a live id, two parallel `start` calls cannot pass the slot check |
| A file literally named `*` made `git add` stage `.orchestrator/` into the delivered commit | `GIT_LITERAL_PATHSPECS=1` for every git call, `--no-renames`, and a post-add assertion that refuses staged scaffolding |
| Planted `.git/hooks/pre-commit` executed at delivery | Commits use `core.hooksPath=/dev/null --no-verify`; the hooks directory is fingerprinted in the original-repo snapshot |
| Thorough mode committed whatever was in the worktree after approval | The reviewer signs a staged **tree hash**; review-time, post-review and pre-commit trees must match |
| Implementer-authored `CLAUDE.md`/`AGENTS.md`/`.claude/`/`.codex/` could steer the Architect or Reviewer | Those paths block the workflow; the reviewer prompt fences the file list; Claude runs with `--setting-sources user`, Codex with `project_doc_max_bytes=0` |
| `BLOCKED → CREATED` was illegal, so a run blocked before its worktree existed could never resume | Transition allowed; the driver re-prepares the workspace |
| `runProcess` waited for `close`, so a grandchild holding stdout hung the run | Settles on `exit` after a 500 ms grace and destroys the pipes after SIGKILL |
| `ENV_DENY` leaked `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `DATABASE_URL`, … to verification commands | Deny-by-shape regex covering TOKEN/KEY/SECRET/PASSWORD/CREDENTIAL/AWS/DATABASE_URL |
| `--name-only` followed renames, hiding deletions from `allowedPaths` | `--no-renames` on status and diffs |
| Symlinked `.orchestrator/*` or README made the orchestrator write/read outside the worktree | Writes unlink symlinks first and use `flag: 'wx'`; the README read refuses symlinks |
| Panel API served privileges when the trust fence was absent; `text/plain` POST could act | Missing fence → 503, POST requires `application/json` |
| Driver rejection could go unhandled and kill the Host | `launch` attaches `.catch` before `.finally` |
| Snapshot never refreshed, so an isolation block stayed blocked forever | Resuming an isolation block re-snapshots the original repo |

Remaining known gaps from that review (not yet fixed): per-backend abort listeners are not removed; `persist` writes are not serialised (an `onPid` save can land after a newer one); error-classification regexes are coarse; some config flags (`persistState`, `approvalFor*`, `credentialRedaction`) are accepted but unused; the panel has no resume button.

## Persistence and cleanup guarantees (1.7.0)

- State writes are serialised per workflow id (`WorkflowStore` queue), so a fire-and-forget save can never land after a newer one.
- `cancel` marks the workflow as cancelling before touching the driver; a concurrent `resume`/`approve` is refused instead of racing it.
- A completed run removes its worktree (configurable); the delivered branch keeps the commits.

## Robustness rule learned the hard way

`ctx.userQuestions` is read only through the optional `ctx.get('userQuestions')` accessor inside a `try/catch`; reading the property directly without declaring it in `inject` throws, and an unhandled rejection from a background workflow callback terminates the Host (observed once as `dsh: fatal load failure`). Every background path added by this plugin (workflow driver, approval prompt, pending-approval lookup) therefore catches its own errors and never rejects into the engine.

## Known limits (do not overstate)

- **Staging never trusts the index state.** Changed paths are read from `git status -z` and staged explicitly, so a repository or implementer rule that ignores `.orchestrator/` cannot break (or leak into) delivery — it is excluded from the diff by construction.
- **The worktree is not a sandbox.** It isolates file changes, not permissions. The DeepSeek child inherits the parent Session's sandbox policy; with this profile's `danger-full-access` it can read or write outside the worktree. The orchestrator detects the common case (original tree modified, spec rewritten) and fails closed, but it cannot prevent it. A restrictive DSH permission preset is the real control.
- **Cancellation does not revert edits.** Killing a CLI stops future writes; files already written remain.
- **Subscription limits are not budgets.** Rate-limit events are reported per stage, not converted into money.
- **Orphan reconciliation is best-effort.** It signals only the recorded process group and only when `ps` still reports the expected executable; a grandchild re-parented away from that group is not found.
- **Reviewer independence is model-level.** It is a separate process, separate login and separate context, but it reads the same worktree the implementer wrote; a sophisticated instruction embedded in a comment is still data it might obey. That is why verification evidence is required independently of the verdict.
