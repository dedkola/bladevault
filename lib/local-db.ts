import Database from 'better-sqlite3'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  getPersistedLocalDataDirPreference,
  savePersistedLocalDataDirPreference,
} from '@/lib/local-data-config'
import { normalizeKnifeTextFields } from '@/lib/knife-text'

function joinProjectPath(...segments: string[]): string {
  return path.join(/* turbopackIgnore: true */ process.cwd(), ...segments)
}

const LEGACY_DATA_DIR = joinProjectPath('data')

export const LOCAL_DB_SCHEMA_VERSION = 2

function joinRuntimePath(basePath: string, ...segments: string[]): string {
  return path.join(/* turbopackIgnore: true */ basePath, ...segments)
}

function getDefaultHomeDataDir(): string {
  const homeDir = os.homedir().trim()
  return homeDir
    ? joinRuntimePath(homeDir, 'BladeVault', 'data')
    : LEGACY_DATA_DIR
}

function getLegacyDesktopDataDirs(): string[] {
  if (process.platform !== 'darwin') {
    return []
  }

  const homeDir = os.homedir().trim()
  if (!homeDir) {
    return []
  }

  const appSupportDir = joinRuntimePath(
    homeDir,
    'Library',
    'Application Support',
  )
  return [
    joinRuntimePath(appSupportDir, 'BladeVault', 'data'),
    joinRuntimePath(appSupportDir, 'bladevault', 'data'),
  ]
}

function hasExistingDb(dataDir: string): boolean {
  return fs.existsSync(joinRuntimePath(dataDir, 'bladevault.sqlite'))
}

function getExistingDbKnifeCount(dataDir: string): number {
  const dbPath = joinRuntimePath(dataDir, 'bladevault.sqlite')

  let dbHandle: Database.Database | null = null
  try {
    dbHandle = new Database(dbPath, {
      readonly: true,
      fileMustExist: true,
    })

    const tableExists = dbHandle
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'knives' LIMIT 1",
      )
      .get()

    if (!tableExists) {
      return 0
    }

    const result = dbHandle
      .prepare('SELECT COUNT(*) AS total FROM knives')
      .get() as { total?: number } | undefined
    return Number(result?.total ?? 0)
  } catch {
    return 0
  } finally {
    dbHandle?.close()
  }
}

function normalizeConfiguredDataDir(value: string): string {
  return path.resolve(value)
}

export function isLocalDataDirManagedByEnv(): boolean {
  return Boolean(process.env.BLADEVAULT_DATA_DIR?.trim())
}

export function isDesktopRuntime(): boolean {
  return process.env.BLADEVAULT_DESKTOP_RUNTIME === '1'
}

export function getDefaultLocalDataDirPath(): string {
  return getDefaultHomeDataDir()
}

export function getConfiguredLocalDataDirPath(): string | null {
  const configuredDataDir = process.env.BLADEVAULT_DATA_DIR?.trim()
  if (configuredDataDir) {
    return normalizeConfiguredDataDir(configuredDataDir)
  }

  return getPersistedLocalDataDirPreference()
}

function resolveDataDir(): string {
  const configuredDataDir = getConfiguredLocalDataDirPath()
  if (configuredDataDir) {
    return configuredDataDir
  }

  const homeDataDir = getDefaultHomeDataDir()
  const existingCandidates = [
    homeDataDir,
    LEGACY_DATA_DIR,
    ...getLegacyDesktopDataDirs(),
  ].filter((candidate, index, allCandidates) => {
    const normalized = path.resolve(candidate)
    return (
      allCandidates.findIndex(
        (otherCandidate) => path.resolve(otherCandidate) === normalized,
      ) === index && hasExistingDb(candidate)
    )
  })

  if (existingCandidates.length > 0) {
    // Prefer the existing database with the most knives to keep desktop upgrades on the active vault.
    const [bestCandidate] = existingCandidates
      .map((candidate) => ({
        candidate,
        knifeCount: getExistingDbKnifeCount(candidate),
      }))
      .sort((left, right) => right.knifeCount - left.knifeCount)

    if (bestCandidate) {
      return bestCandidate.candidate
    }
  }

  return homeDataDir
}

let db: Database.Database | null = null
let activeDbPath: string | null = null
let restoreInProgress = false

export function beginLocalRestore(): void {
  restoreInProgress = true
}

export function endLocalRestore(): void {
  restoreInProgress = false
}

export function getLocalDataDirPath(): string {
  return resolveDataDir()
}

export function getLocalDbPath(): string {
  return joinRuntimePath(getLocalDataDirPath(), 'bladevault.sqlite')
}

export function getLocalImagesDirPath(): string {
  return joinRuntimePath(getLocalDataDirPath(), 'images')
}

