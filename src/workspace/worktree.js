/**
 * Workspace manager: isolated Git worktree on a dedicated task branch.
 * Never touches the original working tree, never pushes, never merges.
 * A worktree is NOT a security sandbox: it isolates file changes only.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { runProcess } from '../process.js'

const hash = (text) => createHash('sha256').update(text).digest('hex')

const ORCH_DIR = '.orchestrator'

export class Git {
  constructor(run = runProcess) {
    this.run = run
  }
  async exec(cwd, args, { allowFail = false, input } = {}) {
    // GIT_LITERAL_PATHSPECS: file names from `git status` are data, never
    // patterns — otherwise a file literally named `*` stages everything.
    const out = await this.run({ command: 'git', args, cwd, timeoutMs: 120_000, input, env: { GIT_LITERAL_PATHSPECS: '1' }, maxOutputBytes: 16 * 1024 * 1024 })
    if (!allowFail && (out.spawnError || out.exitCode !== 0)) {
      throw new Error(`git ${args.slice(0, 3).join(' ')} failed (${out.exitCode}): ${(out.stderr || out.spawnError || '').trim().slice(0, 300)}`)
    }
    return out
  }
}

/** Resolve the shared git directory (worktrees share `info/exclude` and `config`). */
export async function commonGitDir(git, repo) {
  const out = await git.exec(repo, ['rev-parse', '--git-common-dir'])
  return path.resolve(repo, out.stdout.trim())
}

