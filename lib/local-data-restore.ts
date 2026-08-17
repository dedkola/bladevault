import Database from 'better-sqlite3'
import fs from 'fs/promises'
import path from 'path'
import { clearStorageCache } from '@/lib/storage'
import {
  beginLocalRestore,
  closeLocalDb,
  endLocalRestore,
  getLocalDataDirPath,
  LOCAL_DB_SCHEMA_VERSION,
} from '@/lib/local-db'

function shouldIgnoreDataEntry(name: string): boolean {
  return (
    name === '.DS_Store' ||
    name === '__MACOSX' ||
    name.startsWith('._') ||
    name.endsWith('.sqlite-wal') ||
    name.endsWith('.sqlite-shm')
  )
}

async function ensureDirectory(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true })
}

async function listDataEntries(dirPath: string) {
  try {
    return (await fs.readdir(dirPath, { withFileTypes: true })).filter(
      (entry) => !shouldIgnoreDataEntry(entry.name),
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

async function copyDirectoryContents(sourceDir: string, targetDir: string) {
  await ensureDirectory(targetDir)
  const entries = await listDataEntries(sourceDir)

  for (const entry of entries) {
    await fs.cp(
      path.join(sourceDir, entry.name),
      path.join(targetDir, entry.name),
      {
        recursive: true,
        force: true,
      },
    )
  }
}

async function removeDirectoryContents(dirPath: string) {
  const entries = await listDataEntries(dirPath)

  for (const entry of entries) {
    await fs.rm(path.join(dirPath, entry.name), {
      recursive: true,
      force: true,
    })
  }
}

export type ValidatedLocalDatabase = {
  knifeCount: number
  schemaVersion: number
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

    const requiredTables = ['knives', 'settings']
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

export async function replaceLocalDataFromDirectory(sourceDir: string) {
  const sourceDbPath = path.join(sourceDir, 'bladevault.sqlite')
  validateLocalDatabase(sourceDbPath)

  const currentDataDir = getLocalDataDirPath()
  const safetyBackupDir = `${currentDataDir}.before-restore-${Date.now()}.bak`
  let safetyBackupCreated = false

  beginLocalRestore()
  closeLocalDb()
  clearStorageCache()

  try {
    await ensureDirectory(currentDataDir)
    await fs.rm(safetyBackupDir, { recursive: true, force: true })
    await copyDirectoryContents(currentDataDir, safetyBackupDir)
    safetyBackupCreated = (await listDataEntries(safetyBackupDir)).length > 0

    try {
      await removeDirectoryContents(currentDataDir)
      await copyDirectoryContents(sourceDir, currentDataDir)
      validateLocalDatabase(path.join(currentDataDir, 'bladevault.sqlite'))
    } catch (error) {
      await removeDirectoryContents(currentDataDir)

      try {
        await copyDirectoryContents(safetyBackupDir, currentDataDir)
      } catch {
        // Best effort rollback if restoring the safety copy also fails.
      }

      throw error
    }
  } finally {
    endLocalRestore()
  }

  return {
    ok: true,
    restoredAt: new Date().toISOString(),
    safetyBackupCreated,
  }
}
