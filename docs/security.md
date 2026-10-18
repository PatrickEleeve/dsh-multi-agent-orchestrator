# Security

## Assets and threats

Assets: the user's subscriptions and credentials, the original repository, the machine (subprocesses run with the user's OS identity), and the integrity of the review verdict.

Threats considered: prompt injection inside repository content or model output, credential exfiltration via child environments or logs, unintended paid API usage, destructive git operations, a review that approves without evidence, and pid-based process mistakes during recovery.

## Boundaries actually enforced

| Control | Mechanism | Where |
|---|---|---|
| Credential isolation | Child env is built from `process.env` minus every `*API_KEY`, `*AUTH_TOKEN`, `*SECRET`, `*PASSWORD`, `PRIVATE_KEY`, `*SESSION_COOKIE` | `security/redaction.js#sanitizedEnv` |
| No credential file access | The orchestrator never opens `~/.codex/auth.json`, keychains or DSH credential stores; auth is only observed through `claude auth status` / `codex login status` | `backends/*` |
| No unintended paid billing | Claude runs are rejected when `apiKeySource !== "none"`; both CLIs are refused when their login mode is API-key based; `maxAutomaticApiSpendUSD` must be 0 at config load | `security/permissions.js#billingDecision`, `backends/claude-cli.js` |
| Read-only planning/review | Claude `--permission-mode plan --tools Read,Glob,Grep --strict-mcp-config --disable-slash-commands`; Codex `--sandbox read-only --ephemeral` | `backends/claude-cli.js`, `backends/codex-cli.js` |
| Path policy | `security.allowedPaths` (repository-relative prefixes) is enforced on the changed-file list after implementation and again before commit; changes outside it fail closed | `engine.js#enforceAllowedPaths` |
| Specification integrity | SHA-256 of each architect artifact checked after implementation; mismatch → restored + violation recorded | `engine.js#guardArtifacts` |
| Original tree integrity | HEAD/status/branch snapshot compared before review and before completion; mismatch → `BLOCKED` | `engine.js#guardOriginal`, `workspace/worktree.js#originalUntouched` |
| Shared git metadata | The common `.git` dir's `info/exclude` and `config` are hashed at start; a change (worktrees share them) is detected, `info/exclude` is restored to its snapshot bytes, and the workflow blocks | `workspace/worktree.js#snapshotRepo`, `restoreInfoExclude` |
| Command execution | `spawn(file, argv, {shell:false})`, explicit cwd, executable allow-list, `sudo/rm/curl/git/...` always refused, bounded output, timeout, process-group kill | `process.js`, `security/permissions.js` |
| Prompt injection | Untrusted content is fenced with markers plus a "data, not instructions" notice; the architect output must match a strict file-wrapper grammar; the reviewer verdict must match a JSON schema and consistency rules | `agents/architect.js`, `agents/reviewer.js` |
| Verdict integrity | `APPROVE` with critical/high findings is rejected; `REQUEST_CHANGES` without findings is rejected; malformed output never approves | `agents/reviewer.js#parseReview` |
| Destructive git | The plugin only runs `worktree add`, `add`, `diff`, `commit` on a dedicated branch; `autoMerge`/`autoPush` are rejected at config load; nothing pushes or merges | `workspace/worktree.js`, `config.js` |
| Log secrecy | All persisted state, reports and captured output pass through `redact()` | `security/redaction.js` |

## Robustness rule learned the hard way

`ctx.userQuestions` is read only through the optional `ctx.get('userQuestions')` accessor inside a `try/catch`; reading the property directly without declaring it in `inject` throws, and an unhandled rejection from a background workflow callback terminates the Host (observed once as `dsh: fatal load failure`). Every background path added by this plugin (workflow driver, approval prompt, pending-approval lookup) therefore catches its own errors and never rejects into the engine.

## Known limits (do not overstate)

- **Staging never trusts the index state.** Changed paths are read from `git status -z` and staged explicitly, so a repository or implementer rule that ignores `.orchestrator/` cannot break (or leak into) delivery — it is excluded from the diff by construction.
- **The worktree is not a sandbox.** It isolates file changes, not permissions. The DeepSeek child inherits the parent Session's sandbox policy; with this profile's `danger-full-access` it can read or write outside the worktree. The orchestrator detects the common case (original tree modified, spec rewritten) and fails closed, but it cannot prevent it. A restrictive DSH permission preset is the real control.
- **Cancellation does not revert edits.** Killing a CLI stops future writes; files already written remain.
- **Subscription limits are not budgets.** Rate-limit events are reported per stage, not converted into money.
- **Orphan reconciliation is best-effort.** It signals only the recorded process group and only when `ps` still reports the expected executable; a grandchild re-parented away from that group is not found.
- **Reviewer independence is model-level.** It is a separate process, separate login and separate context, but it reads the same worktree the implementer wrote; a sophisticated instruction embedded in a comment is still data it might obey. That is why verification evidence is required independently of the verdict.
