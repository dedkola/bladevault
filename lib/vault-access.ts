import Database from 'better-sqlite3'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { getLocalDataDirPath } from '@/lib/local-db'
import {
  getLocalRestoreJournalPath,
  recoverInterruptedLocalRestore,
} from '@/lib/local-restore-recovery'
import {
  VAULT_GENERATION_HEADER,
  type VaultAccessErrorCode,
  type VaultAccessState,
} from '@/lib/vault-access-shared'

export { VAULT_GENERATION_HEADER } from '@/lib/vault-access-shared'

type RestoreOwner = {
  pid: number
  startedAt: number
  token: string
  phase: 'preparing' | 'switching'
  recoveryRequired?: boolean
}
type Writer = {
  dataDir: string
  generation: string
  leasePath: string
  active: boolean
}
type Connection = { generation: string; close: () => void; leasePath: string }
type Runtime = {
  writers: AsyncLocalStorage<Writer>
  connections: Map<string, Connection>
  coordinating?: Set<string>
  timer?: ReturnType<typeof setInterval>
}

const RUNTIME_KEY = Symbol.for('bladevault.vault-access')
const POLL_INTERVAL_MS = 100

function runtime(): Runtime {
  const global = globalThis as typeof globalThis & {
    [RUNTIME_KEY]?: Runtime
  }
  return (global[RUNTIME_KEY] ??= {
    writers: new AsyncLocalStorage<Writer>(),
    connections: new Map(),
  })
}

function vaultPath(dataDir = getLocalDataDirPath()): string {
  return path.resolve(dataDir)
}

export function getVaultControlDir(dataDir = getLocalDataDirPath()): string {
  // Private system entries are excluded from archive/swap contents. Keeping
  // coordination inside the data mount also survives Docker recreation.
  return path.join(vaultPath(dataDir), '._bladevault-control')
}

function controlPath(dataDir: string, name: string): string {
  return path.join(getVaultControlDir(dataDir), name)
}

function ensureControlDirectory(dataDir: string) {
  fs.mkdirSync(getVaultControlDir(dataDir), { recursive: true, mode: 0o700 })
}

function atomicWrite(filePath: string, value: unknown) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(value), { mode: 0o600 })
    fs.renameSync(temporaryPath, filePath)
  } finally {
    fs.rmSync(temporaryPath, { force: true })
  }
}

function exclusiveWrite(filePath: string, value: unknown) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(value), { mode: 0o600 })
    // Installing a fully written inode with an exclusive hard link prevents
    // another process from ever reading a partially written owner/generation.
    fs.linkSync(temporaryPath, filePath)
  } finally {
    fs.rmSync(temporaryPath, { force: true })
  }
}

