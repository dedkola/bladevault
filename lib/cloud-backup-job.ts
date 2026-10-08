import { randomUUID } from 'node:crypto'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import Database from 'better-sqlite3'
import * as tar from 'tar'
import { getConfiguredCloudBackupUrl } from '@/lib/cloud-backup-server'
import { DEFAULT_CLOUD_AUTH_URL, normalizeCloudUrl } from '@/lib/cloud-backup'
import {
  BACKUP_UPLOAD_BYTES_PER_SECOND,
  IDLE_CLOUD_BACKUP_JOB,
  type CloudBackupJobState,
} from '@/lib/cloud-backup-shared'
import { getLocalDataDirPath, getLocalDb } from '@/lib/local-db'
import { resolveLocalImagePath } from '@/lib/local-image-path'
import {
  tryBeginVaultOperation,
  VaultOperationBusyError,
} from '@/lib/vault-operation'

const JOBS_SYMBOL = Symbol.for('bladevault.cloud-backup-jobs')
type JobRegistry = Map<string, CloudBackupJobState>

function getJobs(): JobRegistry {
  const runtime = globalThis as typeof globalThis & {
    [JOBS_SYMBOL]?: JobRegistry
  }
  return (runtime[JOBS_SYMBOL] ??= new Map())
}

function getSavedSyncTime(database: Database.Database): string | null {
  const row = database
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('cloud_backup_last_synced_at') as { value?: string } | undefined
  return row?.value || null
}

// Keep both file reads/compression and upload gentle. Backpressure bounds memory,
// and each small chunk yields to foreground requests instead of monopolizing I/O.
class PacedBackupStream extends Transform {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    super({ highWaterMark: 64 * 1024 })
  }

  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ) {
    const delay = Math.max(
      1,
      Math.ceil((chunk.length / BACKUP_UPLOAD_BYTES_PER_SECOND) * 1000),
    )
    this.timer = setTimeout(() => {
      this.timer = null
      callback(null, chunk)
    }, delay)
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    callback(error)
  }
}

function shouldIgnoreEntry(name: string) {
  return (
    name === '__webpage_drafts' ||
    name === '.DS_Store' ||
    name === '__MACOSX' ||
    name.startsWith('._')
  )
}

const CLONE_FALLBACK_CODES = new Set([
  'EXDEV',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
  'EINVAL',
])

async function stageBackupFiles(
  sourceDir: string,
  destinationDir: string,
  liveDatabasePath: string,
) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    if (shouldIgnoreEntry(entry.name)) continue
    const sourcePath = path.join(sourceDir, entry.name)
    const destinationPath = path.join(destinationDir, entry.name)
    if (
      sourcePath === liveDatabasePath ||
      sourcePath === `${liveDatabasePath}-wal` ||
      sourcePath === `${liveDatabasePath}-shm`
    )
      continue

    if (entry.isDirectory()) {
      await fs.mkdir(destinationPath, { recursive: true })
      await stageBackupFiles(sourcePath, destinationPath, liveDatabasePath)
    } else if (entry.isFile()) {
      try {
        await fs.copyFile(
          sourcePath,
          destinationPath,
          constants.COPYFILE_FICLONE_FORCE,
        )
      } catch (error) {
        if (
          !error ||
          typeof error !== 'object' ||
          !('code' in error) ||
          !CLONE_FALLBACK_CODES.has(String(error.code))
        ) {
          throw error
        }
        // Docker volumes and other filesystems may not support clones. Keep
        // their fallback reads and writes bounded instead of doing a bulk copy.
        await pipeline(
          createReadStream(sourcePath, { highWaterMark: 64 * 1024 }),
          new PacedBackupStream(),
          createWriteStream(destinationPath, { mode: 0o600 }),
        )
      }
    } else if (entry.isSymbolicLink()) {
      // Retain the full-folder archive's treatment of ancillary symlinks.
      // Referenced collection images must be regular files during validation.
      await fs.cp(sourcePath, destinationPath, { dereference: false })
    } else {
      throw new Error(
        'The local data folder contains an unsupported backup file.',
      )
    }
  }
}

