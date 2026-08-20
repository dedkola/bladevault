import path from 'path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { getLocalDb } from '@/lib/local-db'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault | null = null

afterEach(async () => {
  await vault?.cleanup()
  vault = null
})

describe('local database migrations', () => {
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
})
