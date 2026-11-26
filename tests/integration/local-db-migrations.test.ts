import fs from 'fs/promises'
import path from 'path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  closeLocalDb,
  getLocalDb,
  LOCAL_DB_SCHEMA_VERSION,
  OBSOLETE_SETTINGS_KEYS,
} from '@/lib/local-db'
import { getSettings, saveSettings } from '@/lib/settings'
import {
  containsLegacyCloudSecret,
  seedLegacyCloudSettings,
} from '@/tests/helpers/legacy-settings'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault | null = null

afterEach(async () => {
  await vault?.cleanup()
  vault = null
})

describe('local database migrations', () => {
  it('adds the price monitoring tables once and keeps them on reopen', async () => {
    vault = await createTempVault()
    const priceTables = [
      'price_watch',
      'price_sources',
      'price_snapshots',
      'price_change_events',
      'stock_events',
      'price_notifications',
      'price_worker_lease',
      'price_host_state',
      'price_monitor_daily',
      'price_regulator_advice',
      'price_check_log',
      'price_discovery',
    ]
    const tableNames = () =>
      (
        getLocalDb()
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as Array<{ name: string }>
      ).map((row) => row.name)

    expect(tableNames()).toEqual(expect.arrayContaining(priceTables))
    expect(getLocalDb().pragma('user_version', { simple: true })).toBe(
      LOCAL_DB_SCHEMA_VERSION,
    )
    getLocalDb()
      .prepare(
        `INSERT INTO price_monitor_daily (day, lane_key, checks)
         VALUES ('2026-11-18', 'shop.example', 3)`,
      )
      .run()

    // Reopening (and re-running migrations on an older user_version) keeps data.
    getLocalDb().pragma('user_version = 9')
    closeLocalDb()
    expect(tableNames()).toEqual(expect.arrayContaining(priceTables))
    expect(
      getLocalDb().prepare('SELECT checks FROM price_monitor_daily').get(),
    ).toEqual({ checks: 3 })
  })

  it('resets Other stores gaps slowed by long searches once, keeping paused stores', async () => {
    vault = await createTempVault()
    const insert = getLocalDb().prepare(
      `INSERT INTO price_host_state
         (lane_key, min_gap_ms, ready_at, circuit, updated_at)
       VALUES (?, ?, ?, ?, 't')`,
    )
    // Inflated gaps left each store's next check slot hours ahead.
    const farReadyAt = new Date(Date.now() + 3 * 3_600_000).toISOString()
    insert.run('bladehq.com', 5_606_969, farReadyAt, 'closed')
    insert.run('knifejoy.com', 10_408_435, farReadyAt, 'closed')
    insert.run('dlttrading.com', 11_435_061, farReadyAt, 'open')
    insert.run('vosteed.com', 600_000, farReadyAt, 'closed')
    const gaps = () =>
      Object.fromEntries(
        (
          getLocalDb()
            .prepare('SELECT lane_key, min_gap_ms FROM price_host_state')
            .all() as Array<{ lane_key: string; min_gap_ms: number }>
        ).map((row) => [row.lane_key, row.min_gap_ms]),
      )

    getLocalDb().pragma('user_version = 13')
    closeLocalDb()
    expect(gaps()).toEqual({
      'bladehq.com': 60_000,
      'knifejoy.com': 60_000,
      'dlttrading.com': 11_435_061,
      'vosteed.com': 600_000,
    })
    expect(getLocalDb().pragma('user_version', { simple: true })).toBe(
      LOCAL_DB_SCHEMA_VERSION,
    )
    // The check slot the inflated gap pushed hours ahead is due now; the
    // paused store and other stores keep theirs.
    const readyAt = Object.fromEntries(
      (
        getLocalDb()
          .prepare('SELECT lane_key, ready_at FROM price_host_state')
          .all() as Array<{ lane_key: string; ready_at: string }>
      ).map((row) => [row.lane_key, row.ready_at]),
    )
    expect(Date.parse(readyAt['bladehq.com'])).toBeLessThanOrEqual(Date.now())
    expect(Date.parse(readyAt['knifejoy.com'])).toBeLessThanOrEqual(Date.now())
    expect(readyAt['dlttrading.com']).toBe(farReadyAt)
    expect(readyAt['vosteed.com']).toBe(farReadyAt)

    // Once only: a store slowed later by throttling keeps its gap on reopen.
    getLocalDb()
      .prepare(
        "UPDATE price_host_state SET min_gap_ms = 120000 WHERE lane_key = 'bladehq.com'",
      )
      .run()
    closeLocalDb()
    expect(gaps()['bladehq.com']).toBe(120_000)
  })

  it('makes turned-down Other stores searches due once and adds the variants table', async () => {
    vault = await createTempVault()
    const later = new Date(Date.now() + 20 * 3_600_000).toISOString()
    const insert = getLocalDb().prepare(
      `INSERT INTO price_discovery
         (knife_id, store, marketplace, status, attempts, last_attempt_at, next_attempt_at)
       VALUES (?, 'bladehq', 'bladehq.com', ?, 1, 't', ?)`,
    )
    insert.run('k1', 'rejected', later)
    insert.run('k2', 'not_found', later)
    insert.run('k3', 'found', null)
    getLocalDb().exec('DROP TABLE price_discovery_variants')
    const nextAttempts = () =>
      Object.fromEntries(
        (
          getLocalDb()
            .prepare('SELECT knife_id, next_attempt_at FROM price_discovery')
            .all() as Array<{ knife_id: string; next_attempt_at: string }>
        ).map((row) => [row.knife_id, row.next_attempt_at]),
      )

    getLocalDb().pragma('user_version = 14')
    closeLocalDb()
    const after = nextAttempts()
    expect(Date.parse(after.k1)).toBeLessThanOrEqual(Date.now())
    expect(after.k2).toBe(later)
    expect(after.k3).toBeNull()
    expect(
      getLocalDb()
        .prepare(
          "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'price_discovery_variants'",
        )
        .get(),
    ).toEqual({ ok: 1 })

    // Once only: a search turned down later keeps its next attempt.
    getLocalDb()
      .prepare(
        "UPDATE price_discovery SET next_attempt_at = ? WHERE knife_id = 'k1'",
      )
      .run(later)
    closeLocalDb()
    expect(nextAttempts().k1).toBe(later)
  })

  it('adds the price round and retry list tables to a schema 15 vault', async () => {
    vault = await createTempVault()
    getLocalDb().exec('DROP TABLE price_rounds; DROP TABLE price_retry_tasks')
    getLocalDb().pragma('user_version = 15')
    closeLocalDb()
    const columns = (table: string) =>
      (
        getLocalDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string
        }>
      ).map((column) => column.name)
    expect(columns('price_rounds')).toEqual([
      'id',
      'trigger',
      'started_at',
      'finished_at',
      'interval_ms',
      'knife_ids',
      'cursor',
    ])
    expect(columns('price_retry_tasks')).toEqual(
      expect.arrayContaining([
        'task_key',
        'kind',
        'knife_id',
        'source_id',
        'store',
        'lane_key',
        'reason',
        'attempts',
        'due_at',
      ]),
    )
    expect(getLocalDb().pragma('user_version', { simple: true })).toBe(
      LOCAL_DB_SCHEMA_VERSION,
    )
    // Repeat-safe: opening again changes nothing.
    closeLocalDb()
    expect(columns('price_rounds')).toHaveLength(7)
  })

  it('adds the alert rule columns to an older price schema, keeping its rows', async () => {
    vault = await createTempVault()
    const database = getLocalDb()
    database
      .prepare(
        "INSERT INTO price_watch (knife_id, mode, updated_at) VALUES ('k1', 'on', 't')",
      )
      .run()
    database
      .prepare(
        `INSERT INTO price_sources
           (knife_id, url, normalized_url, provider, lane_key, store_name,
            origin, created_at, updated_at)
         VALUES ('k1', 'https://a.example/p', 'https://a.example/p', 'generic',
                 'a.example', 'a.example', 'manual', 't', 't')`,
      )
      .run()
    database
      .prepare(
        `INSERT INTO price_notifications
           (knife_id, source_id, event_id, kind, occurred_at, created_at,
            updated_at)
         VALUES ('k1', 1, 1, 'drop', 't', 't', 't')`,
      )
      .run()
    // Simulate a vault from before alert rules.
    for (const [table, column] of [
      ['price_watch', 'target_price_minor'],
      ['price_watch', 'target_currency'],
      ['price_watch', 'notify_below_paid'],
      ['price_watch', 'notify_muted'],
      ['price_sources', 'notify_muted_until'],
      ['price_notifications', 'snoozed_until'],
    ])
      database.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
    closeLocalDb()

    for (let open = 0; open < 2; open += 1) {
      expect(
        getLocalDb()
          .prepare(
            `SELECT mode, target_price_minor, target_currency,
                    notify_below_paid, notify_muted FROM price_watch`,
          )
          .get(),
      ).toEqual({
        mode: 'on',
        target_price_minor: null,
        target_currency: null,
        notify_below_paid: 0,
        notify_muted: 0,
      })
      expect(
        getLocalDb()
          .prepare('SELECT store_name, notify_muted_until FROM price_sources')
          .get(),
      ).toEqual({ store_name: 'a.example', notify_muted_until: null })
      expect(
        getLocalDb()
          .prepare('SELECT kind, snoozed_until FROM price_notifications')
          .get(),
      ).toEqual({ kind: 'drop', snoozed_until: null })
      // Reopening runs the migration again; it must be repeat-safe.
      closeLocalDb()
    }
  })

  it('adds missing columns and backfills updated_at without losing a legacy knife', async () => {
    vault = await createTempVault()
    const legacy = new Database(path.join(vault.dataDir, 'bladevault.sqlite'))
    legacy.exec(`
      CREATE TABLE knives (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        brand TEXT NOT NULL,
        steel TEXT NOT NULL DEFAULT '',
        blade_style TEXT NOT NULL,
        handle_material TEXT NOT NULL,
        images TEXT NOT NULL,
        specs TEXT NOT NULL,
        description TEXT NOT NULL,
        added_at TEXT NOT NULL
      );
      INSERT INTO knives VALUES (
        'legacy', ' Legacy  Knife ', ' Maker ', '', ' Drop  Point ', ' G10 ',
        '[]', '{"weight":" 3  oz ","overallLength":"","bladeLength":"","country":" USA "}',
        ' First  line ', '2025-01-01T00:00:00.000Z'
      );
    `)
    legacy.close()

    const database = getLocalDb()
    const columns = database
      .prepare("SELECT name FROM pragma_table_info('knives')")
      .all() as Array<{ name: string }>
    const row = database
      .prepare('SELECT * FROM knives WHERE id = ?')
      .get('legacy') as Record<string, unknown> | undefined

    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'source_url',
        'pinned',
        'updated_at',
        'custom_fields',
      ]),
    )
    expect(row).toMatchObject({
      name: 'Legacy Knife',
      brand: 'Maker',
      blade_style: 'Drop Point',
      handle_material: 'G10',
      updated_at: '2025-01-01T00:00:00.000Z',
      custom_fields: '{}',
    })
    expect(
      database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='compare_list'",
        )
        .get(),
    ).toBeTruthy()
    expect(
      database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='knife_activity'",
        )
        .get(),
    ).toBeTruthy()
    expect(
      database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='knife_change_log'",
        )
        .get(),
    ).toBeTruthy()
    expect(
      database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_log'",
        )
        .get(),
    ).toBeTruthy()
    expect(
      database
        .prepare('SELECT knife_id, event_type, occurred_at FROM knife_activity')
        .all(),
    ).toEqual([
      {
        knife_id: 'legacy',
        event_type: 'created',
        occurred_at: '2025-01-01T00:00:00.000Z',
      },
    ])
    expect(database.pragma('integrity_check', { simple: true })).toBe('ok')
  })

  it('backfills the latest known edit when adding activity history', async () => {
    vault = await createTempVault()
    const legacy = new Database(path.join(vault.dataDir, 'bladevault.sqlite'))
    legacy.exec(`
      CREATE TABLE knives (
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
      INSERT INTO knives VALUES (
        'edited', 'Knife', 'Maker', '', 'Drop Point', 'G10', '[]',
        '{"weight":"","overallLength":"","bladeLength":"","country":""}',
        '{}', '', '2025-01-01T00:00:00.000Z', '2025-02-02T00:00:00.000Z', '', 0
      );
    `)
    legacy.close()

    const database = getLocalDb()
    expect(
      database
        .prepare(
          `SELECT event_type, occurred_at
           FROM knife_activity
           WHERE knife_id = ?
           ORDER BY id`,
        )
        .all('edited'),
    ).toEqual([
      { event_type: 'created', occurred_at: '2025-01-01T00:00:00.000Z' },
      { event_type: 'updated', occurred_at: '2025-02-02T00:00:00.000Z' },
    ])
  })

  it('backfills existing MCP changes into the audit log', async () => {
    vault = await createTempVault()
    const legacy = new Database(path.join(vault.dataDir, 'bladevault.sqlite'))
    const changes = [
      {
        field: 'designer',
        previousValue: '',
        value: 'Jane Doe',
      },
    ]
    legacy.exec(`
      CREATE TABLE knives (
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
      CREATE TABLE knife_change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL,
        knife_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('mcp')),
        transport TEXT NOT NULL CHECK (transport IN ('stdio', 'http')),
        changes TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      INSERT INTO knives VALUES (
        'mcp-knife', 'Model', 'Maker', '', 'Drop Point', 'G10', '[]',
        '{"weight":"","overallLength":"","bladeLength":"","country":""}',
        '{}', '', '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', '', 0
      );
    `)
    legacy
      .prepare(
        `INSERT INTO knife_change_log
         (operation_id, knife_id, source, transport, changes, occurred_at)
         VALUES (?, ?, 'mcp', 'stdio', ?, ?)`,
      )
      .run(
        'op-existing',
        'mcp-knife',
        JSON.stringify(changes),
        '2026-08-02T00:00:00.000Z',
      )
    legacy.close()

    const database = getLocalDb()
    expect(
      database
        .prepare(
          `SELECT operation_id, event_type, knife_id, subject, actor, source,
                  summary, changes, occurred_at
           FROM audit_log`,
        )
        .get(),
    ).toEqual({
      operation_id: 'op-existing',
      event_type: 'updated',
      knife_id: 'mcp-knife',
      subject: 'Maker · Model',
      actor: 'MCP client',
      source: 'MCP / update_knife',
      summary: 'Applied metadata update via MCP.',
      changes: JSON.stringify([
        { field: 'designer', before: '', after: 'Jane Doe' },
      ]),
      occurred_at: '2026-08-02T00:00:00.000Z',
    })
  })

  it('preserves non-empty custom fields while normalizing a current database', async () => {
    vault = await createTempVault()
    const database = getLocalDb()
    database
      .prepare(
        `INSERT INTO knives (
          id, name, brand, steel, blade_style, handle_material, images, specs,
          custom_fields, description, added_at, updated_at, source_url, pinned
        ) VALUES (?, ?, ?, '', ?, ?, '[]', ?, ?, '', ?, ?, '', 0)`,
      )
      .run(
        'custom',
        ' Knife  Name ',
        'Maker',
        'Drop Point',
        'G10',
        JSON.stringify({
          weight: '',
          overallLength: '',
          bladeLength: '',
          country: '',
        }),
        JSON.stringify({ acquiredFrom: 'Knife Show' }),
        '2025-01-01T00:00:00.000Z',
        '2025-01-01T00:00:00.000Z',
      )

    const { closeLocalDb } = await import('@/lib/local-db')
    closeLocalDb()
    const reopened = getLocalDb()
    const row = reopened
      .prepare('SELECT custom_fields FROM knives WHERE id = ?')
      .get('custom') as { custom_fields: string }

    expect(JSON.parse(row.custom_fields)).toEqual({
      acquiredFrom: 'Knife Show',
    })
    expect(
      reopened
        .prepare('SELECT name FROM knives WHERE id = ?')
        .pluck()
        .get('custom'),
    ).toBe('Knife Name')
  })

  it('adds the sold column to a vault created before sold status existed', async () => {
    vault = await createTempVault()
    const legacy = new Database(path.join(vault.dataDir, 'bladevault.sqlite'))
    legacy.exec(`
      CREATE TABLE knives (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        brand TEXT NOT NULL,
        steel TEXT NOT NULL DEFAULT '',
        blade_style TEXT NOT NULL,
        handle_material TEXT NOT NULL,
        images TEXT NOT NULL,
        specs TEXT NOT NULL,
        description TEXT NOT NULL,
        added_at TEXT NOT NULL
      );
      INSERT INTO knives VALUES (
        'legacy', 'Legacy Knife', 'Maker', '', 'Drop Point', 'G10',
        '[]', '{}', '', '2025-01-01T00:00:00.000Z'
      );
    `)
    legacy.close()

    const database = getLocalDb()
    const columns = database
      .prepare("SELECT name FROM pragma_table_info('knives')")
      .all() as Array<{ name: string }>

    expect(columns.map(({ name }) => name)).toContain('sold')
    expect(
      database.prepare('SELECT sold FROM knives WHERE id = ?').get('legacy'),
    ).toEqual({ sold: 0 })
  })

  it('adds the images column to notes saved before note photos existed', async () => {
    vault = await createTempVault()
    const legacy = new Database(path.join(vault.dataDir, 'bladevault.sqlite'))
    legacy.exec(`
      CREATE TABLE knives (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        brand TEXT NOT NULL,
        steel TEXT NOT NULL DEFAULT '',
        blade_style TEXT NOT NULL,
        handle_material TEXT NOT NULL,
        images TEXT NOT NULL,
        specs TEXT NOT NULL,
        description TEXT NOT NULL,
        added_at TEXT NOT NULL
      );
      INSERT INTO knives VALUES (
        'legacy', 'Legacy Knife', 'Maker', '', 'Drop Point', 'G10',
        '[]', '{}', '', '2025-01-01T00:00:00.000Z'
      );
      CREATE TABLE knife_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        knife_id TEXT NOT NULL,
        body TEXT NOT NULL,
        noted_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO knife_notes (knife_id, body, noted_at, created_at, updated_at)
      VALUES ('legacy', 'Kept', '2025-02-01', '2025-02-01', '2025-02-01');
    `)
    legacy.close()

    const database = getLocalDb()
    expect(
      database.prepare('SELECT body, images FROM knife_notes').get(),
    ).toEqual({ body: 'Kept', images: '[]' })
  })

  it('removes the old Cloudflare credential rows, keeps current settings and repeats safely', async () => {
    vault = await createTempVault()
    saveSettings({ theme: 'dark', timeFormat: '24h' })
    getLocalDb()
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('error_reporting_consent', 'granted')
    seedLegacyCloudSettings(vault.dataDir)

    const settingKeys = () =>
      (
        getLocalDb().prepare('SELECT key FROM settings').all() as Array<{
          key: string
        }>
      ).map((row) => row.key)
    const databaseBytes = async () => {
      closeLocalDb()
      return fs.readFile(path.join(vault!.dataDir, 'bladevault.sqlite'))
    }

    for (const key of OBSOLETE_SETTINGS_KEYS)
      expect(settingKeys()).not.toContain(key)
    expect(settingKeys()).toContain('error_reporting_consent')
    expect(getSettings()).toMatchObject({ theme: 'dark', timeFormat: '24h' })
    // Neither the current nor the earlier overwritten token survives in the
    // file, which the local ZIP and full-folder archives copy as it is.
    expect(containsLegacyCloudSecret(await databaseBytes())).toBe(false)

    // Reopening a clean vault changes nothing.
    expect(settingKeys()).toContain('error_reporting_consent')
    expect(getSettings()).toMatchObject({ theme: 'dark', timeFormat: '24h' })

    // A restored old backup brings the rows back; the next open removes them.
    seedLegacyCloudSettings(vault.dataDir)
    for (const key of OBSOLETE_SETTINGS_KEYS)
      expect(settingKeys()).not.toContain(key)
    expect(getLocalDb().pragma('integrity_check', { simple: true })).toBe('ok')
    expect(getLocalDb().pragma('secure_delete', { simple: true })).toBe(0)
    expect(containsLegacyCloudSecret(await databaseBytes())).toBe(false)
  })
})