function processIsAlive(pid: number, startedAt?: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  if (
    pid === process.pid &&
    startedAt !== undefined &&
    startedAt !== performance.timeOrigin
  )
    return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readOwnerFile(dataDir: string): RestoreOwner | null {
  const filePath = controlPath(dataDir, 'restore.json')
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as RestoreOwner
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function withCoordination<T>(
  dataDir: string,
  action: () => T,
  onBusy?: () => T,
): T {
  const coordinating = (runtime().coordinating ??= new Set<string>())
  if (coordinating.has(dataDir)) return action()
  ensureControlDirectory(dataDir)
  const database = new Database(controlPath(dataDir, 'coordination.sqlite'), {
    timeout: 0,
  })
  try {
    database.exec('BEGIN IMMEDIATE')
    coordinating.add(dataDir)
    const result = action()
    database.exec('COMMIT')
    return result
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK')
    if (
      ['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(
        (error as { code?: string }).code ?? '',
      )
    ) {
      if (onBusy) return onBusy()
      const owner = readOwnerFile(dataDir)
      throw new VaultAccessError('VAULT_RESTORE_BUSY', {
        generation: getVaultGeneration(dataDir),
        phase: owner?.phase ?? 'preparing',
        readOnly: true,
      })
    }
    throw error
  } finally {
    coordinating.delete(dataDir)
    database.close()
  }
}

export function withVaultControlTransaction<T>(
  dataDir: string,
  action: () => T,
): T {
  return withCoordination(vaultPath(dataDir), action)
}

function readOwner(dataDir: string): RestoreOwner | null {
  const owner = readOwnerFile(dataDir)
  if (!owner || processIsAlive(owner.pid, owner.startedAt)) return owner
  // The stable coordination database serializes stale reclamation with new
  // acquisitions. A late observer can never unlink a newly acquired marker.
  return withCoordination(
    dataDir,
    () => {
      const current = readOwnerFile(dataDir)
      if (!current || processIsAlive(current.pid, current.startedAt))
        return current
      const journalExists = fs.existsSync(getLocalRestoreJournalPath(dataDir))
      let recovered = current.phase === 'preparing' || !journalExists
      if (!recovered) {
        try {
          recovered = recoverInterruptedLocalRestore(dataDir)
        } catch {
          // Failed or overlapping recovery keeps the access gate observable,
          // without exposing a partly installed database through an error page.
          return current
        }
      }
      if (recovered) {
        // Recovery has restored a coherent vault. A generation change also
        // invalidates forms whose process died after committing replacement.
        if (current.phase === 'switching')
          atomicWrite(controlPath(dataDir, 'generation.json'), randomUUID())
        fs.rmSync(controlPath(dataDir, 'restore.json'), { force: true })
        return null
      }
      return current
    },
    () => owner,
  )
}

export function getVaultGeneration(dataDir = getLocalDataDirPath()): string {
  const resolved = vaultPath(dataDir)
  const filePath = controlPath(resolved, 'generation.json')
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as string
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  ensureControlDirectory(resolved)
  try {
    const generation = randomUUID()
    exclusiveWrite(filePath, generation)
    return generation
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as string
  }
}

export function getVaultAccessState(
  dataDir = getLocalDataDirPath(),
): VaultAccessState {
  const resolved = vaultPath(dataDir)
  const owner = readOwner(resolved)
  const generation = getVaultGeneration(resolved)
  return {
    generation,
    phase: owner?.phase ?? 'idle',
    readOnly: Boolean(owner),
    ...(owner &&
    (owner.recoveryRequired || !processIsAlive(owner.pid, owner.startedAt))
      ? { recoveryRequired: true }
      : {}),
  }
}

export class VaultAccessError extends Error {
  readonly status: number
  constructor(
    readonly code: VaultAccessErrorCode,
    readonly state: VaultAccessState,
  ) {
    super(
      code === 'VAULT_CHANGED'
        ? 'The vault was restored. Refresh before making changes.'
        : state.recoveryRequired
          ? 'Vault recovery is required before continuing.'
          : state.phase === 'switching'
            ? 'The restored vault is being installed. Please wait a moment.'
            : 'Cloud restore is running. Your collection is temporarily read-only.',
    )
    this.name = 'VaultAccessError'
    this.status =
      code === 'VAULT_CHANGED' ? 409 : state.phase === 'switching' ? 503 : 423
  }
}

export function vaultAccessErrorResponse(error: unknown): Response | null {
  // Next bundles and module reloads can create another copy of the class while
  // the process-wide runtime continues to use callbacks from the previous copy.
  if (!(error instanceof Error) || error.name !== 'VaultAccessError')
    return null
  const accessError = error as VaultAccessError
  if (!['VAULT_RESTORE_BUSY', 'VAULT_CHANGED'].includes(accessError.code))
    return null
  return Response.json(
    {
      error: accessError.message,
      code: accessError.code,
      vault: accessError.state,
    },
    {
      status: accessError.status,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': '1',
        [VAULT_GENERATION_HEADER]: accessError.state.generation,
      },
    },
  )
}

export function assertVaultGeneration(expected: string): void {
  const state = getVaultAccessState()
  if (expected !== state.generation)
    throw new VaultAccessError('VAULT_CHANGED', state)
}

export function assertVaultReadable(): void {
  const state = getVaultAccessState()
  if (state.phase === 'switching')
    throw new VaultAccessError('VAULT_RESTORE_BUSY', state)
}

export function assertVaultWritable(): void {
  const dataDir = vaultPath()
  const state = getVaultAccessState(dataDir)
  const writer = runtime().writers.getStore()
  if (
    writer?.active &&
    writer.dataDir === dataDir &&
    writer.generation !== state.generation
  )
    throw new VaultAccessError('VAULT_CHANGED', state)
  if (
    state.readOnly &&
    !(
      writer?.active &&
      writer.dataDir === dataDir &&
      state.phase === 'preparing'
    )
  )
    throw new VaultAccessError('VAULT_RESTORE_BUSY', state)
}

function beginWriter(): { writer: Writer; release: () => void } {
  assertVaultWritable()
  const dataDir = vaultPath()
  const generation = getVaultGeneration(dataDir)
  const directory = controlPath(dataDir, 'writers')
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const leasePath = path.join(directory, `${process.pid}-${randomUUID()}.json`)
  fs.writeFileSync(
    leasePath,
    JSON.stringify({ pid: process.pid, startedAt: performance.timeOrigin }),
    {
      flag: 'wx',
      mode: 0o600,
    },
  )
  const writer = { dataDir, generation, leasePath, active: true }
  const release = () => {
    writer.active = false
    fs.rmSync(leasePath, { force: true })
  }
  try {
    // Restore may acquire its marker between our first check and registration.
    // No write begins until the second check accepts this lease.
    assertVaultWritable()
    assertVaultGeneration(generation)
    return { writer, release }
  } catch (error) {
    release()
    throw error
  }
}

export async function withVaultWrite<T>(action: () => Promise<T>): Promise<T> {
  const active = runtime().writers.getStore()
  if (active?.active && active.dataDir === vaultPath()) {
    assertVaultWritable()
    return action()
  }
  const { writer, release } = beginWriter()
  try {
    return await runtime().writers.run(writer, action)
  } finally {
    release()
  }
}

export function withVaultWriteSync<T>(action: () => T): T {
  const active = runtime().writers.getStore()
  if (active?.active && active.dataDir === vaultPath()) {
    assertVaultWritable()
    return action()
  }
  const { writer, release } = beginWriter()
  try {
    return runtime().writers.run(writer, action)
  } finally {
    release()
  }
}

function reconcileConnections() {
  for (const [dataDir, connection] of runtime().connections) {
    const state = getVaultAccessState(dataDir)
    if (
      state.phase === 'switching' ||
      state.generation !== connection.generation
    )
      connection.close()
  }
}

export function registerVaultConnection(close: () => void): () => void {
  assertVaultReadable()
  const dataDir = vaultPath()
  const generation = getVaultGeneration(dataDir)
  const directory = controlPath(dataDir, 'connections')
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const leasePath = path.join(directory, `${process.pid}.json`)
  fs.writeFileSync(
    leasePath,
    JSON.stringify({ pid: process.pid, startedAt: performance.timeOrigin }),
    {
      mode: 0o600,
    },
  )
  const connection = { generation, close, leasePath }
  runtime().connections.set(dataDir, connection)
  const release = () => {
    if (runtime().connections.get(dataDir) !== connection) return
    runtime().connections.delete(dataDir)
    fs.rmSync(leasePath, { force: true })
  }
  try {
    assertVaultReadable()
    if (generation !== getVaultGeneration(dataDir))
      throw new VaultAccessError('VAULT_CHANGED', getVaultAccessState(dataDir))
  } catch (error) {
    release()
    throw error
  }
  if (!runtime().timer) {
    runtime().timer = setInterval(() => {
      // A filesystem error should not terminate the server. Access attempts still
      // check the marker and fail closed, while a restore drain times out.
      try {
        reconcileConnections()
      } catch {}
    }, POLL_INTERVAL_MS)
    runtime().timer!.unref()
  }
  return release
}

type DrainOptions = { timeoutMs?: number; signal?: AbortSignal }

async function drainLeases(
  dataDir: string,
  name: 'writers' | 'connections',
  { timeoutMs = 120_000, signal }: DrainOptions = {},
) {
  const directory = controlPath(dataDir, name)
  const deadline = Date.now() + timeoutMs
  while (true) {
    signal?.throwIfAborted()
    let entries: string[]
    try {
      entries = fs.readdirSync(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      entries = []
    }
    let remaining = 0
    for (const entry of entries) {
      const leasePath = path.join(directory, entry)
      // File names carry the PID so a process crash during writing JSON cannot
      // leave an unreadable lease that blocks recovery permanently.
      const pid = Number(entry.split(/[.-]/)[0])
      let startedAt: number | undefined
      try {
        startedAt = (
          JSON.parse(fs.readFileSync(leasePath, 'utf8')) as {
            startedAt?: number
          }
        ).startedAt
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        // A newly registered writer may still be publishing its tiny lease.
        // Retain it while its process is alive rather than starting installation.
      }
      if (!processIsAlive(pid, startedAt)) fs.rmSync(leasePath, { force: true })
      else remaining += 1
    }
    if (!remaining) return
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for active vault ${name} to finish.`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

export type VaultRestoreLease = {
  waitForWriters: (options?: DrainOptions) => Promise<void>
  beginSwitch: (options?: DrainOptions) => Promise<void>
  finish: (success: boolean) => void
  release: () => void
  abandon: () => void
}

export function acquireVaultRestore(): VaultRestoreLease {
  const dataDir = vaultPath()
  getVaultGeneration(dataDir)
  const markerPath = controlPath(dataDir, 'restore.json')
  const owner: RestoreOwner = {
    pid: process.pid,
    startedAt: performance.timeOrigin,
    token: randomUUID(),
    phase: 'preparing',
  }
  try {
    withCoordination(dataDir, () => {
      // Stale owner recovery and exclusive marker installation share one writer
      // transaction across processes; the database itself is never replaced.
      readOwner(dataDir)
      exclusiveWrite(markerPath, owner)
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    throw new VaultAccessError(
      'VAULT_RESTORE_BUSY',
      getVaultAccessState(dataDir),
    )
  }
  let finished = false
  const requireOwnership = () => {
    if (readOwner(dataDir)?.token !== owner.token)
      throw new Error('The vault restore lease is no longer owned by this job.')
  }
  const release = () => {
    if (finished) return
    if (readOwner(dataDir)?.token === owner.token)
      fs.rmSync(markerPath, { force: true })
    finished = true
  }
  return {
    waitForWriters: async (options) => {
      requireOwnership()
      await drainLeases(dataDir, 'writers', options)
    },
    beginSwitch: async (options) => {
      requireOwnership()
      await drainLeases(dataDir, 'writers', options)
      owner.phase = 'switching'
      atomicWrite(markerPath, owner)
      reconcileConnections()
      await drainLeases(dataDir, 'connections', options)
    },
    finish: (success) => {
      requireOwnership()
      if (success)
        atomicWrite(controlPath(dataDir, 'generation.json'), randomUUID())
      release()
    },
    release,
    // Failed rollback must keep access blocked. A process restart then runs the
    // interrupted-install recovery before opening a database again.
    abandon: () => {
      if (finished) return
      requireOwnership()
      owner.recoveryRequired = true
      finished = true
      atomicWrite(markerPath, owner)
    },
  }
}
