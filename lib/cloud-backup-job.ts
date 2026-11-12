import { randomUUID } from 'node:crypto'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import Database from 'better-sqlite3'
import * as tar from 'tar'
import {
  IDLE_CLOUD_BACKUP_JOB,
  type CloudBackupJobState,
} from '@/lib/cloud-backup-shared'
import { uploadDriveBackup } from '@/lib/drive-backup'
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
        // Stream fallback copies with backpressure when clones are unsupported.
        await pipeline(
          createReadStream(sourcePath, { highWaterMark: 64 * 1024 }),
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
  // and deletion. Unsupported filesystems use a stream copy with backpressure.
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

async function runCloudBackupJob(
  job: CloudBackupJobState,
  dataDir: string,
  database: Database.Database,
) {
  let tempRoot: string | null = null
  let result: Pick<CloudBackupJobState, 'status' | 'message'> = {
    status: 'error',
    message: 'Google Drive backup failed.',
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
    job.phase = 'uploading'
    await uploadDriveBackup(archivePath, dataDir)
    result = { status: 'success', message: null }
  } catch (error) {
    result.message =
      error instanceof Error ? error.message : 'Google Drive backup failed.'
  } finally {
    if (tempRoot) {
      try {
        await fs.rm(tempRoot, { recursive: true, force: true })
      } catch {
        result = {
          status: 'error',
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
  return job ? { ...job } : { ...IDLE_CLOUD_BACKUP_JOB }
}

export function startCloudBackupJob(): CloudBackupJobState {
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
    message: null,
  }
  jobs.set(dataDir, job)
  // The local Node process owns this work. Neither the POST request's signal nor
  // the lifetime of the Settings page is used by the backup job.
  setImmediate(() => {
    void runCloudBackupJob(job, dataDir, database).finally(release)
  })
  return { ...job }
}