async function createSnapshotArchive(
  database: Database.Database,
  dataDir: string,
  tempRoot: string,
  archivePath: string,
) {
  const topDir = path.basename(dataDir)
  const stagingRoot = path.join(tempRoot, 'staging')
  const snapshotDir = path.join(stagingRoot, topDir)
  const snapshotPath = path.join(snapshotDir, 'bladevault.sqlite')
  const liveDatabasePath = path.join(dataDir, 'bladevault.sqlite')
  // Copy-on-write clones protect the archive from subsequent image replacements
  // and deletion. Unsupported filesystems use a bounded, paced stream copy.
  // A mutation between the database snapshot and staging may remove a referenced
  // file; retry a fresh snapshot rather than upload an incomplete backup.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await fs.rm(snapshotDir, { recursive: true, force: true })
    await fs.mkdir(snapshotDir, { recursive: true })
    try {
      // Include edits during the SQLite snapshot in the revision check; a file
      // path reused immediately after it completes must trigger a fresh snapshot.
      const revision = getDatabaseRevision(database)
      // SQLite's online backup yields between bounded batches and keeps the live
      // connection open, so collection reads and edits remain available.
      await database.backup(snapshotPath, { progress: () => 100 })
      await stageBackupFiles(dataDir, snapshotDir, liveDatabasePath)
      await validateSnapshotImages(snapshotPath, snapshotDir, dataDir)
      if (getDatabaseRevision(database) !== revision) {
        throw Object.assign(
          new Error('Collection changed while staging backup.'),
          {
            code: 'BACKUP_SOURCE_CHANGED',
          },
        )
      }
      break
    } catch (error) {
      if (
        attempt === 2 ||
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        (error.code !== 'ENOENT' && error.code !== 'BACKUP_SOURCE_CHANGED')
      ) {
        throw error
      }
    }
  }

  const archive = tar.create(
    {
      cwd: stagingRoot,
      portable: true,
      strict: true,
      jobs: 1,
      maxReadSize: 64 * 1024,
    },
    [topDir],
  )

  await pipeline(
    archive,
    new PacedBackupStream(),
    createGzip({ level: 1 }),
    createWriteStream(archivePath, { mode: 0o600 }),
  )
}

function getDatabaseRevision(database: Database.Database): string {
  const { changes } = database
    .prepare('SELECT total_changes() AS changes')
    .get() as { changes: number }
  const dataVersion = database.pragma('data_version', { simple: true })
  return `${changes}:${dataVersion}`
}

async function validateSnapshotImages(
  snapshotPath: string,
  snapshotDir: string,
  dataDir: string,
) {
  if (getLocalDataDirPath() !== dataDir) {
    throw new Error(
      'Local data changed during backup. Back up this vault again.',
    )
  }
  const snapshot = new Database(snapshotPath, {
    readonly: true,
    fileMustExist: true,
  })
  try {
    const rows = snapshot.prepare('SELECT images FROM knives').all() as Array<{
      images: string
    }>
    for (const { images } of rows) {
      for (const image of JSON.parse(images) as string[]) {
        if (image.startsWith('http://') || image.startsWith('https://'))
          continue
        const livePath = resolveLocalImagePath(image)
        if (image.split('/').some(shouldIgnoreEntry)) {
          throw new Error(
            'A collection image points to an excluded backup directory.',
          )
        }
        const stagedPath = path.join(
          snapshotDir,
          path.relative(dataDir, livePath),
        )
        const stat = await fs.lstat(stagedPath)
        if (!stat.isFile()) {
          throw new Error('A collection image is not a regular file.')
        }
      }
    }
  } finally {
    snapshot.close()
  }
}

async function refreshJobAccessToken(sessionToken: string): Promise<string> {
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
    throw new Error(`Cloud backup sign-in failed (${response.status}).`)
  }
  const result = (await response.json()) as { token?: unknown }
  if (typeof result.token !== 'string' || !result.token.trim()) {
    throw new Error('Auth server did not return a backup token.')
  }
  return result.token
}

