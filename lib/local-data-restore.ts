import Database from 'better-sqlite3'
import { randomUUID, randomBytes } from 'node:crypto'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import fs from 'fs/promises'
import path from 'path'
import { pipeline } from 'node:stream/promises'
import { performance } from 'node:perf_hooks'
import { clearStorageCache } from '@/lib/storage'
import { clearDockerImageCache } from '@/lib/docker-image-cache'
import { captureAppLockAccessSnapshot } from '@/lib/app-lock'
import {
  acquireVaultRestore,
  assertVaultGeneration,
  getVaultGeneration,
  vaultAccessErrorResponse,
  VAULT_GENERATION_HEADER,
  type VaultRestoreLease,
} from '@/lib/vault-access'
import {
  getLocalRestoreJournalPath,
  rollbackLocalRestore,
  type LocalRestoreJournal,
} from '@/lib/local-restore-recovery'
import {
  beginLocalRestore,
  closeLocalDb,
  endLocalRestore,
  getLocalDataDirPath,
  LOCAL_DB_SCHEMA_VERSION,
} from '@/lib/local-db'

function shouldIgnoreSystemEntry(name: string): boolean {
  return name === '.DS_Store' || name === '__MACOSX' || name.startsWith('._')
}

function shouldIgnoreCopiedDataEntry(
  name: string,
  includeSqliteSidecars: boolean,
): boolean {
  return (
    shouldIgnoreSystemEntry(name) ||
    (!includeSqliteSidecars &&
      (name.endsWith('.sqlite-wal') || name.endsWith('.sqlite-shm')))
  )
}

async function ensureDirectory(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true })
}

async function listDataEntries(dirPath: string, includeSqliteSidecars = false) {
  try {
    return (await fs.readdir(dirPath, { withFileTypes: true })).filter(
      (entry) =>
        !shouldIgnoreCopiedDataEntry(entry.name, includeSqliteSidecars),
    )
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return []
    }
    throw error
  }
}

async function copyDirectoryContents(
  sourceDir: string,
  targetDir: string,
  includeSqliteSidecars = false,
) {
  await ensureDirectory(targetDir)
  const entries = await listDataEntries(sourceDir, includeSqliteSidecars)

  for (const entry of entries) {
    const source = path.join(sourceDir, entry.name)
    const destination = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      await copyDirectoryContents(source, destination, includeSqliteSidecars)
    } else if (entry.isFile()) {
      try {
        await fs.copyFile(source, destination, constants.COPYFILE_FICLONE_FORCE)
      } catch (error) {
        if (
          !['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        )
          throw error
        await pipeline(
          createReadStream(source, { highWaterMark: 64 * 1024 }),
          createWriteStream(destination, { mode: 0o600 }),
        )
      }
    } else {
      throw new Error('Backup data contains a link or unsupported file.')
    }
  }
}

export type ValidatedLocalDatabase = {
  knifeCount: number
  schemaVersion: number
}

export async function withLocalRestoreLease<T>(
  request: Request,
  action: (lease: VaultRestoreLease) => Promise<T>,
): Promise<T | Response> {
  let lease: VaultRestoreLease | null = null
  try {
    const expected = request.headers.get(VAULT_GENERATION_HEADER)
    if (expected) assertVaultGeneration(expected)
    lease = acquireVaultRestore()
    if (expected) assertVaultGeneration(expected)
    await lease.waitForWriters()
    return await action(lease)
  } catch (error) {
    const busy = vaultAccessErrorResponse(error)
    if (busy) return busy
    throw error
  } finally {
    lease?.release()
  }
}

export function validateLocalDatabase(dbPath: string): ValidatedLocalDatabase {
  const database = new Database(dbPath, {
    fileMustExist: true,
    readonly: true,
  })

  try {
    const integrityRow = database.prepare('PRAGMA integrity_check;').get() as
      Record<string, string> | undefined
    if (!integrityRow || Object.values(integrityRow)[0] !== 'ok') {
      throw new Error('Backup SQLite database failed integrity_check.')
    }

    const schemaVersion = Number(
      database.pragma('user_version', { simple: true }),
    )
    if (!Number.isInteger(schemaVersion) || schemaVersion < 0) {
      throw new Error('Backup SQLite database has an invalid schema version.')
    }
    if (schemaVersion > LOCAL_DB_SCHEMA_VERSION) {
      throw new Error(
        `Backup database schema ${schemaVersion} requires a newer BladeVault version.`,
      )
    }

    const requiredTables = [
      'knives',
      'settings',
      ...(schemaVersion >= 3 ? ['audit_log'] : []),
      ...(schemaVersion >= 4 ? ['maintenance_events'] : []),
      ...(schemaVersion >= 5 ? ['comparison_lists', 'comparison_items'] : []),
      ...(schemaVersion >= 6
        ? ['webpage_screenshots', 'screenshot_backfill']
        : []),
    ]
    const tableRows = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
    const tableNames = new Set(tableRows.map((row) => row.name))
    const missingTable = requiredTables.find((name) => !tableNames.has(name))
    if (missingTable) {
      throw new Error(
        `Backup SQLite database is missing the ${missingTable} table.`,
      )
    }

    const countRow = database
      .prepare('SELECT COUNT(*) AS total FROM knives')
      .get() as { total?: number } | undefined

    return {
      knifeCount: Number(countRow?.total ?? 0),
      schemaVersion,
    }
  } finally {
    database.close()
  }
}

async function saveRestoreJournal(
  dataDir: string,
  journal: LocalRestoreJournal,
) {
  const journalPath = getLocalRestoreJournalPath(dataDir)
  const temporaryPath = `${journalPath}.${randomUUID()}.tmp`
  const file = await fs.open(temporaryPath, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(journal))
    await file.sync()
  } finally {
    await file.close()
  }
  try {
    await fs.rename(temporaryPath, journalPath)
  } finally {
    await fs.rm(temporaryPath, { force: true })
  }
}

