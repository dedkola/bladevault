import Database from 'better-sqlite3'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  assertDataDirDiscoveryAllowed,
  getPersistedLocalDataDirPreference,
  savePersistedLocalDataDirPreference,
} from '@/lib/local-data-config'
import { normalizeKnifeTextFields } from '@/lib/knife-text'
import { backfillNewStoreEvents } from '@/lib/price-monitor/new-store'
import {
  assertVaultReadable,
  getVaultAccessState,
  registerVaultConnection,
  VaultAccessError,
  withVaultWriteSync,
} from '@/lib/vault-access'

function joinProjectPath(...segments: string[]): string {
  return path.join(/* turbopackIgnore: true */ process.cwd(), ...segments)
}

const LEGACY_DATA_DIR = joinProjectPath('data')

export const LOCAL_DB_SCHEMA_VERSION = 19

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

  // The config read above already enforces this; the home and legacy
  // discovery below must stay unreachable in tests even if that changes.
  assertDataDirDiscoveryAllowed()

  const homeDataDir = getDefaultHomeDataDir()
  return discoverExistingDataDir(
    [homeDataDir, LEGACY_DATA_DIR, ...getLegacyDesktopDataDirs()],
    homeDataDir,
  )
}

const DATA_DIR_DISCOVERY_KEY = Symbol.for('bladevault.data-dir-discovery')

function discoveryCache(): { dataDir?: string } {
  const runtimeGlobal = globalThis as typeof globalThis & {
    [DATA_DIR_DISCOVERY_KEY]?: { dataDir?: string }
  }
  return (runtimeGlobal[DATA_DIR_DISCOVERY_KEY] ??= {})
}

/** Forget the discovered vault so the next lookup scans candidates again. */
export function clearDataDirDiscoveryCache(): void {
  delete discoveryCache().dataDir
}

/** Identifies a database file so case or symlink aliases count once. */
function dbFileIdentity(dataDir: string): string {
  const stats = fs.statSync(joinRuntimePath(dataDir, 'bladevault.sqlite'))
  return `${stats.dev}:${stats.ino}`
}

/**
 * Picks the existing database with the most knives to keep desktop upgrades on
 * the active vault. The vault path is resolved on nearly every request, and
 * counting knives opens each candidate database, which dirties its WAL index.
 * Remember the result for the process so discovery runs once, not per query.
 */
export function discoverExistingDataDir(
  candidates: string[],
  fallback: string,
): string {
  const cache = discoveryCache()
  if (
    cache.dataDir &&
    candidates.includes(cache.dataDir) &&
    hasExistingDb(cache.dataDir)
  ) {
    return cache.dataDir
  }

  const seen = new Set<string>()
  const existingCandidates = candidates.filter((candidate) => {
    if (!hasExistingDb(candidate)) return false
    let identity: string
    try {
      identity = dbFileIdentity(candidate)
    } catch {
      identity = path.resolve(candidate)
    }
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })

  const [bestCandidate] = existingCandidates
    .map((candidate) => ({
      candidate,
      knifeCount: getExistingDbKnifeCount(candidate),
    }))
    .sort((left, right) => right.knifeCount - left.knifeCount)

  if (!bestCandidate) {
    // Nothing exists yet; check again later instead of pinning the fallback.
    delete cache.dataDir
    return fallback
  }
  cache.dataDir = bestCandidate.candidate
  return bestCandidate.candidate
}

type LocalDbRuntimeState = {
  db: Database.Database | null
  activeDbPath: string | null
  restoreInProgress: boolean
  dbGeneration?: string | null
  releaseConnection?: (() => void) | null
}

const LOCAL_DB_RUNTIME_STATE_KEY = Symbol.for(
  'bladevault.local-db-runtime-state',
)

function getLocalDbRuntimeState(): LocalDbRuntimeState {
  const runtimeGlobal = globalThis as typeof globalThis & {
    [key: symbol]: LocalDbRuntimeState | undefined
  }

  runtimeGlobal[LOCAL_DB_RUNTIME_STATE_KEY] ??= {
    db: null,
    activeDbPath: null,
    restoreInProgress: false,
  }

  return runtimeGlobal[LOCAL_DB_RUNTIME_STATE_KEY]
}

export function beginLocalRestore(): void {
  const state = getLocalDbRuntimeState()
  if (state.restoreInProgress) {
    throw new Error('A local database restore is already in progress.')
  }
  state.restoreInProgress = true
}