export function setPersistedLocalDataDirPath(
  nextDataDir: string | null,
): string | null {
  if (isLocalDataDirManagedByEnv()) {
    throw new Error(
      'This runtime is managed by BLADEVAULT_DATA_DIR and cannot be changed from the app.',
    )
  }

  return savePersistedLocalDataDirPreference(nextDataDir)
}

export function isContainerizedRuntime(): boolean {
  return (
    fs.existsSync('/.dockerenv') ||
    fs.existsSync('/run/.containerenv') ||
    Boolean(process.env.KUBERNETES_SERVICE_HOST)
  )
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octalValue: string) =>
    String.fromCharCode(Number.parseInt(octalValue, 8)),
  )
}

function readMountInfoForPath(targetPath: string) {
  try {
    const lines = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n')
    const resolvedTarget = path.normalize(targetPath)
    let bestMatch: {
      mountPoint: string
      root: string
      source: string
    } | null = null

    for (const line of lines) {
      if (!line) continue

      const separatorIndex = line.indexOf(' - ')
      if (separatorIndex === -1) continue

      const left = line.slice(0, separatorIndex).split(' ')
      const right = line.slice(separatorIndex + 3).split(' ')

      if (left.length < 5 || right.length < 2) continue

      const mountPoint = decodeMountInfoPath(left[4])
      if (
        resolvedTarget !== mountPoint &&
        !resolvedTarget.startsWith(`${mountPoint}${path.sep}`)
      ) {
        continue
      }

      if (bestMatch && mountPoint.length <= bestMatch.mountPoint.length) {
        continue
      }

      bestMatch = {
        mountPoint,
        root: decodeMountInfoPath(left[3]),
        source: decodeMountInfoPath(right[1]),
      }
    }

    return bestMatch
  } catch {
    return null
  }
}

export function getDockerHostDataMountPath(): string | null {
  const configuredMountPath = process.env.BLADEVAULT_HOST_DATA_DIR?.trim()
  if (configuredMountPath) {
    return configuredMountPath
  }

  if (!isContainerizedRuntime()) {
    return null
  }

  const mountInfo = readMountInfoForPath(getLocalDataDirPath())
  if (!mountInfo || mountInfo.mountPoint !== getLocalDataDirPath()) {
    return null
  }

  if (mountInfo.root && mountInfo.root !== '/') {
    return mountInfo.root
  }

  if (
    mountInfo.source &&
    mountInfo.source !== 'none' &&
    !mountInfo.source.startsWith('/dev/')
  ) {
    return mountInfo.source
  }

  return null
}

export function getLocalDb(): Database.Database {
  if (restoreInProgress) {
    throw new Error(
      'Local database restore is in progress. Please try again in a moment.',
    )
  }

  const nextDbPath = getLocalDbPath()
  if (db && activeDbPath && activeDbPath !== nextDbPath) {
    db.close()
    db = null
    activeDbPath = null
  }

  if (!db) {
    fs.mkdirSync(path.dirname(nextDbPath), { recursive: true })
    db = new Database(nextDbPath)
    db.pragma('journal_mode = WAL')
    initSchema(db)
    activeDbPath = nextDbPath
  }
  return db
}

export function closeLocalDb(): void {
  if (!db) return
  try {
    db.pragma('wal_checkpoint(RESTART)')
  } catch {
    // Best effort: checkpoint when possible, but always close.
  }
  db.close()
  db = null
  activeDbPath = null
}

function migrateSchema(database: Database.Database) {
  const columns = database
    .prepare("SELECT name FROM pragma_table_info('knives')")
    .all() as Array<{ name: string }>
  const hasSourceUrl = columns.some((col) => col.name === 'source_url')
  if (!hasSourceUrl) {
    database.exec(
      `ALTER TABLE knives ADD COLUMN source_url TEXT NOT NULL DEFAULT ''`,
    )
  }
  const hasPinned = columns.some((col) => col.name === 'pinned')
  if (!hasPinned) {
    database.exec(
      `ALTER TABLE knives ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`,
    )
  }
  const hasUpdatedAt = columns.some((col) => col.name === 'updated_at')
  if (!hasUpdatedAt) {
    database.exec(`ALTER TABLE knives ADD COLUMN updated_at TEXT`)
  }
  const hasCustomFields = columns.some((col) => col.name === 'custom_fields')
  if (!hasCustomFields) {
    database.exec(
      `ALTER TABLE knives ADD COLUMN custom_fields TEXT NOT NULL DEFAULT '{}'`,
    )
  }
  database
    .prepare(
      `UPDATE knives
       SET updated_at = added_at
       WHERE updated_at IS NULL OR TRIM(updated_at) = ''`,
    )
    .run()

  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as Array<{ name: string }>
  const hasCompareList = tables.some((t) => t.name === 'compare_list')
  if (!hasCompareList) {
    database.exec(`
      CREATE TABLE compare_list (
        knife_id TEXT PRIMARY KEY,
        added_at TEXT NOT NULL
      );
    `)
  }

  const hasKnifeActivity = tables.some((t) => t.name === 'knife_activity')
  if (!hasKnifeActivity) {
    database.exec(`
      CREATE TABLE knife_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        knife_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('created', 'updated')),
        occurred_at TEXT NOT NULL
      );

      CREATE INDEX knife_activity_occurred_at_idx
      ON knife_activity (occurred_at);

      CREATE INDEX knife_activity_knife_id_idx
      ON knife_activity (knife_id);

      INSERT INTO knife_activity (knife_id, event_type, occurred_at)
      SELECT id, 'created', added_at
      FROM knives;

      INSERT INTO knife_activity (knife_id, event_type, occurred_at)
      SELECT id, 'updated', updated_at
      FROM knives
      WHERE updated_at <> added_at;
    `)
  }

  const hasKnifeChangeLog = tables.some((t) => t.name === 'knife_change_log')
  if (!hasKnifeChangeLog) {
    database.exec(`
      CREATE TABLE knife_change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL,
        knife_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('mcp')),
        transport TEXT NOT NULL CHECK (transport IN ('stdio', 'http')),
        changes TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );

      CREATE INDEX knife_change_log_knife_id_idx
      ON knife_change_log (knife_id);

      CREATE INDEX knife_change_log_occurred_at_idx
      ON knife_change_log (occurred_at);
    `)
  }

  normalizeKnifeRows(database)
}

