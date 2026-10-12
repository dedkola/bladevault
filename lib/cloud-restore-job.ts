import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CLOUD_AUTH_URL, normalizeCloudUrl } from '@/lib/cloud-backup'
import {
  downloadCloudRestoreArchive,
  prepareCloudRestoreArchive,
} from '@/lib/cloud-restore-archive'
import {
  IDLE_CLOUD_RESTORE_JOB,
  type CloudRestoreJobState,
} from '@/lib/cloud-restore-shared'
import { replaceLocalDataFromDirectory } from '@/lib/local-data-restore'
import { getLocalDataDirPath } from '@/lib/local-db'
import {
  acquireVaultRestore,
  assertVaultGeneration,
  getVaultAccessState,
  getVaultControlDir,
  type VaultRestoreLease,
  withVaultControlTransaction,
} from '@/lib/vault-access'
import {
  tryBeginVaultOperation,
  VaultOperationBusyError,
} from '@/lib/vault-operation'

const JOBS = Symbol.for('bladevault.cloud-restore-jobs')
type SavedJob = CloudRestoreJobState & { ownerPid: number }
function jobs(): Map<string, CloudRestoreJobState> {
  const runtime = globalThis as typeof globalThis & {
    [JOBS]?: Map<string, CloudRestoreJobState>
  }
  return (runtime[JOBS] ??= new Map())
}

function saveJob(job: CloudRestoreJobState, dataDir: string, starting = false) {
  const filePath = path.join(getVaultControlDir(dataDir), 'last-restore.json')
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  withVaultControlTransaction(dataDir, () => {
    if (!starting) {
      try {
        const saved = JSON.parse(fs.readFileSync(filePath, 'utf8')) as SavedJob
        // A completed job may still be cleaning temporary files when another
        // process starts a restore. Never overwrite that newer public status.
        if (saved.id !== job.id) return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    try {
      fs.writeFileSync(
        temporaryPath,
        JSON.stringify({ ...job, ownerPid: process.pid }),
        { mode: 0o600 },
      )
      fs.renameSync(temporaryPath, filePath)
    } finally {
      fs.rmSync(temporaryPath, { force: true })
    }
  })
}

export function getCloudRestoreJobState(): CloudRestoreJobState {
  const dataDir = getLocalDataDirPath()
  // This also completes interrupted filesystem recovery before exposing status.
  const state = getVaultAccessState(dataDir)
  const current = jobs().get(dataDir)
  try {
    const { ownerPid, ...saved } = JSON.parse(
      fs.readFileSync(
        path.join(getVaultControlDir(dataDir), 'last-restore.json'),
        'utf8',
      ),
    ) as SavedJob
    if (current?.id === saved.id) return { ...current }
    if (saved.status === 'running' && state.phase === 'idle') {
      saved.status = 'error'
      saved.phase = null
      saved.message =
        'Restore was interrupted. Your vault is available; you can retry the restore.'
    }
    // Only public status is stored. Credentials never enter the status record.
    void ownerPid
    return saved
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return current ? { ...current } : { ...IDLE_CLOUD_RESTORE_JOB }
  }
}

async function refreshRestoreToken(sessionToken: string): Promise<string> {
  const authUrl = normalizeCloudUrl(
    process.env.NEXT_PUBLIC_BLADEVAULT_AUTH_URL?.trim() ||
      DEFAULT_CLOUD_AUTH_URL,
  )
  const response = await fetch(new URL('/api/auth/token', authUrl), {
    headers: { Authorization: `Bearer ${sessionToken}` },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Cloud restore sign-in failed (${response.status}).`)
  }
  const data = (await response.json()) as { token?: unknown }
  if (typeof data.token !== 'string' || !data.token.trim())
    throw new Error('Auth server did not return a restore token.')
  return data.token
}

async function runJob(
  job: CloudRestoreJobState,
  dataDir: string,
  sessionToken: string,
  lease: VaultRestoreLease,
) {
  let tempRoot: string | null = null
  let accessToken: string | null = null
  try {
    await lease.waitForWriters()
    tempRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'bladevault-cloud-restore-'),
    )
    const archivePath = path.join(tempRoot, 'backup.tar.gz')
    accessToken = await refreshRestoreToken(sessionToken)
    await downloadCloudRestoreArchive(accessToken, archivePath)
    job.phase = 'validating'
    saveJob(job, dataDir)
    const sourceDir = await prepareCloudRestoreArchive(
      archivePath,
      path.join(tempRoot, 'extract'),
    )
    if (getLocalDataDirPath() !== dataDir)
      throw new Error('The local data folder changed during restore.')
    const result = await replaceLocalDataFromDirectory(sourceDir, {
      lease,
      onApplying: () => {
        job.phase = 'applying'
        saveJob(job, dataDir)
      },
    })
    Object.assign(job, {
      status: 'success',
      phase: null,
      restoredAt: result.restoredAt,
      generation: result.generation,
      message: null,
    })
  } catch (error) {
    let message =
      error instanceof Error ? error.message : 'Cloud restore failed.'
    for (const token of [sessionToken, accessToken])
      if (token) message = message.split(token).join('[redacted]')
    Object.assign(job, { status: 'error', phase: null, message })
  } finally {
    lease.release()
    if (tempRoot)
      await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
    try {
      saveJob(job, dataDir)
    } catch {
      /* Public status remains in memory if the disk is unavailable. */
    }
  }
}

export function startCloudRestoreJob(
  sessionToken: string,
  expectedGeneration?: string,
): {
  job: CloudRestoreJobState
  started: boolean
} {
  const dataDir = getLocalDataDirPath()
  const current = getCloudRestoreJobState()
  if (expectedGeneration) assertVaultGeneration(expectedGeneration)
  if (current.status === 'running') return { job: current, started: false }
  const releaseOperation = tryBeginVaultOperation()
  if (!releaseOperation) throw new VaultOperationBusyError()
  let lease: VaultRestoreLease | null = null
  try {
    lease = acquireVaultRestore()
    if (expectedGeneration) assertVaultGeneration(expectedGeneration)
  } catch (error) {
    lease?.release()
    releaseOperation()
    throw error
  }
  const job: CloudRestoreJobState = {
    ...IDLE_CLOUD_RESTORE_JOB,
    id: randomUUID(),
    status: 'running',
    phase: 'downloading',
  }
  try {
    saveJob(job, dataDir, true)
    jobs().set(dataDir, job)
  } catch (error) {
    lease.release()
    releaseOperation()
    throw error
  }
  // The Node process owns the job. The initiating request and Settings component
  // can disappear without stopping an accepted restore.
  setImmediate(() => {
    void runJob(job, dataDir, sessionToken, lease)
      .finally(releaseOperation)
      .catch(() => {})
  })
  return { job: { ...job }, started: true }
}