async function readIfPresent(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * Snapshot proving the original repository was not modified: HEAD, porcelain
 * status, branch, plus the shared git metadata a stray write could touch.
 */
export async function snapshotRepo(git, repo) {
  const head = (await git.exec(repo, ['rev-parse', 'HEAD'])).stdout.trim()
  const status = (await git.exec(repo, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout
  const branch = (await git.exec(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  const common = await commonGitDir(git, repo)
  const infoExclude = await readIfPresent(path.join(common, 'info', 'exclude'))
  const config = await readIfPresent(path.join(common, 'config'))
  const hooksHash = await hashHooksDir(path.join(common, 'hooks'))
  return {
    head,
    status,
    branch,
    dirty: status.trim() !== '',
    gitCommonDir: common,
    infoExclude,
    infoExcludeHash: hash(infoExclude ?? ''),
    configHash: hash(config ?? ''),
    hooksHash,
  }
}

/** Fingerprint the shared hooks directory (names + bytes) without executing anything. */
async function hashHooksDir(dir) {
  let names = []
  try {
    names = (await fs.readdir(dir)).sort()
  } catch {
    return hash('')
  }
  const parts = []
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      const stat = await fs.lstat(file)
      if (!stat.isFile()) {
        parts.push(`${name}:${stat.isDirectory() ? 'dir' : 'other'}`)
        continue
      }
      parts.push(`${name}:${hash(await fs.readFile(file))}`)
    } catch {
      parts.push(`${name}:?`)
    }
  }
  return hash(parts.join('\n'))
}

/** Persisted form: hashes only (metadata content may be sensitive). */
export function publicSnapshot(snapshot) {
  const { head, status, branch, dirty, gitCommonDir, infoExcludeHash, configHash, hooksHash } = snapshot
  return { head, status, branch, dirty, gitCommonDir, infoExcludeHash, configHash, hooksHash }
}

/**
 * Restore `info/exclude` to the snapshotted bytes (patterns only, never secrets).
 * Every path in the chain must be a real directory/file: a symlinked `.git`,
 * `.git/info` or `info/exclude` would write outside the repository, which is the
 * one thing this guard exists to prevent.
 */
export async function restoreInfoExclude(snapshot) {
  if (typeof snapshot.infoExclude !== 'string' || typeof snapshot.gitCommonDir !== 'string') return false
  const realDir = async (target) => {
    const stat = await fs.lstat(target).catch(() => null)
    return stat !== null && stat.isDirectory() && !stat.isSymbolicLink()
  }
  if (!(await realDir(snapshot.gitCommonDir))) return false
  const infoDir = path.join(snapshot.gitCommonDir, 'info')
  const infoStat = await fs.lstat(infoDir).catch(() => null)
  if (infoStat === null) await fs.mkdir(infoDir, { recursive: true })
  else if (!(await realDir(infoDir))) return false
  const firstInfoStat = await fs.lstat(infoDir).catch(() => null)
  if (firstInfoStat === null) return false
  const excludePath = path.join(infoDir, 'exclude')
  const excludeStat = await fs.lstat(excludePath).catch(() => null)
  if (excludeStat !== null) {
    if (!excludeStat.isFile() || excludeStat.isSymbolicLink()) return false
    await fs.unlink(excludePath)
  }
  // Re-check immediately before writing: a swap to a symlink between the checks
  // must not be followed.
  const finalInfoStat = await fs.lstat(infoDir).catch(() => null)
  if (finalInfoStat === null || !finalInfoStat.isDirectory() || finalInfoStat.isSymbolicLink()) return false
  if (finalInfoStat.dev !== firstInfoStat.dev || finalInfoStat.ino !== firstInfoStat.ino) return false
  await fs.writeFile(excludePath, snapshot.infoExclude, { flag: 'wx' })
  return true
}

/**
 * @returns {Promise<{path:string, branch:string, baseSha:string, originalSnapshot:object, warnings:string[]}>}
 */
export async function createWorktree({ git, repo, workflowId, dataDir }) {
  const top = (await git.exec(repo, ['rev-parse', '--show-toplevel'], { allowFail: true }))
  if (top.exitCode !== 0) throw new Error(`"${repo}" is not inside a Git repository; isolated worktree cannot be created`)
  const root = top.stdout.trim()
  const snapshot = await snapshotRepo(git, root)
  const warnings = []
  if (snapshot.dirty) warnings.push('The original working tree has uncommitted changes; they were preserved untouched and are NOT part of the isolated worktree (it starts from HEAD).')
  const branch = `orchestrate/${workflowId}`
  const wtPath = path.join(dataDir, 'worktrees', workflowId)
  await fs.mkdir(path.dirname(wtPath), { recursive: true })
  await git.exec(root, ['worktree', 'add', '-b', branch, wtPath, snapshot.head])
  return { path: wtPath, branch, baseSha: snapshot.head, repoRoot: root, originalSnapshot: publicSnapshot(snapshot), privateSnapshot: snapshot, warnings }
}

/**
 * Stage the worktree's real changes. `git add -A -- . ':(exclude).orchestrator'`
 * is NOT usable: when `.orchestrator` is ignored (a repository .gitignore or the
 * implementer writing into shared git metadata) git aborts the whole add. We
 * therefore stage an explicit, filtered path list from `git status -z`.
 */
export async function stageChanges(git, wtPath) {
  const out = await git.exec(wtPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])
  const records = out.stdout.split('\0')
  const paths = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (record.length < 4) continue
    const xy = record.slice(0, 2)
    const file = record.slice(3)
    if (xy[0] === 'R' || xy[0] === 'C') i += 1 // the next record is the rename source
    if (file === ORCH_DIR || file.startsWith(`${ORCH_DIR}/`)) continue
    if (file === '.git' || file.startsWith('.git/')) continue
    paths.push(file)
  }
  if (paths.length > 0) await git.exec(wtPath, ['add', '-A', '--', ...paths])
  // Belt and braces: whatever the names were, the scaffolding must never be staged.
  const staged = (await git.exec(wtPath, ['diff', '--cached', '--name-only', '--no-renames'])).stdout.split('\n').filter(Boolean)
  const leaked = staged.filter((file) => file === ORCH_DIR || file.startsWith(`${ORCH_DIR}/`))
  if (leaked.length > 0) {
    await git.exec(wtPath, ['restore', '--staged', '--', ...leaked])
    const error = new Error(`refusing to stage orchestrator scaffolding: ${leaked.join(', ')}`)
    error.code = 'ORCHESTRATOR_STAGED'
    throw error
  }
  return paths
}

/** Stage everything except orchestrator artifacts; return diff text + names. */
export async function collectChanges(git, wtPath, baseSha, { maxDiffBytes = 400_000 } = {}) {
  await stageChanges(git, wtPath)
  const names = (await git.exec(wtPath, ['diff', '--cached', '--name-only', '--no-renames', baseSha, '--'])).stdout.split('\n').filter((f) => f !== '' && f !== ORCH_DIR && !f.startsWith(`${ORCH_DIR}/`))
  const stat = (await git.exec(wtPath, ['diff', '--cached', '--stat', '--no-renames', baseSha, '--'])).stdout
  let diff = (await git.exec(wtPath, ['diff', '--cached', baseSha, '--'])).stdout
  let truncated = false
  if (diff.length > maxDiffBytes) {
    diff = `${diff.slice(0, maxDiffBytes)}\n[diff truncated at ${maxDiffBytes} bytes; inspect files directly]`
    truncated = true
  }
  return { files: names, stat, diff, truncated }
}

/** Identity of what is currently staged — the evidence the reviewer actually saw. */
export async function stagedTree(git, wtPath) {
  await stageChanges(git, wtPath)
  const tree = (await git.exec(wtPath, ['write-tree'])).stdout.trim()
  const empty = (await git.exec(wtPath, ['diff', '--cached', '--quiet'], { allowFail: true })).exitCode === 0
  return { tree, empty }
}

/** Commit the staged task changes on the task branch. Never merges or pushes. */
export async function commitTask(git, wtPath, message) {
  await stageChanges(git, wtPath)
  const staged = await git.exec(wtPath, ['diff', '--cached', '--quiet'], { allowFail: true })
  if (staged.exitCode === 0) return { committed: false, sha: null }
  // A planted hook must never execute at delivery time.
  await git.exec(wtPath, ['-c', 'user.name=DSH Orchestrator', '-c', 'user.email=orchestrator@localhost', '-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-q', '-m', message])
  const sha = (await git.exec(wtPath, ['rev-parse', 'HEAD'])).stdout.trim()
  return { committed: true, sha }
}

/** Remove a completed run's worktree (the delivered branch keeps its commits). */
export async function removeWorktree(git, repoRoot, wtPath) {
  const result = await git.exec(repoRoot, ['worktree', 'remove', '--force', wtPath], { allowFail: true })
  await git.exec(repoRoot, ['worktree', 'prune'], { allowFail: true })
  return !result.spawnError && result.exitCode === 0
}

/** True when the original repo is exactly as it was before the workflow. */
export async function originalUntouched(git, repoRoot, snapshot) {
  const now = await snapshotRepo(git, repoRoot)
  const treeSame = now.head === snapshot.head && now.status === snapshot.status && now.branch === snapshot.branch
  const metadataSame = now.infoExcludeHash === snapshot.infoExcludeHash && now.configHash === snapshot.configHash && now.hooksHash === snapshot.hooksHash
  return { untouched: treeSame && metadataSame, treeSame, metadataSame, now }
}
