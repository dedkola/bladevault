import fs from 'fs'
import os from 'os'
import path from 'path'

type BladeVaultConfig = {
  localDataDir?: string
}

/**
 * Under Vitest, refuse every default data-folder lookup (persisted preference,
 * home and legacy folders) so a test can never reach a personal vault. Async
 * work that outlives `createTempVault().cleanup()` lands here instead.
 */
export function assertDataDirDiscoveryAllowed(): void {
  if (process.env.VITEST && !process.env.BLADEVAULT_DATA_DIR?.trim()) {
    const error = new Error(
      'BladeVault test guard: BLADEVAULT_DATA_DIR is not set, so the vault ' +
        'folder would come from default discovery and could open a real vault. ' +
        'Use createTempVault() from tests/helpers/temp-vault.ts, and await or ' +
        'stop background vault work before calling its cleanup().',
    )
    // Background work often swallows errors; Vitest attributes this log to the
    // test that was running, which names the leak.
    console.error(error)
    throw error
  }
}

function getConfigRootDir(): string {
  assertDataDirDiscoveryAllowed()
  const homeDir = os.homedir().trim()
  if (!homeDir) {
    return process.cwd()
  }

  return path.join(homeDir, 'BladeVault')
}

export function getBladeVaultConfigPath(): string {
  return path.join(getConfigRootDir(), 'config.json')
}

function readConfig(): BladeVaultConfig {
  // Resolved outside the try so the test guard's error is not swallowed.
  const configPath = getBladeVaultConfigPath()
  try {
    const raw = fs.readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(raw) as BladeVaultConfig
    if (!parsed || typeof parsed !== 'object') {
      return {}
    }

    return parsed
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return {}
    }

    return {}
  }
}

function normalizeDataDir(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error('Choose a local data folder before saving.')
  }

  return path.resolve(trimmed)
}

export function getPersistedLocalDataDirPreference(): string | null {
  const configuredDataDir = readConfig().localDataDir
  if (!configuredDataDir || !configuredDataDir.trim()) {
    return null
  }

  return normalizeDataDir(configuredDataDir)
}

export function savePersistedLocalDataDirPreference(
  nextDataDir: string | null,
): string | null {
  const current = readConfig()
  const normalizedDataDir = nextDataDir ? normalizeDataDir(nextDataDir) : null

  if (normalizedDataDir) {
    current.localDataDir = normalizedDataDir
  } else {
    delete current.localDataDir
  }

  fs.mkdirSync(path.dirname(getBladeVaultConfigPath()), { recursive: true })
  fs.writeFileSync(
    getBladeVaultConfigPath(),
    `${JSON.stringify(current, null, 2)}\n`,
    'utf8',
  )

  return normalizedDataDir
}