export function endLocalRestore(): void {
  getLocalDbRuntimeState().restoreInProgress = false
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

  const saved = savePersistedLocalDataDirPreference(nextDataDir)
  clearDataDirDiscoveryCache()
  return saved
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
  const state = getLocalDbRuntimeState()
  const access = getVaultAccessState()

  if (
    state.db &&
    (!state.dbGeneration ||
      access.phase === 'switching' ||
      (state.dbGeneration && state.dbGeneration !== access.generation))
  )
    closeLocalDb()
  assertVaultReadable()

  if (state.restoreInProgress) {
    throw new VaultAccessError('VAULT_RESTORE_BUSY', {
      ...access,
      phase: 'switching',
      readOnly: true,
    })
  }

  const nextDbPath = getLocalDbPath()
  if (state.db && state.activeDbPath && state.activeDbPath !== nextDbPath) {
    closeLocalDb()
  }

  if (!state.db) {
    const release = registerVaultConnection(closeLocalDb)
    state.releaseConnection = release
    try {
      fs.mkdirSync(path.dirname(nextDbPath), { recursive: true })
      state.db = new Database(nextDbPath)
      if (
        access.phase !== 'preparing' ||
        Number(state.db.pragma('user_version', { simple: true })) !==
          LOCAL_DB_SCHEMA_VERSION
      ) {
        withVaultWriteSync(() => {
          state.db!.pragma('journal_mode = WAL')
          initSchema(state.db!)
        })
      }
      state.activeDbPath = nextDbPath
      state.dbGeneration = access.generation
    } catch (error) {
      closeLocalDb()
      throw error
    }
  }
  return state.db
}

export function closeLocalDb(): void {
  const state = getLocalDbRuntimeState()
  if (state.db) {
    try {
      state.db.pragma('wal_checkpoint(RESTART)')
    } catch {
      // Best effort: checkpoint when possible, but always close.
    }
    state.db.close()
  }
  state.db = null
  state.activeDbPath = null
  state.dbGeneration = null
  state.releaseConnection?.()
  state.releaseConnection = null
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
  const hasSold = columns.some((col) => col.name === 'sold')
  if (!hasSold) {
    database.exec(
      `ALTER TABLE knives ADD COLUMN sold INTEGER NOT NULL DEFAULT 0`,
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

  // The table-existence guard makes migration repeat-safe, even before user_version
  // is advanced. Clear legacy rows in the same transaction to avoid resurrection.
  if (!tables.some((table) => table.name === 'comparison_lists')) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE comparison_lists (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          differences_only INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE comparison_items (
          list_id TEXT NOT NULL REFERENCES comparison_lists(id) ON DELETE CASCADE,
          knife_id TEXT NOT NULL REFERENCES knives(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          PRIMARY KEY (list_id, knife_id)
        );
        CREATE INDEX comparison_items_knife ON comparison_items(knife_id);
        CREATE INDEX comparison_items_order ON comparison_items(list_id, position DESC);
      `)
      const legacy = database
        .prepare(
          `SELECT c.knife_id FROM compare_list c
        JOIN knives k ON k.id = c.knife_id ORDER BY c.added_at DESC, c.rowid DESC`,
        )
        .all() as Array<{ knife_id: string }>
      if (legacy.length) {
        const now = new Date().toISOString()
        database
          .prepare(
            `INSERT INTO comparison_lists (id,name,name_key,created_at,updated_at)
          VALUES ('default-comparison','My comparison','my comparison',?,?)`,
          )
          .run(now, now)
        const insert =
          database.prepare(`INSERT INTO comparison_items (list_id,knife_id,position)
          VALUES ('default-comparison',?,?)`)
        legacy.forEach((item, index) =>
          insert.run(item.knife_id, legacy.length - index),
        )
      }
      database.prepare('DELETE FROM compare_list').run()
    })()
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

  const hasAuditLog = tables.some((t) => t.name === 'audit_log')
  if (!hasAuditLog) {
    database.exec(`
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('created', 'updated', 'deleted', 'system')),
        knife_id TEXT,
        subject TEXT NOT NULL,
        actor TEXT NOT NULL,
        source TEXT NOT NULL,
        summary TEXT NOT NULL,
        changes TEXT NOT NULL DEFAULT '[]',
        occurred_at TEXT NOT NULL
      );

      CREATE INDEX audit_log_knife_id_idx
      ON audit_log (knife_id);

      CREATE INDEX audit_log_occurred_at_idx
      ON audit_log (occurred_at);

      CREATE INDEX audit_log_event_type_idx
      ON audit_log (event_type);
    `)

    const changeLogRows = database
      .prepare(
        `SELECT operation_id, knife_id, source, transport, changes, occurred_at
         FROM knife_change_log
         ORDER BY occurred_at ASC, id ASC`,
      )
      .all() as Array<{
      operation_id: string
      knife_id: string
      source: string
      transport: string
      changes: string
      occurred_at: string
    }>

    if (changeLogRows.length > 0) {
      const knifeRows = database
        .prepare(
          `SELECT id, name, brand
           FROM knives
           WHERE id IN (${changeLogRows.map(() => '?').join(', ')})`,
        )
        .all(...changeLogRows.map((row) => row.knife_id)) as Array<{
        id: string
        name: string
        brand: string
      }>
      const knivesById = new Map(knifeRows.map((row) => [row.id, row]))

      const insertAudit = database.prepare(
        `INSERT INTO audit_log
         (operation_id, event_type, knife_id, subject, actor, source, summary, changes, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )

      const migrate = database.transaction(() => {
        for (const row of changeLogRows) {
          const knife = knivesById.get(row.knife_id)
          const subject = knife
            ? `${knife.brand} · ${knife.name}`
            : 'Unknown knife'
          const changes = JSON.parse(row.changes) as Array<{
            field: string
            previousValue: string | boolean
            value: string | boolean
          }>
          insertAudit.run(
            row.operation_id,
            'updated',
            row.knife_id,
            subject,
            'MCP client',
            `MCP / update_knife`,
            'Applied metadata update via MCP.',
            JSON.stringify(
              changes.map((change) => ({
                field: change.field,
                before: String(change.previousValue),
                after: String(change.value),
              })),
            ),
            row.occurred_at,
          )
        }
      })
      migrate()
    }
  }

  const hasMaintenanceEvents = tables.some(
    (t) => t.name === 'maintenance_events',
  )
  if (!hasMaintenanceEvents) {
    database.exec(`
      CREATE TABLE maintenance_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        knife_id TEXT NOT NULL,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        sharpening_details TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (knife_id) REFERENCES knives(id) ON DELETE CASCADE
      );

      CREATE INDEX maintenance_events_knife_id_idx
      ON maintenance_events (knife_id);

      CREATE INDEX maintenance_events_occurred_at_idx
      ON maintenance_events (occurred_at);
    `)
  }

  if (!tables.some((t) => t.name === 'knife_notes')) {
    database.exec(`
      CREATE TABLE knife_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        knife_id TEXT NOT NULL,
        body TEXT NOT NULL,
        images TEXT NOT NULL DEFAULT '[]',
        noted_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (knife_id) REFERENCES knives(id) ON DELETE CASCADE
      );

      CREATE INDEX knife_notes_knife_id_idx ON knife_notes (knife_id);
    `)
  } else {
    const noteColumns = database
      .prepare("SELECT name FROM pragma_table_info('knife_notes')")
      .all() as Array<{ name: string }>
    if (!noteColumns.some((column) => column.name === 'images')) {
      database.exec(
        `ALTER TABLE knife_notes ADD COLUMN images TEXT NOT NULL DEFAULT '[]'`,
      )
    }
  }

  if (!tables.some((t) => t.name === 'care_notifications')) {
    database.exec(`
      CREATE TABLE care_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        knife_id TEXT NOT NULL,
        track TEXT NOT NULL,
        last_at TEXT NOT NULL,
        due_on TEXT NOT NULL,
        level TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        read_at TEXT,
        snoozed_until TEXT,
        dismissed_at TEXT,
        resolved_at TEXT,
        resolution TEXT,
        UNIQUE (knife_id, track, last_at),
        FOREIGN KEY (knife_id) REFERENCES knives(id) ON DELETE CASCADE
      );

      CREATE INDEX care_notifications_knife_id_idx
      ON care_notifications (knife_id);
    `)
  }

  if (!tables.some((t) => t.name === 'system_messages')) {
    database.exec(`
      CREATE TABLE system_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        occurrences INTEGER NOT NULL DEFAULT 1,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        read_at TEXT,
        dismissed_at TEXT,
        resolved_at TEXT
      );
    `)
  }

  migratePriceMonitoringSchema(database, tables)
  migrateAchievementSchema(database, tables)
  migrateWishlistSchema(database, tables)
  migrateChatSchema(database, tables)

  normalizeKnifeRows(database)
}