function invalidateStagedLockSessions(dbPath: string) {
  const database = new Database(dbPath)
  try {
    const password = database
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('app_lock_password') as { value?: string } | undefined
    if (password?.value)
      database
        .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .run('app_lock_session_secret', randomBytes(32).toString('base64url'))
    database.pragma('wal_checkpoint(TRUNCATE)')
    database.pragma('journal_mode = DELETE')
  } finally {
    database.close()
  }
}

export async function replaceLocalDataFromDirectory(
  sourceDir: string,
  options: {
    lease?: VaultRestoreLease
    onApplying?: () => void
  } = {},
) {
  const sourceDbPath = path.join(sourceDir, 'bladevault.sqlite')
  validateLocalDatabase(sourceDbPath)

  const currentDataDir = getLocalDataDirPath()
  const lease = options.lease ?? acquireVaultRestore()
  const stagingDir = path.join(
    currentDataDir,
    `._bladevault-restore-stage-${randomUUID()}`,
  )
  const safetyBackupDir = path.join(
    currentDataDir,
    `._bladevault-before-restore-${Date.now()}-${randomUUID()}.bak`,
  )
  let journal: LocalRestoreJournal | null = null
  let retainRecoveryGate = false
  let restoreGuard = false
  let published = false
  try {
    await lease.waitForWriters()
    await ensureDirectory(currentDataDir)
    // Stage on the data filesystem, including Docker bind mounts. All expensive
    // copying and integrity checks finish while the old vault remains readable.
    await copyDirectoryContents(sourceDir, stagingDir)
    const stagedDbPath = path.join(stagingDir, 'bladevault.sqlite')
    invalidateStagedLockSessions(stagedDbPath)
    validateLocalDatabase(stagedDbPath)
    await clearDockerImageCache()
    captureAppLockAccessSnapshot()
    options.onApplying?.()
    await lease.beginSwitch()
    beginLocalRestore()
    restoreGuard = true
    closeLocalDb()
    clearStorageCache()
    await ensureDirectory(safetyBackupDir)
    journal = {
      ownerPid: process.pid,
      ownerStartedAt: performance.timeOrigin,
      state: 'switching',
      stagingDir,
      safetyBackupDir,
      oldEntries: (await listDataEntries(currentDataDir, true)).map(
        (entry) => entry.name,
      ),
      newEntries: (await listDataEntries(stagingDir)).map(
        (entry) => entry.name,
      ),
    }
    await saveRestoreJournal(currentDataDir, journal)
    try {
      // Move top-level entries, rather than renaming the mounted data directory.
      // The protected interval performs no bulk image copies.
      for (const name of journal.oldEntries)
        await fs.rename(
          path.join(currentDataDir, name),
          path.join(safetyBackupDir, name),
        )
      for (const name of journal.newEntries)
        await fs.rename(
          path.join(stagingDir, name),
          path.join(currentDataDir, name),
        )
      journal.state = 'committed'
      await saveRestoreJournal(currentDataDir, journal)
    } catch (error) {
      try {
        rollbackLocalRestore(currentDataDir, journal)
        await fs.rm(getLocalRestoreJournalPath(currentDataDir), { force: true })
        journal = null
      } catch (rollbackError) {
        retainRecoveryGate = true
        throw new Error(
          'Restore could not complete. The safety copy is retained and the vault is protected until recovery succeeds.',
          { cause: rollbackError },
        )
      }
      throw error
    }
    endLocalRestore()
    restoreGuard = false
    lease.finish(true)
    published = true
    await fs
      .rm(getLocalRestoreJournalPath(currentDataDir), { force: true })
      .catch(() => {})
    const safetyBackupCreated = journal.oldEntries.length > 0
    journal = null
    return {
      ok: true,
      restoredAt: new Date().toISOString(),
      safetyBackupCreated,
      generation: getVaultGeneration(currentDataDir),
    }
  } catch (error) {
    if (journal?.state === 'committed' && !published) retainRecoveryGate = true
    throw error
  } finally {
    if (restoreGuard) endLocalRestore()
    if (retainRecoveryGate) lease.abandon()
    else lease.release()
    // Keep staged recovery files if rollback failed. The next process recovers
    // them before any connection can open the live database.
    if (!journal)
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
  }
}
