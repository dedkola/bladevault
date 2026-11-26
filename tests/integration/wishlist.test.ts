import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'
import { createKnife } from '@/tests/fixtures/knife'
import { LocalStorage } from '@/lib/storage/local'
import {
  closeLocalDb,
  getLocalDb,
  LOCAL_DB_SCHEMA_VERSION,
} from '@/lib/local-db'
import {
  buildPriceTrends,
  buildWishlistTrends,
  getWishlist,
  mutateWishlist,
} from '@/lib/wishlist-storage'
import * as route from '@/app/api/wishlist/route'
import { insertSource } from '@/lib/price-monitor/store'
import { saveSettings } from '@/lib/settings'
import { DEFAULT_PRICE_MONITORING } from '@/lib/settings-shared'

let vault: TempVault
let storage: LocalStorage
beforeEach(async () => {
  vault = await createTempVault()
  storage = new LocalStorage()
  for (const id of ['first', 'second', 'third'])
    await storage.migrateKnife(createKnife({ id, name: id }), [])
})
afterEach(async () => {
  await vault.cleanup()
})

const lane = (name: string) =>
  getWishlist()
    .items.filter((item) => item.lane === name)
    .map((item) => item.knifeId)

function post(body: unknown) {
  return route.POST(
    new Request('http://localhost/api/wishlist', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  )
}

describe('wishlist stores per knife', () => {
  function enableSearches(stores: Partial<Record<string, boolean>>) {
    saveSettings({
      priceMonitoring: {
        ...DEFAULT_PRICE_MONITORING,
        ai: {
          ...DEFAULT_PRICE_MONITORING.ai,
          enabled: true,
          baseUrl: 'http://localhost:11434/v1',
          model: 'test-model',
        },
        otherStores: {
          enabled: true,
          stores: {
            ...DEFAULT_PRICE_MONITORING.otherStores.stores,
            bladehq: false,
            ...stores,
          },
        },
      },
    })
  }

  it('lists store links first, then what each searched store found', () => {
    enableSearches({
      amazon: true,
      smkw: true,
      dlttrading: true,
      knifejoy: true,
    })
    mutateWishlist({ action: 'add', knifeIds: ['first'], lane: 'next' })
    const db = getLocalDb()
    const now = new Date().toISOString()
    insertSource(
      db,
      'first',
      'https://vosteed.com/p/porcupine',
      'manual',
      undefined,
      now,
    )
    insertSource(
      db,
      'first',
      'https://www.amazon.com/dp/B0TEST1234',
      'manual',
      undefined,
      now,
    )
    db.prepare(
      `UPDATE price_sources SET last_price_minor = 6900, last_currency = 'USD',
         last_availability = 'in_stock', status = 'ok' WHERE lane_key = 'amazon'`,
    ).run()
    // Cheaper but sold out: listed after the in-stock store.
    insertSource(
      db,
      'first',
      'https://www.bladehq.com/item/porcupine',
      'manual',
      undefined,
      now,
    )
    db.prepare(
      `UPDATE price_sources SET last_price_minor = 5000, last_currency = 'USD',
         last_availability = 'out_of_stock', status = 'ok'
       WHERE lane_key = 'bladehq.com'`,
    ).run()
    const search = db.prepare(
      `INSERT INTO price_discovery
         (knife_id, store, marketplace, status, detail, attempts, last_attempt_at, next_attempt_at)
       VALUES ('first', ?, ?, ?, ?, 1, ?, ?)`,
    )
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString()
    search.run(
      'smkw',
      'smkw.com',
      'variant',
      'Only other variants.',
      now,
      tomorrow,
    )
    search.run(
      'dlttrading',
      'dlttrading.com',
      'not_found',
      'No results.',
      now,
      tomorrow,
    )
    db.prepare(
      `INSERT INTO price_discovery_variants
         (knife_id, store, marketplace, position, url, title, price_text, seen_at)
       VALUES ('first', 'smkw', 'smkw.com', 0, 'https://www.smkw.com/p/a4801', 'Porcupine A4801', '$59.99', ?)`,
    ).run(now)

    const stores = getWishlist().stores?.first ?? []
    expect(
      stores.map((entry) => [
        entry.label,
        entry.state,
        entry.source?.priceMinor ?? null,
      ]),
    ).toEqual([
      ['Amazon', 'listed', 6900],
      ['Blade HQ', 'listed', 5000],
      ['vosteed.com', 'listed', null],
      ['SMKW', 'variant', null],
      ['KnifeJoy', 'waiting', null],
      ['DLT Trading', 'not_sold', null],
    ])
    expect(stores[3].variants).toEqual([
      {
        url: 'https://www.smkw.com/p/a4801',
        title: 'Porcupine A4801',
        price: '$59.99',
        seenAt: now,
      },
    ])
    expect(stores[5]).toMatchObject({
      detail: 'No results.',
      search: { lastAt: now, nextAt: tomorrow },
    })
  })

  it('lists only store links while Other stores is off', () => {
    mutateWishlist({ action: 'add', knifeIds: ['first'], lane: 'next' })
    insertSource(
      getLocalDb(),
      'first',
      'https://vosteed.com/p/porcupine',
      'manual',
      undefined,
      new Date().toISOString(),
    )
    expect(getWishlist().stores?.first?.map((entry) => entry.label)).toEqual([
      'vosteed.com',
    ])
  })
})

describe('wishlist', () => {
  it('creates its tables repeat-safely at the current schema', () => {
    expect(LOCAL_DB_SCHEMA_VERSION).toBeGreaterThanOrEqual(13)
    const db = getLocalDb()
    db.exec('DROP TABLE wishlist_items; DROP TABLE wishlist_meta;')
    db.pragma('user_version = 12')
    closeLocalDb()
    for (let open = 0; open < 2; open += 1) {
      expect(getWishlist().items).toEqual([])
      expect(getLocalDb().pragma('user_version', { simple: true })).toBe(
        LOCAL_DB_SCHEMA_VERSION,
      )
      closeLocalDb()
    }
  })

  it('adds once per knife, ignores unknown knives and undoes an add', () => {
    const added = mutateWishlist({
      action: 'add',
      knifeIds: ['first', 'second', 'missing'],
      lane: 'next',
    })
    mutateWishlist({ action: 'add', knifeIds: ['first'], lane: 'someday' })
    expect(lane('next')).toEqual(['first', 'second'])
    expect(lane('someday')).toEqual([])
    mutateWishlist(added.undo!)
    expect(getWishlist().items).toEqual([])
    expect(() =>
      mutateWishlist({ action: 'add', knifeIds: ['missing'], lane: 'next' }),
    ).toThrow('no longer in your vault')
  })

  it('moves between lanes and before a knife, and restores a removal in place', () => {
    mutateWishlist({
      action: 'add',
      knifeIds: ['first', 'second', 'third'],
      lane: 'saving',
    })
    mutateWishlist({
      action: 'move',
      knifeId: 'third',
      lane: 'saving',
      beforeKnifeId: 'first',
    })
    expect(lane('saving')).toEqual(['third', 'first', 'second'])
    mutateWishlist({ action: 'move', knifeId: 'first', lane: 'next' })
    expect(lane('saving')).toEqual(['third', 'second'])
    expect(lane('next')).toEqual(['first'])

    const removed = mutateWishlist({ action: 'remove', knifeIds: ['third'] })
    expect(lane('saving')).toEqual(['second'])
    mutateWishlist(removed.undo!)
    expect(lane('saving')).toEqual(['third', 'second'])
  })

  it('reads the target from the price alert and keeps a monthly budget', () => {
    mutateWishlist({ action: 'add', knifeIds: ['first'], lane: 'next' })
    getLocalDb()
      .prepare(
        `INSERT INTO price_watch (knife_id, mode, updated_at, target_price_minor, target_currency)
         VALUES ('first', 'auto', 't', 13000, 'USD')`,
      )
      .run()
    expect(getWishlist().items[0]).toMatchObject({
      targetMinor: 13000,
      targetCurrency: 'USD',
    })
    mutateWishlist({ action: 'budget', amountMinor: 60000, currency: 'USD' })
    expect(getWishlist().budget).toEqual({
      amountMinor: 60000,
      currency: 'USD',
    })
    mutateWishlist({ action: 'budget', amountMinor: null, currency: null })
    expect(getWishlist().budget).toEqual({ amountMinor: null, currency: null })
  })

  it('drops the knife from the wishlist when the knife is deleted', async () => {
    mutateWishlist({
      action: 'add',
      knifeIds: ['first', 'second'],
      lane: 'next',
    })
    await storage.deleteKnife('first')
    expect(lane('next')).toEqual(['second'])
  })

  it('builds daily best in-stock prices and the 90-day low', () => {
    const db = getLocalDb()
    const now = Date.parse('2026-06-30T12:00:00Z')
    const day = 24 * 60 * 60 * 1000
    const iso = (daysAgo: number) => new Date(now - daysAgo * day).toISOString()
    for (const host of ['a', 'b'])
      db.prepare(
        `INSERT INTO price_sources
           (knife_id, url, normalized_url, provider, lane_key, store_name,
            origin, created_at, updated_at)
         VALUES ('first', ?, ?, 'generic', ?, ?, 'manual', 't', 't')`,
      ).run(
        `https://${host}.example/p`,
        `https://${host}.example/p`,
        host,
        host,
      )
    const snapshot = db.prepare(
      `INSERT INTO price_snapshots
         (knife_id, source_id, price_minor, currency, availability,
          extraction_status, extraction_method, observed_at, last_seen_at)
       VALUES ('first', ?, ?, 'USD', ?, 'ok', 'json_ld', ?, ?)`,
    )
    snapshot.run(1, 9000, 'in_stock', iso(60), iso(40)) // 90-day low
    snapshot.run(1, 15000, 'in_stock', iso(40), iso(10))
    snapshot.run(1, 15000, 'out_of_stock', iso(10), iso(0))
    snapshot.run(2, 14000, 'in_stock', iso(5), iso(0))

    const trend = buildWishlistTrends(db, ['first', 'second'], now).first
    expect(trend.currency).toBe('USD')
    expect(trend.lowMinor).toBe(9000)
    expect(trend.highMinor).toBe(15000)
    expect(trend.daily).toHaveLength(30)
    expect(trend.daily[0]).toBe(15000) // 29 days ago: only store A
    expect(trend.daily[22]).toBeNull() // 7 days ago: A out of stock, B not yet
    expect(trend.daily[29]).toBe(14000)
    // Steps at the real change times across a full 30-day window.
    expect(trend.since).toBe(now - 30 * day)
    expect(trend.until).toBe(now)
    expect(trend.steps).toEqual([
      { at: now - 30 * day, price: 15000 },
      { at: now - 10 * day, price: null },
      { at: now - 5 * day, price: 14000 },
    ])
    expect(buildWishlistTrends(db, ['second'], now)).toEqual({})
  })

  it('builds Price Drops trends per knife and per enabled store', () => {
    const db = getLocalDb()
    const now = Date.parse('2026-06-30T12:00:00Z')
    const day = 24 * 60 * 60 * 1000
    const iso = (daysAgo: number) => new Date(now - daysAgo * day).toISOString()
    for (const [host, enabled] of [
      ['a', 1],
      ['b', 1],
      ['c', 0],
    ] as const)
      db.prepare(
        `INSERT INTO price_sources
           (knife_id, url, normalized_url, provider, lane_key, store_name,
            origin, enabled, created_at, updated_at)
         VALUES ('first', ?, ?, 'generic', ?, ?, 'manual', ?, 't', 't')`,
      ).run(
        `https://${host}.example/p`,
        `https://${host}.example/p`,
        host,
        host,
        enabled,
      )
    const snapshot = db.prepare(
      `INSERT INTO price_snapshots
         (knife_id, source_id, price_minor, currency, availability,
          extraction_status, extraction_method, observed_at, last_seen_at)
       VALUES ('first', ?, ?, 'USD', 'in_stock', 'ok', 'json_ld', ?, ?)`,
    )
    snapshot.run(1, 20000, iso(20), iso(0))
    snapshot.run(2, 18000, iso(20), iso(3))
    snapshot.run(2, 15000, iso(3), iso(0))
    snapshot.run(3, 12000, iso(20), iso(0)) // paused store

    const trends = buildPriceTrends(db, now)
    // The knife's best price leaves out the paused store, as the table does.
    expect(Object.keys(trends.knives)).toEqual(['first'])
    expect(trends.knives.first.steps).toEqual([
      { at: now - 20 * day, price: 18000 },
      { at: now - 3 * day, price: 15000 },
    ])
    expect(trends.sources['1'].steps).toEqual([
      { at: now - 20 * day, price: 20000 },
    ])
    expect(trends.sources['2'].steps).toEqual([
      { at: now - 20 * day, price: 18000 },
      { at: now - 3 * day, price: 15000 },
    ])
    expect(trends.sources['3']).toBeUndefined()
  })

  it('charts the currency the stores show now, not the oldest one', () => {
    const db = getLocalDb()
    const now = Date.parse('2026-06-30T12:00:00Z')
    const day = 24 * 60 * 60 * 1000
    const iso = (daysAgo: number) => new Date(now - daysAgo * day).toISOString()
    for (const host of ['a', 'b'])
      db.prepare(
        `INSERT INTO price_sources
           (knife_id, url, normalized_url, provider, lane_key, store_name,
            origin, created_at, updated_at)
         VALUES ('first', ?, ?, 'generic', ?, ?, 'manual', 't', 't')`,
      ).run(
        `https://${host}.example/p`,
        `https://${host}.example/p`,
        host,
        host,
      )
    const snapshot = db.prepare(
      `INSERT INTO price_snapshots
         (knife_id, source_id, price_minor, currency, availability,
          extraction_status, extraction_method, observed_at, last_seen_at)
       VALUES ('first', ?, ?, ?, 'in_stock', 'ok', 'json_ld', ?, ?)`,
    )
    // Store A read in UAH for days, then switched to USD; store B is USD.
    snapshot.run(1, 755900, 'UAH', iso(8), iso(7))
    snapshot.run(1, 756300, 'UAH', iso(7), iso(6))
    snapshot.run(1, 753900, 'UAH', iso(6), iso(5))
    snapshot.run(1, 16500, 'USD', iso(4), iso(0))
    snapshot.run(2, 16500, 'USD', iso(3), iso(0))

    const trend = buildPriceTrends(db, now).knives.first
    expect(trend.currency).toBe('USD')
    expect(trend.steps.at(-1)).toEqual({ at: now - 4 * day, price: 16500 })
    expect(trend.lowMinor).toBe(16500)
  })

  it('starts the chart when tracking began and keeps a same-day drop', () => {
    const db = getLocalDb()
    const now = Date.parse('2026-06-30T12:00:00Z')
    const hour = 60 * 60 * 1000
    db.prepare(
      `INSERT INTO price_sources
         (knife_id, url, normalized_url, provider, lane_key, store_name,
          origin, created_at, updated_at)
       VALUES ('third', 'https://c.example/p', 'https://c.example/p',
               'generic', 'c', 'c', 'manual', 't', 't')`,
    ).run()
    const snapshot = db.prepare(
      `INSERT INTO price_snapshots
         (knife_id, source_id, price_minor, currency, availability,
          extraction_status, extraction_method, observed_at, last_seen_at)
       VALUES ('third', 1, ?, 'USD', 'in_stock', 'ok', 'json_ld', ?, ?)`,
    )
    const iso = (hoursAgo: number) =>
      new Date(now - hoursAgo * hour).toISOString()
    snapshot.run(13500, iso(20), iso(5))
    snapshot.run(9450, iso(5), iso(0))

    const trend = buildWishlistTrends(db, ['third'], now).third
    expect(trend.since).toBe(now - 20 * hour)
    expect(trend.steps).toEqual([
      { at: now - 20 * hour, price: 13500 },
      { at: now - 5 * hour, price: 9450 },
    ])
    // The daily samples miss the 15-hour regular price.
    expect(trend.daily.filter((value) => value !== null)).toEqual([9450])
  })

  it('validates requests through the API', async () => {
    const bad = await post({ action: 'move', knifeId: 'first', lane: 'later' })
    expect(bad.status).toBe(400)
    const missing = await post({
      action: 'move',
      knifeId: 'first',
      lane: 'next',
    })
    expect(missing.status).toBe(404)
    const ok = await post({ action: 'add', knifeIds: ['second'] })
    expect(ok.status).toBe(200)
    expect((await ok.json()).items).toMatchObject([
      { knifeId: 'second', lane: 'saving' },
    ])
    expect(
      (await route.GET(new Request('http://localhost/api/wishlist'))).status,
    ).toBe(200)
  })
})