/** Lanes of the Other stores searches (DISCOVERY_STORES in discovery-stores.ts). */
const OTHER_STORE_LANES = [
  'bladehq.com',
  'smkw.com',
  'dlttrading.com',
  'knifejoy.com',
  'northwestknives.com',
] as const

/**
 * Schema 14: before it, every Other stores search counted as a slow check
 * and stretched its store's gap until one request every few hours held up
 * the store's price checks too. Resets those gaps to the 60 s default once;
 * the worker raises it to the user's floor, and real throttling slows the
 * store again. The next check slot those gaps pushed hours ahead is brought
 * back to now too, or the store's price checks would keep waiting for it.
 * Paused (open) stores keep their cooldown.
 */
function resetOtherStoreLaneGaps(database: Database.Database) {
  const exists = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'price_host_state'",
    )
    .get()
  if (!exists) return
  const now = new Date().toISOString()
  database
    .prepare(
      `UPDATE price_host_state
          SET min_gap_ms = 60000,
              ready_at = CASE WHEN ready_at > ? THEN ? ELSE ready_at END
        WHERE circuit = 'closed' AND min_gap_ms > 60000
          AND lane_key IN (${OTHER_STORE_LANES.map(() => '?').join(', ')})`,
    )
    .run(now, now, ...OTHER_STORE_LANES)
}

/**
 * Schema 15: a product page that shows the knife's exact model number now
 * counts as the knife even when AI worded a spec differently, and other
 * variants are kept as related listings. Searches that were turned down
 * before are due again once, so the new rules look at them right away.
 */
function recheckRejectedSearches(database: Database.Database) {
  const exists = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'price_discovery'",
    )
    .get()
  if (!exists) return
  database
    .prepare(
      "UPDATE price_discovery SET next_attempt_at = ? WHERE status = 'rejected'",
    )
    .run(new Date().toISOString())
}