async function uploadArchive(archivePath: string, accessToken: string) {
  const { size } = await fs.stat(archivePath)
  const timeoutMs = Math.min(
    24 * 60 * 60 * 1000,
    Math.max(
      30 * 60 * 1000,
      (size / BACKUP_UPLOAD_BYTES_PER_SECOND) * 3000 + 5 * 60 * 1000,
    ),
  )
  const signal = AbortSignal.timeout(Math.ceil(timeoutMs))
  const source = createReadStream(archivePath, { highWaterMark: 64 * 1024 })
  const body = new PacedBackupStream()
  const transfer = pipeline(source, body, { signal })
  // Attach a handler immediately: the disk stream can fail before fetch settles.
  void transfer.catch(() => {})

  try {
    const response = await fetch(
      new URL('/backup/latest', getConfiguredCloudBackupUrl()),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/gzip',
          'Content-Length': String(size),
          'X-Backup-Filename': 'bladevault-data.tar.gz',
        },
        body: body as unknown as BodyInit,
        duplex: 'half',
        redirect: 'error',
        signal,
      } as RequestInit & { duplex: 'half' },
    )
    // Do not surface an external response body: it may contain account details
    // or echoed credentials. The HTTP status is sufficient for retry feedback.
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Backup upload failed (${response.status}).`)
    }
    await response.body?.cancel()
    await transfer
  } finally {
    source.destroy()
    body.destroy()
    await transfer.catch(() => {})
  }
}

async function runCloudBackupJob(
  job: CloudBackupJobState,
  dataDir: string,
  database: Database.Database,
  sessionToken: string,
) {
  let tempRoot: string | null = null
  let accessToken: string | null = null
  let result: Pick<CloudBackupJobState, 'status' | 'syncedAt' | 'message'> = {
    status: 'error',
    syncedAt: job.syncedAt,
    message: 'Cloud backup failed.',
  }
  try {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bladevault-cloud-job-'))
    const archivePath = path.join(tempRoot, 'bladevault-data.tar.gz')
    await createSnapshotArchive(database, dataDir, tempRoot, archivePath)
    if (!database.open || getLocalDataDirPath() !== dataDir) {
      throw new Error(
        'Local data changed during backup. Back up this vault again.',
      )
    }
    // Preparing a large vault can take longer than an access token's lifetime.
    // Refresh only now, immediately before the cloud accepts the upload.
    accessToken = await refreshJobAccessToken(sessionToken)
    if (!database.open || getLocalDataDirPath() !== dataDir) {
      throw new Error(
        'Local data changed during backup. Back up this vault again.',
      )
    }
    job.phase = 'uploading'
    await uploadArchive(archivePath, accessToken)

    if (!database.open || getLocalDataDirPath() !== dataDir) {
      throw new Error(
        'Local data changed during backup. Back up this vault again.',
      )
    }
    const syncedAt = new Date().toISOString()
    database
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('cloud_backup_last_synced_at', syncedAt)
    result = { status: 'success', syncedAt, message: null }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Cloud backup failed.'
    result.message = message.split(sessionToken).join('[redacted]')
    if (accessToken)
      result.message = result.message.split(accessToken).join('[redacted]')
  } finally {
    if (tempRoot) {
      try {
        await fs.rm(tempRoot, { recursive: true, force: true })
      } catch {
        result = {
          status: 'error',
          syncedAt: job.syncedAt,
          message: 'Could not remove temporary backup files.',
        }
      }
    }
    Object.assign(job, result)
    job.phase = null
  }
}

export function getCloudBackupJobState(): CloudBackupJobState {
  const job = getJobs().get(getLocalDataDirPath())
  return job
    ? { ...job }
    : { ...IDLE_CLOUD_BACKUP_JOB, syncedAt: getSavedSyncTime(getLocalDb()) }
}

export function startCloudBackupJob(sessionToken: string): CloudBackupJobState {
  const dataDir = getLocalDataDirPath()
  const jobs = getJobs()
  const current = jobs.get(dataDir)
  if (current?.status === 'running') return { ...current }

  const release = tryBeginVaultOperation()
  if (!release) throw new VaultOperationBusyError()
  let database: Database.Database
  try {
    database = getLocalDb()
  } catch (error) {
    release()
    throw error
  }
  const job: CloudBackupJobState = {
    id: randomUUID(),
    status: 'running',
    phase: 'preparing',
    syncedAt: getSavedSyncTime(database),
    message: null,
  }
  jobs.set(dataDir, job)
  // The local Node process owns this work. Neither the POST request's signal nor
  // the lifetime of the Settings page is used by the backup job.
  setImmediate(() => {
    void runCloudBackupJob(job, dataDir, database, sessionToken).finally(
      release,
    )
  })
  return { ...job }
}
