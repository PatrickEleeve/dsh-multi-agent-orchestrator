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
    const out = await this.run({ command: 'git', args, cwd, timeoutMs: 120_000, input, maxOutputBytes: 16 * 1024 * 1024 })
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
  return {
    head,
    status,
    branch,
    dirty: status.trim() !== '',
    gitCommonDir: common,
    infoExclude,
    infoExcludeHash: hash(infoExclude ?? ''),
    configHash: hash(config ?? ''),
  }
}

/** Persisted form: hashes only (metadata content may be sensitive). */
export function publicSnapshot(snapshot) {
  const { head, status, branch, dirty, gitCommonDir, infoExcludeHash, configHash } = snapshot
  return { head, status, branch, dirty, gitCommonDir, infoExcludeHash, configHash }
}

/** Restore `info/exclude` to the snapshotted bytes (patterns only, never secrets). */
export async function restoreInfoExclude(snapshot) {
  if (typeof snapshot.infoExclude !== 'string' || typeof snapshot.gitCommonDir !== 'string') return false
  await fs.mkdir(path.join(snapshot.gitCommonDir, 'info'), { recursive: true })
  await fs.writeFile(path.join(snapshot.gitCommonDir, 'info', 'exclude'), snapshot.infoExclude)
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
  const out = await git.exec(wtPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
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
  return paths
}

/** Stage everything except orchestrator artifacts; return diff text + names. */
export async function collectChanges(git, wtPath, baseSha, { maxDiffBytes = 400_000 } = {}) {
  await stageChanges(git, wtPath)
  const names = (await git.exec(wtPath, ['diff', '--cached', '--name-only', baseSha, '--'])).stdout.split('\n').filter((f) => f !== '' && f !== ORCH_DIR && !f.startsWith(`${ORCH_DIR}/`))
  const stat = (await git.exec(wtPath, ['diff', '--cached', '--stat', baseSha, '--'])).stdout
  let diff = (await git.exec(wtPath, ['diff', '--cached', baseSha, '--'])).stdout
  let truncated = false
  if (diff.length > maxDiffBytes) {
    diff = `${diff.slice(0, maxDiffBytes)}\n[diff truncated at ${maxDiffBytes} bytes; inspect files directly]`
    truncated = true
  }
  return { files: names, stat, diff, truncated }
}

/** Commit the staged task changes on the task branch. Never merges or pushes. */
export async function commitTask(git, wtPath, message) {
  await stageChanges(git, wtPath)
  const staged = await git.exec(wtPath, ['diff', '--cached', '--quiet'], { allowFail: true })
  if (staged.exitCode === 0) return { committed: false, sha: null }
  await git.exec(wtPath, ['-c', 'user.name=DSH Orchestrator', '-c', 'user.email=orchestrator@localhost', 'commit', '-q', '-m', message])
  const sha = (await git.exec(wtPath, ['rev-parse', 'HEAD'])).stdout.trim()
  return { committed: true, sha }
}

/** True when the original repo is exactly as it was before the workflow. */
export async function originalUntouched(git, repoRoot, snapshot) {
  const now = await snapshotRepo(git, repoRoot)
  const treeSame = now.head === snapshot.head && now.status === snapshot.status && now.branch === snapshot.branch
  const metadataSame = now.infoExcludeHash === snapshot.infoExcludeHash && now.configHash === snapshot.configHash
  return { untouched: treeSame && metadataSame, treeSame, metadataSame, now }
}