/**
 * Chat (schema 17): conversations from the Chat page and their messages.
 * Tool messages keep the result sent to the model (`content`) and what the
 * page draws for it (`ui_data`). Schema 18 gives each chat its own model
 * and reasoning level ('' = not chosen) and when they were last picked
 * (`choice_at`, for where a new chat starts). Additive and repeat-safe.
 */
function migrateChatSchema(
  database: Database.Database,
  tables: Array<{ name: string }>,
) {
  const has = (name: string) => tables.some((t) => t.name === name)
  if (!has('chat_conversations')) {
    database.exec(`
      CREATE TABLE chat_conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX chat_conversations_list
        ON chat_conversations (archived_at, updated_at);
    `)
  }
  if (!has('chat_messages')) {
    database.exec(`
      CREATE TABLE chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL
          REFERENCES chat_conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
        content TEXT NOT NULL DEFAULT '',
        tool_calls TEXT,
        tool_call_id TEXT,
        tool_name TEXT,
        ui_data TEXT,
        status TEXT NOT NULL DEFAULT 'done'
          CHECK (status IN ('done', 'stopped', 'error')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX chat_messages_conversation
        ON chat_messages (conversation_id, id);
    `)
  }
  const columns = new Set(
    (
      database
        .prepare("SELECT name FROM pragma_table_info('chat_conversations')")
        .all() as Array<{ name: string }>
    ).map((column) => column.name),
  )
  if (!columns.has('model'))
    database.exec(
      "ALTER TABLE chat_conversations ADD COLUMN model TEXT NOT NULL DEFAULT ''",
    )
  if (!columns.has('reasoning'))
    database.exec(
      "ALTER TABLE chat_conversations ADD COLUMN reasoning TEXT NOT NULL DEFAULT ''",
    )
  if (!columns.has('choice_at'))
    database.exec('ALTER TABLE chat_conversations ADD COLUMN choice_at TEXT')
}

/**
 * Wishlist (schema 13): knives the collector plans to buy, by priority lane,
 * plus a small key/value table for the monthly budget. Target prices are the
 * knife's price alert target in `price_watch`. Additive and repeat-safe.
 */
