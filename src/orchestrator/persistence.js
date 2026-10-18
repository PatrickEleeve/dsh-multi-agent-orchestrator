/**
 * Local JSON persistence (one directory per workflow, atomic writes).
 * Raw credentials are never stored; every payload is redacted first.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { redactDeep } from '../security/redaction.js'
import { isTerminal, transition } from './state-machine.js'

export class WorkflowStore {
  constructor(dataDir) {
    this.root = path.join(dataDir, 'workflows')
  }
  dir(id) {
    if (!/^[a-z0-9-]{4,64}$/.test(id)) throw new Error(`invalid workflow id "${id}"`)
    return path.join(this.root, id)
  }
  async save(wf) {
    const dir = this.dir(wf.id)
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, 'state.json')
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
    await fs.writeFile(tmp, JSON.stringify(redactDeep(wf), null, 2), { mode: 0o600 })
    await fs.rename(tmp, file)
  }
  async load(id) {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir(id), 'state.json'), 'utf8'))
    } catch {
      return undefined
    }
  }
  async list() {
    let names = []
    try {
      names = await fs.readdir(this.root)
    } catch {
      return []
    }
    const all = []
    for (const name of names) {
      const wf = await this.load(name)
      if (wf) all.push(wf)
    }
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  /**
   * Crash recovery: a workflow persisted in a non-terminal, non-blocked state
   * lost its driver with the process. Mark it BLOCKED with recovery guidance;
   * nothing is replayed automatically. Completed stages stay completed.
   */
  async recoverInterrupted({ isLive = () => false, reconcile } = {}) {
    if (typeof isLive !== 'function') isLive = () => false
    const recovered = []
    for (const wf of await this.list()) {
      if (isTerminal(wf) || wf.state === 'BLOCKED' || isLive(wf.id)) continue
      // Reconcile surviving child processes before marking the workflow blocked;
      // a leftover CLI must not keep editing the worktree behind our back.
      let note = ''
      if (typeof reconcile === 'function') {
        try {
          note = (await reconcile(wf)) ?? ''
        } catch (error) {
          note = `orphan reconciliation failed: ${String(error?.message ?? error)}`
        }
      }
      transition(wf, 'BLOCKED', `interrupted: orchestrator process ended while in ${wf.state}`)
      wf.blocker = {
        kind: 'interrupted',
        message: `Interrupted during ${wf.blockedFrom}. Completed stages are preserved. Run "/orchestrate resume ${wf.id}" to continue from ${wf.blockedFrom}; any partially applied file edits in ${wf.workspace?.path ?? 'the worktree'} remain and will be re-verified, not replayed.${note ? ` Process reconciliation: ${note}.` : ''}`,
      }
      await this.save(wf)
      recovered.push(wf.id)
    }
    return recovered
  }
}