function normalizeKnifeRows(database: Database.Database) {
  const rows = database
    .prepare(
      `
    SELECT id, name, brand, blade_style, handle_material, specs, custom_fields, description, source_url, added_at, updated_at
    FROM knives
  `,
    )
    .all() as Array<{
    id: string
    name: string
    brand: string
    blade_style: string
    handle_material: string
    specs: string
    custom_fields: string
    description: string
    source_url: string
    added_at: string
    updated_at: string | null
  }>

  if (rows.length === 0) {
    return
  }

  const updateKnife = database.prepare(`
    UPDATE knives
    SET name = ?, brand = ?, blade_style = ?, handle_material = ?, specs = ?, description = ?, source_url = ?, updated_at = ?, custom_fields = ?
    WHERE id = ?
  `)

  const normalizeRows = database.transaction((items: typeof rows) => {
    for (const row of items) {
      const specs = JSON.parse(row.specs) as Partial<{
        weight: string
        overallLength: string
        bladeLength: string
        bladeThickness?: string
        bladeCoating?: string
        bladeMaterial?: string
        lockingMechanism?: string
        designer?: string
        modelNumber?: string
        handleLength?: string
        hardness?: string
        price?: string
        country: string
      }>
      const customFields = row.custom_fields
        ? (JSON.parse(row.custom_fields) as Record<string, string>)
        : {}
      const normalized = normalizeKnifeTextFields({
        name: row.name,
        brand: row.brand,
        bladeStyle: row.blade_style,
        handleMaterial: row.handle_material,
        description: row.description,
        sourceUrl: row.source_url,
        specs,
        customFields,
      })

      const normalizedSpecs = JSON.stringify(normalized.specs ?? {})
      const normalizedCustomFields = JSON.stringify(
        normalized.customFields ?? {},
      )
      const normalizedUpdatedAt =
        row.updated_at?.trim() || row.added_at || new Date().toISOString()
      const hasChanges =
        normalized.name !== row.name ||
        normalized.brand !== row.brand ||
        normalized.bladeStyle !== row.blade_style ||
        normalized.handleMaterial !== row.handle_material ||
        normalized.description !== row.description ||
        normalized.sourceUrl !== row.source_url ||
        normalizedSpecs !== row.specs ||
        normalizedCustomFields !== row.custom_fields ||
        normalizedUpdatedAt !== (row.updated_at ?? '')

      if (!hasChanges) {
        continue
      }

      updateKnife.run(
        normalized.name,
        normalized.brand,
        normalized.bladeStyle,
        normalized.handleMaterial,
        normalizedSpecs,
        normalized.description,
        normalized.sourceUrl,
        normalizedUpdatedAt,
        normalizedCustomFields,
        row.id,
      )
    }
  })

  normalizeRows(rows)
}

function initSchema(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS knives (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      brand TEXT NOT NULL,
      steel TEXT NOT NULL DEFAULT '',
      blade_style TEXT NOT NULL,
      handle_material TEXT NOT NULL,
      images TEXT NOT NULL,
      specs TEXT NOT NULL,
      custom_fields TEXT NOT NULL DEFAULT '{}',
      description TEXT NOT NULL,
      added_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source_url TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0
    );
  `)

  database.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  migrateSchema(database)

  const currentSchemaVersion = Number(
    database.pragma('user_version', { simple: true }),
  )
  if (currentSchemaVersion < LOCAL_DB_SCHEMA_VERSION) {
    database.pragma(`user_version = ${LOCAL_DB_SCHEMA_VERSION}`)
  }
}
