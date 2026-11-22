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
  buildWishlistTrends,
  getWishlist,
  mutateWishlist,
} from '@/lib/wishlist-storage'
import { wishlistSignal } from '@/lib/wishlist'
import * as route from '@/app/api/wishlist/route'

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
    expect(trend.daily).toHaveLength(30)
    expect(trend.daily[0]).toBe(15000) // 29 days ago: only store A
    expect(trend.daily[22]).toBeNull() // 7 days ago: A out of stock, B not yet
    expect(trend.daily[29]).toBe(14000)
    expect(buildWishlistTrends(db, ['second'], now)).toEqual({})
  })

  it('signals buy, close and wait against the target', () => {
    expect(wishlistSignal(12000, 'USD', 12500, 'USD')).toBe('buy')
    expect(wishlistSignal(13000, 'USD', 12500, 'USD')).toBe('close')
    expect(wishlistSignal(15000, 'USD', 12500, 'USD')).toBe('wait')
    expect(wishlistSignal(12000, 'EUR', 12500, 'USD')).toBe('none')
    expect(wishlistSignal(12000, 'USD', null, null)).toBe('none')
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