function migrateWishlistSchema(
  database: Database.Database,
  tables: Array<{ name: string }>,
) {
  const has = (name: string) => tables.some((t) => t.name === name)
  if (!has('wishlist_items')) {
    database.exec(`
      CREATE TABLE wishlist_items (
        knife_id TEXT PRIMARY KEY REFERENCES knives(id) ON DELETE CASCADE,
        lane TEXT NOT NULL CHECK (lane IN ('next', 'saving', 'someday')),
        position INTEGER NOT NULL,
        added_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX wishlist_items_lane ON wishlist_items (lane, position);
    `)
  }
  if (!has('wishlist_meta')) {
    database.exec(`
      CREATE TABLE wishlist_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
  }
}

/**
 * Achievements (schema 12). Unlocks are permanent and keep no foreign key, so
 * deleting a knife never removes a badge. `achievement_meta` records when the
 * vault was first evaluated, which decides silent backfill. Additive and
 * repeat-safe.
 */
function migrateAchievementSchema(
  database: Database.Database,
  tables: Array<{ name: string }>,
) {
  const has = (name: string) => tables.some((t) => t.name === name)
  if (!has('achievement_unlocks')) {
    database.exec(`
      CREATE TABLE achievement_unlocks (
        id TEXT PRIMARY KEY,
        unlocked_at TEXT NOT NULL,
        knife_id TEXT,
        backfilled INTEGER NOT NULL DEFAULT 0,
        seen_at TEXT
      );
    `)
  }
  // Per-message keys let each achievement keep its own Inbox message.
  const messageColumns = database
    .prepare("SELECT name FROM pragma_table_info('system_messages')")
    .all() as Array<{ name: string }>
  if (!messageColumns.some((column) => column.name === 'dedupe_key')) {
    database.exec('ALTER TABLE system_messages ADD COLUMN dedupe_key TEXT')
  }
  if (!has('achievement_meta')) {
    database.exec(`
      CREATE TABLE achievement_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
  }
}

/**
 * Price monitoring (schema 10). History tables (snapshots, change and stock
 * events, daily rollup) are permanent and only lose rows when their knife is
 * deleted. Each table is created only when missing, so this is repeat-safe.
 */
function migratePriceMonitoringSchema(
  database: Database.Database,
  tables: Array<{ name: string }>,
) {
  const has = (name: string) => tables.some((t) => t.name === name)
  const statements: Array<[string, string]> = [
    [
      'price_watch',
      `CREATE TABLE price_watch (
        knife_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('auto', 'on', 'off')),
        updated_at TEXT NOT NULL
      );`,
    ],
    [
      'price_sources',
      `CREATE TABLE price_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        knife_id TEXT NOT NULL,
        url TEXT NOT NULL,
        normalized_url TEXT NOT NULL,
        provider TEXT NOT NULL,
        lane_key TEXT NOT NULL,
        store_name TEXT NOT NULL,
        origin TEXT NOT NULL CHECK (origin IN ('auto', 'manual')),
        enabled INTEGER NOT NULL DEFAULT 1,
        fetch_override TEXT NOT NULL DEFAULT 'auto',
        status TEXT NOT NULL DEFAULT 'pending',
        last_checked_at TEXT,
        last_success_at TEXT,
        last_price_minor INTEGER,
        last_currency TEXT,
        last_availability TEXT,
        last_error_code TEXT,
        last_error TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        next_check_at TEXT,
        last_ai_at TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        removed_at TEXT
      );
      CREATE INDEX price_sources_knife_idx ON price_sources (knife_id);
      CREATE INDEX price_sources_due_idx
        ON price_sources (lane_key, next_check_at) WHERE removed_at IS NULL;
      CREATE UNIQUE INDEX price_sources_active_url
        ON price_sources (knife_id, normalized_url) WHERE removed_at IS NULL;`,
    ],
    [
      'price_snapshots',
      `CREATE TABLE price_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        knife_id TEXT NOT NULL,
        source_id INTEGER NOT NULL,
        price_minor INTEGER,
        currency TEXT,
        availability TEXT NOT NULL,
        extraction_status TEXT NOT NULL,
        extraction_method TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        observations INTEGER NOT NULL DEFAULT 1,
        check_log_id INTEGER
      );
      CREATE INDEX price_snapshots_source_time
        ON price_snapshots (source_id, observed_at);
      CREATE INDEX price_snapshots_knife_time
        ON price_snapshots (knife_id, observed_at);`,
    ],
    [
      'price_change_events',
      `CREATE TABLE price_change_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        knife_id TEXT NOT NULL,
        source_id INTEGER NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('drop', 'increase')),
        previous_price_minor INTEGER NOT NULL,
        price_minor INTEGER NOT NULL,
        currency TEXT NOT NULL,
        delta_minor INTEGER NOT NULL,
        delta_pct REAL NOT NULL,
        availability TEXT NOT NULL,
        from_snapshot_id INTEGER NOT NULL,
        to_snapshot_id INTEGER NOT NULL UNIQUE,
        source_url TEXT NOT NULL,
        store_name TEXT NOT NULL,
        extraction_method TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX price_change_events_time
        ON price_change_events (occurred_at);
      CREATE INDEX price_change_events_knife_time
        ON price_change_events (knife_id, occurred_at);`,
    ],
    [
      'stock_events',
      `CREATE TABLE stock_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        knife_id TEXT NOT NULL,
        source_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('out_of_stock', 'back_in_stock')),
        previous_availability TEXT NOT NULL,
        availability TEXT NOT NULL,
        price_minor INTEGER,
        currency TEXT,
        from_snapshot_id INTEGER NOT NULL,
        to_snapshot_id INTEGER NOT NULL UNIQUE,
        source_url TEXT NOT NULL,
        store_name TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX stock_events_time ON stock_events (occurred_at);
      CREATE INDEX stock_events_knife_time
        ON stock_events (knife_id, occurred_at);`,
    ],
    [
      'price_notifications',
      `CREATE TABLE price_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        knife_id TEXT NOT NULL,
        source_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        occurrences INTEGER NOT NULL DEFAULT 1,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        read_at TEXT,
        dismissed_at TEXT,
        resolved_at TEXT
      );
      CREATE INDEX price_notifications_knife_idx
        ON price_notifications (knife_id);
      CREATE UNIQUE INDEX price_notifications_open
        ON price_notifications (source_id, kind)
        WHERE resolved_at IS NULL AND dismissed_at IS NULL;`,
    ],
    [
      'price_worker_lease',
      `CREATE TABLE price_worker_lease (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        owner TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      );`,
    ],
    [
      'price_host_state',
      `CREATE TABLE price_host_state (
        lane_key TEXT PRIMARY KEY,
        min_gap_ms INTEGER NOT NULL,
        ready_at TEXT NOT NULL,
        circuit TEXT NOT NULL DEFAULT 'closed',
        cooldown_until TEXT,
        open_count INTEGER NOT NULL DEFAULT 0,
        success_streak INTEGER NOT NULL DEFAULT 0,
        failure_streak INTEGER NOT NULL DEFAULT 0,
        http_match_streak INTEGER NOT NULL DEFAULT 0,
        strategy TEXT NOT NULL DEFAULT 'auto',
        strategy_until TEXT,
        quiet_hours TEXT,
        advice_id INTEGER,
        advice_expires_at TEXT,
        last_request_at TEXT,
        last_outcome TEXT,
        updated_at TEXT NOT NULL
      );`,
    ],
    [
      'price_monitor_daily',
      `CREATE TABLE price_monitor_daily (
        day TEXT NOT NULL,
        lane_key TEXT NOT NULL,
        checks INTEGER NOT NULL DEFAULT 0,
        ok INTEGER NOT NULL DEFAULT 0,
        no_price INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        blocked INTEGER NOT NULL DEFAULT 0,
        ai_used INTEGER NOT NULL DEFAULT 0,
        total_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, lane_key)
      );`,
    ],
    [
      'price_regulator_advice',
      `CREATE TABLE price_regulator_advice (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        trigger TEXT NOT NULL,
        model TEXT NOT NULL,
        input TEXT NOT NULL,
        output TEXT,
        applied TEXT,
        expires_at TEXT,
        error TEXT
      );`,
    ],
    [
      'price_check_log',
      `CREATE TABLE price_check_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lane_key TEXT NOT NULL,
        trigger TEXT NOT NULL,
        source_id INTEGER NOT NULL,
        knife_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        method TEXT,
        attempt INTEGER NOT NULL DEFAULT 1,
        http_status INTEGER,
        error_code TEXT,
        error_message TEXT
      );
      CREATE INDEX price_check_log_source
        ON price_check_log (source_id, started_at);
      CREATE INDEX price_check_log_lane
        ON price_check_log (lane_key, started_at);`,
    ],
    [
      // AI searches for monitored knives on other stores (Other stores).
      // One row per knife and store; a found product becomes a price source.
      'price_discovery',
      `CREATE TABLE price_discovery (
        knife_id TEXT NOT NULL,
        store TEXT NOT NULL,
        marketplace TEXT NOT NULL,
        status TEXT NOT NULL,
        source_id INTEGER,
        url TEXT,
        title TEXT,
        confidence REAL,
        detail TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT NOT NULL,
        next_attempt_at TEXT,
        PRIMARY KEY (knife_id, store, marketplace)
      );
      CREATE INDEX price_discovery_time
        ON price_discovery (last_attempt_at);`,
    ],
    [
      // Other stores: listings of the same model in another variant (steel,
      // handle, colour) that a search saw at a store. Shown as related, never
      // monitored; replaced on every completed search of that store.
      'price_discovery_variants',
      `CREATE TABLE price_discovery_variants (
        knife_id TEXT NOT NULL,
        store TEXT NOT NULL,
        marketplace TEXT NOT NULL,
        position INTEGER NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        price_text TEXT,
        seen_at TEXT NOT NULL,
        PRIMARY KEY (knife_id, store, marketplace, position)
      );`,
    ],
    [
      // Price check rounds: every monitored knife in order, one knife's
      // stores at a time. One row per round; the unfinished one is current.
      'price_rounds',
      `CREATE TABLE price_rounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        interval_ms INTEGER NOT NULL,
        knife_ids TEXT NOT NULL,
        cursor INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX price_rounds_started ON price_rounds (started_at);`,
    ],
    [
      // The collection pass: knives outside What to monitor, checked one at
      // a time in the free time between rounds, at most once a day. One row
      // per pass; the unfinished one is current.
      'price_collection_passes',
      `CREATE TABLE price_collection_passes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        knife_ids TEXT NOT NULL,
        cursor INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX price_collection_passes_started
        ON price_collection_passes (started_at);`,
    ],
    [
      // The retry list: checks and searches that failed or found their store
      // not ready during a round. Retried at random times before the next
      // round (due_at); one that fails again waits for the next round.
      'price_retry_tasks',
      `CREATE TABLE price_retry_tasks (
        task_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('check', 'search')),
        knife_id TEXT NOT NULL,
        source_id INTEGER,
        store TEXT,
        lane_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        round_id INTEGER,
        due_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX price_retry_tasks_due ON price_retry_tasks (due_at);`,
    ],
    [
      // Every AI request price monitoring makes: what for, how long, how
      // many tokens and how it ended. No prompts, answers or keys.
      'price_ai_calls',
      `CREATE TABLE price_ai_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        purpose TEXT NOT NULL,
        model TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        ok INTEGER NOT NULL,
        error_code TEXT,
        error TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        reasoning INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX price_ai_calls_time
        ON price_ai_calls (started_at);`,
    ],
    [
      // The AI supervisor's runs: what it saw (counts only), what it decided
      // and what each action did. No page content or keys.
      'price_agent_runs',
      `CREATE TABLE price_agent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        trigger TEXT NOT NULL,
        mode TEXT NOT NULL,
        model TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        summary TEXT,
        coverage TEXT,
        actions TEXT,
        error TEXT
      );
      CREATE INDEX price_agent_runs_time
        ON price_agent_runs (started_at);`,
    ],
    [
      // The AI supervisor's short memory: notes it keeps for later runs,
      // about one knife or in general. They expire; the user can forget them.
      'price_agent_notes',
      `CREATE TABLE price_agent_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        knife_id TEXT,
        note TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX price_agent_notes_expiry
        ON price_agent_notes (expires_at);`,
    ],
  ]
  const missing = statements.filter(([name]) => !has(name))
  if (missing.length)
    database.transaction(() => {
      for (const [, sql] of missing) database.exec(sql)
    })()

  // Schema 11: the AI problem solver's per-store recipe and per-check steps.
  const addColumn = (table: string, column: string, type: string) => {
    const columns = database
      .prepare(`SELECT name FROM pragma_table_info('${table}')`)
      .all() as Array<{ name: string }>
    if (!columns.some((entry) => entry.name === column))
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
  addColumn('price_host_state', 'solver_recipe', 'TEXT')
  addColumn('price_check_log', 'solver_steps', 'TEXT')
  // Schema 12: AI quality control. 'confirmed' or 'unconfirmed' when AI
  // checked a reading against its page (price-monitor/verify).
  addColumn('price_snapshots', 'ai_review', 'TEXT')
  // Schema 13: alert rules. Per knife: a target price, only below what was
  // paid, mute; per source: muted for some days; per message: snoozed.
  addColumn('price_watch', 'target_price_minor', 'INTEGER')
  addColumn('price_watch', 'target_currency', 'TEXT')
  addColumn('price_watch', 'notify_below_paid', 'INTEGER NOT NULL DEFAULT 0')
  addColumn('price_watch', 'notify_muted', 'INTEGER NOT NULL DEFAULT 0')
  addColumn('price_sources', 'notify_muted_until', 'TEXT')
  addColumn('price_notifications', 'snoozed_until', 'TEXT')
  // A store the user paused in Settings → Stores (no scheduled
  // checks there until resumed; Check now still works).
  addColumn('price_host_state', 'paused_at', 'TEXT')
  // The AI supervisor watches a knife closely: its sources are checked at
  // least this often until then (price-monitor/agent, watchClosely).
  addColumn('price_watch', 'focus_until', 'TEXT')
  addColumn('price_watch', 'focus_interval_ms', 'INTEGER')
  addColumn('price_watch', 'focus_reason', 'TEXT')
  // AI supervisor advice and questions in the Inbox: what a message is
  // about (JSON) and the collector's Yes or No.
  addColumn('system_messages', 'payload', 'TEXT')
  addColumn('system_messages', 'answer', 'TEXT')
  // What changed since the supervisor's run before (JSON), shown per run.
  addColumn('price_agent_runs', 'events', 'TEXT')
  // AI recovery: the variant a source tracks (JSON: id, sku, label), a
  // search for the product's new link the supervisor asked for, and what
  // AI recovery did in a check (kind:result, for the weekly numbers).
  addColumn('price_sources', 'expected_variant', 'TEXT')
  addColumn('price_sources', 'find_page_at', 'TEXT')
  addColumn('price_check_log', 'recovery', 'TEXT')
  // The price worker lease names the app version that holds it, so a newer
  // build takes over from an older one (price-monitor/store,
  // acquireWorkerLease). A released lease keeps its row and version.
  addColumn('price_worker_lease', 'build', 'TEXT')
  addColumn('price_worker_lease', 'released_at', 'TEXT')
  forgetDroppedSearchStores(database)
  // A store's first reading can be a drop or back in stock for the knife,
  // measured against another of its stores (price-monitor/new-store).
  // Stores added before get theirs once, when the column arrives.
  const hadPreviousSource = (
    database
      .prepare("SELECT name FROM pragma_table_info('price_change_events')")
      .all() as Array<{ name: string }>
  ).some((entry) => entry.name === 'previous_source_id')
  addColumn('price_change_events', 'previous_source_id', 'INTEGER')
  addColumn('stock_events', 'previous_source_id', 'INTEGER')
  // A drop of a knife outside What to monitor that reached the super-sale
  // line (collection pass): marked so the Inbox can say so.
  addColumn('price_notifications', 'super_sale', 'INTEGER NOT NULL DEFAULT 0')
  // Other stores: a listing of the same model in another variant (handle,
  // steel, colour), monitored with its own history but kept apart from the
  // knife's price. `variant_search` names the search that keeps it
  // (store:marketplace); NULL is the knife's own product.
  addColumn('price_sources', 'variant_search', 'TEXT')
  addColumn('price_sources', 'variant_title', 'TEXT')
  // Needs attention (price-monitor/attention): when the source ran into its
  // current problem, until when the user put it off, when the daily summary
  // last raised it, the price the user confirmed over AI's doubt, and why
  // and when it was paused (manual, missing_page, auto_attention).
  const hadAttentionSince = (
    database
      .prepare("SELECT name FROM pragma_table_info('price_sources')")
      .all() as Array<{ name: string }>
  ).some((entry) => entry.name === 'attention_since')
  addColumn('price_sources', 'attention_since', 'TEXT')
  addColumn('price_sources', 'attention_snoozed_until', 'TEXT')
  addColumn('price_sources', 'attention_reported_at', 'TEXT')
  addColumn('price_sources', 'accepted_price_minor', 'INTEGER')
  addColumn('price_sources', 'accepted_currency', 'TEXT')
  addColumn('price_sources', 'paused_reason', 'TEXT')
  addColumn('price_sources', 'paused_at', 'TEXT')
  // Schema 19: store pacing (price-monitor/lanes). Pages that load without
  // a price at a store that had one (a soft block), the store's usual check
  // time for its own slow-response limit, its robots.txt Crawl-delay, and
  // why its circuit opened.
  addColumn(
    'price_host_state',
    'soft_fail_streak',
    'INTEGER NOT NULL DEFAULT 0',
  )
  addColumn('price_host_state', 'typical_ms', 'INTEGER')
  addColumn(
    'price_host_state',
    'duration_samples',
    'INTEGER NOT NULL DEFAULT 0',
  )
  addColumn('price_host_state', 'robots_delay_ms', 'INTEGER')
  addColumn('price_host_state', 'robots_checked_at', 'TEXT')
  addColumn('price_host_state', 'open_reason', 'TEXT')
  // Sources already in trouble count from their last check: the exact
  // start is not stored, and this never makes one look older than it is.
  if (!hadAttentionSince)
    database
      .prepare(
        `UPDATE price_sources SET attention_since = last_checked_at
         WHERE attention_since IS NULL
           AND status IN ('failed', 'blocked', 'price_unavailable',
                          'needs_review')`,
      )
      .run()
  if (!hadPreviousSource)
    database.transaction(() => backfillNewStoreEvents(database))()
}

/**
 * Other stores no longer searches KnifeCenter (#611). Its unfinished searches are forgotten, and so is their store pacing
 * once no active source uses the store, so a leftover open circuit does not
 * keep calling the AI advisor. Searches that found a listing stay: that
 * listing is a source like any other. Repeat-safe; price history and
 * removed sources are untouched.
 */
const DROPPED_SEARCH_STORES = [
  { store: 'knifecenter', laneKeys: ['knifecenter.com'] },
] as const

function forgetDroppedSearchStores(database: Database.Database) {
  const searches = database.prepare(
    "DELETE FROM price_discovery WHERE store = ? AND status <> 'found'",
  )
  const pacing = database.prepare(
    `DELETE FROM price_host_state WHERE lane_key = ?
       AND NOT EXISTS (SELECT 1 FROM price_sources
                       WHERE lane_key = ? AND removed_at IS NULL)`,
  )
  database.transaction(() => {
    for (const { store, laneKeys } of DROPPED_SEARCH_STORES) {
      searches.run(store)
      for (const laneKey of laneKeys) pacing.run(laneKey, laneKey)
    }
  })()
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

/**
 * Settings rows written by the Cloudflare D1/R2 remote storage that was
 * removed in ca4411d. Nothing reads them any more, but saveSettings only
 * upserts, so old vaults kept the account id, API token and R2 keys in plain
 * text, and every backup carried them.
 */
export const OBSOLETE_SETTINGS_KEYS = [
  'storage_mode',
  'cloudflare_account_id',
  'cloudflare_api_token',
  'd1_database_id',
  'd1_database_name',
  'r2_bucket_name',
  'r2_access_key_id',
  'r2_secret_access_key',
  'r2_endpoint',
  'r2_bucket_url',
] as const

/**
 * Deletes the obsolete credential rows. Repeat-safe: a vault without them
 * costs one indexed lookup per open. secure_delete zeroes the deleted cells,
 * and a one-time VACUUM drops older copies that earlier saves left in free
 * pages, because backups copy database pages as they are.
 */
function removeObsoleteSettings(database: Database.Database) {
  const placeholders = OBSOLETE_SETTINGS_KEYS.map(() => '?').join(', ')
  const { count } = database
    .prepare(
      `SELECT COUNT(*) AS count FROM settings WHERE key IN (${placeholders})`,
    )
    .get(...OBSOLETE_SETTINGS_KEYS) as { count: number }
  if (!count) return

  const secureDelete = Number(
    database.pragma('secure_delete', { simple: true }),
  )
  database.pragma('secure_delete = ON')
  try {
    database
      .prepare(`DELETE FROM settings WHERE key IN (${placeholders})`)
      .run(...OBSOLETE_SETTINGS_KEYS)
  } finally {
    database.pragma(`secure_delete = ${secureDelete}`)
  }

  try {
    database.exec('VACUUM')
    database.pragma('wal_checkpoint(TRUNCATE)')
  } catch (error) {
    // Another process may hold a read transaction. The rows are gone and
    // their cells zeroed either way; only stale free-page copies remain.
    console.warn('Could not compact the database after removing old settings', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
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
      pinned INTEGER NOT NULL DEFAULT 0,
      sold INTEGER NOT NULL DEFAULT 0
    );
  `)

  database.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  migrateSchema(database)
  removeObsoleteSettings(database)

  // Seed the legacy backlog only when this schema is first introduced, including
  // after restoring a pre-screenshot backup. New items never enter this queue.
  if (
    !database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'webpage_screenshots'",
      )
      .get()
  ) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE webpage_screenshots (path TEXT PRIMARY KEY, metadata TEXT NOT NULL);
        CREATE TABLE screenshot_backfill (
          knife_id TEXT PRIMARY KEY REFERENCES knives(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'pending',
          error TEXT,
          lease_until INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO screenshot_backfill(knife_id)
          SELECT id FROM knives WHERE trim(source_url) <> '';
      `)
    })()
  }

  const currentSchemaVersion = Number(
    database.pragma('user_version', { simple: true }),
  )
  if (currentSchemaVersion < 14) resetOtherStoreLaneGaps(database)
  if (currentSchemaVersion < 15) recheckRejectedSearches(database)
  if (currentSchemaVersion < LOCAL_DB_SCHEMA_VERSION) {
    database.pragma(`user_version = ${LOCAL_DB_SCHEMA_VERSION}`)
  }
}
