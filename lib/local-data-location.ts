import fs from 'fs/promises'
import path from 'path'
import { clearStorageCache } from '@/lib/storage'
import {
  closeLocalDb,
  getConfiguredLocalDataDirPath,
  getDefaultLocalDataDirPath,
  getLocalDataDirPath,
  isDesktopRuntime,
  isLocalDataDirManagedByEnv,
  setPersistedLocalDataDirPath,
} from '@/lib/local-db'

type UpdateLocalDataDirectoryInput = {
  nextDataDir: string
  moveExistingData: boolean
}

export type UpdateLocalDataDirectoryResult = {
  configuredLocalDataPath: string | null
  defaultLocalDataPath: string
  didMoveExistingData: boolean
  localDataPath: string
  message: string
  warning?: string
}

function isIgnorableEntry(name: string): boolean {
  return name === '.DS_Store' || name === '__MACOSX' || name.startsWith('._')
}

function normalizeDataDir(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error('Enter a local data folder path before saving.')
  }

  return path.resolve(trimmed)
}

function isSamePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right)
}

function isNestedPath(parentPath: string, childPath: string): boolean {
  const normalizedParent = path.resolve(parentPath)
  const normalizedChild = path.resolve(childPath)
  return normalizedChild.startsWith(`${normalizedParent}${path.sep}`)
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function listManagedEntries(dirPath: string) {
  try {
    return (await fs.readdir(dirPath, { withFileTypes: true })).filter(
      (entry) => !isIgnorableEntry(entry.name),
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

async function ensureEmptyDirectory(dirPath: string) {
  const exists = await pathExists(dirPath)
  if (!exists) {
    return
  }

  const entries = await listManagedEntries(dirPath)
  if (entries.length > 0) {
    throw new Error(
      'Choose an empty folder before moving your existing local vault.',
    )
  }
}

async function copyManagedEntries(sourceDir: string, targetDir: string) {
  const entries = await listManagedEntries(sourceDir)
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

async function removeManagedEntries(dirPath: string) {
  const entries = await listManagedEntries(dirPath)
  for (const entry of entries) {
    await fs.rm(path.join(dirPath, entry.name), {
      recursive: true,
      force: true,
    })
  }
}

export async function updateLocalDataDirectory({
  nextDataDir,
  moveExistingData,
}: UpdateLocalDataDirectoryInput): Promise<UpdateLocalDataDirectoryResult> {
  if (!isDesktopRuntime()) {
    throw new Error(
      'Changing the local data folder is only available in the desktop app.',
    )
  }

  if (isLocalDataDirManagedByEnv()) {
    throw new Error(
      'This runtime is managed by BLADEVAULT_DATA_DIR and cannot be changed from the app.',
    )
  }

  const currentDataDir = getLocalDataDirPath()
  const targetDataDir = normalizeDataDir(nextDataDir)

  if (
    moveExistingData &&
    (isNestedPath(currentDataDir, targetDataDir) ||
      isNestedPath(targetDataDir, currentDataDir))
  ) {
    throw new Error(
      'Choose a folder outside the current local data folder when moving data.',
    )
  }

  closeLocalDb()
  clearStorageCache()

  let warning = ''

  if (moveExistingData && !isSamePath(currentDataDir, targetDataDir)) {
    await ensureEmptyDirectory(targetDataDir)
    await fs.mkdir(targetDataDir, { recursive: true })
    await copyManagedEntries(currentDataDir, targetDataDir)
  } else {
    await fs.mkdir(targetDataDir, { recursive: true })
  }

  setPersistedLocalDataDirPath(targetDataDir)

  if (moveExistingData && !isSamePath(currentDataDir, targetDataDir)) {
    try {
      await removeManagedEntries(currentDataDir)
    } catch {
      warning =
        'BladeVault switched to the new folder, but the old local files could not be removed automatically.'
    }
  }

  const didMoveExistingData =
    moveExistingData && !isSamePath(currentDataDir, targetDataDir)
  const message = didMoveExistingData
    ? 'Local data folder updated and existing data moved.'
    : 'Local data folder updated.'

  return {
    configuredLocalDataPath: getConfiguredLocalDataDirPath(),
    defaultLocalDataPath: getDefaultLocalDataDirPath(),
    didMoveExistingData,
    localDataPath: getLocalDataDirPath(),
    message,
    warning: warning || undefined,
  }
}
