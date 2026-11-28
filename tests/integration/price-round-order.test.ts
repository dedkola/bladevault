import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as knivesRoute from '@/app/api/knives/route'
import * as priceWatchRoute from '@/app/api/knives/[id]/price-watch/route'
import { getLocalDb } from '@/lib/local-db'
import { DISCOVERY_STORES } from '@/lib/price-monitor/discovery-stores'
import { orderKnives, readRoundKnifeIds } from '@/lib/price-monitor/round-store'
import { getSettings, saveSettings } from '@/lib/settings'
import {
  DEFAULT_PRICE_MONITORING,
  type PriceMonitoringSettings,
} from '@/lib/settings-shared'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

const NOW = Date.UTC(2026, 10, 27, 12)
const HOUR = 60 * 60 * 1000
let vault: TempVault | null = null
let counter = 0

beforeEach(async () => {
  vault = await createTempVault()
})
afterEach(async () => {
  await vault?.cleanup()
  vault = null
})

function useSettings(
  overrides: Partial<PriceMonitoringSettings> = {},
): PriceMonitoringSettings {
  saveSettings({
    priceMonitoring: {
      ...DEFAULT_PRICE_MONITORING,
      scope: { kind: 'all', knifeIds: [] },
      ai: {
        ...DEFAULT_PRICE_MONITORING.ai,
        enabled: true,
        baseUrl: 'http://localhost:11434/v1',
        model: 'test-model',
      },
      otherStores: {
        enabled: true,
        stores: {
          bladehq: true,
          smkw: false,
          dlttrading: false,
          knifejoy: false,
          northwestknives: false,
          amazon: false,
        },
      },
      ...overrides,
    },
  })
  return getSettings().priceMonitoring
}

/** A knife; with a URL its product link becomes a price source. */
async function knife(url?: string) {
  counter += 1
  const response = await knivesRoute.POST(
    new Request('http://localhost/api/knives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `Knife ${counter}`,
        brand: 'Test',
        specs: { price: '100 USD' },
        sourceUrl: url,
      }),
    }),
  )
  const id = ((await response.json()) as { knife: { id: string } }).knife.id
  await priceWatchRoute.GET(new Request('http://localhost/x'), {
    params: Promise.resolve({ id }),
  })
  return id
}

function checkedAt(knifeId: string, at: number) {
  getLocalDb()
    .prepare('UPDATE price_sources SET last_checked_at = ? WHERE knife_id = ?')
    .run(new Date(at).toISOString(), knifeId)
}

function searchedAt(knifeId: string, at: number) {
  getLocalDb()
    .prepare(
      `INSERT INTO price_discovery
         (knife_id, store, marketplace, status, last_attempt_at, next_attempt_at)
       VALUES (?, 'bladehq', ?, 'not_found', ?, ?)`,
    )
    .run(
      knifeId,
      DISCOVERY_STORES.bladehq.marketplace,
      new Date(at).toISOString(),
      new Date(at + 24 * HOUR).toISOString(),
    )
}

function wishlist(knifeId: string, lane: string, position: number) {
  const at = new Date(NOW).toISOString()
  getLocalDb()
    .prepare(
      `INSERT INTO wishlist_items (knife_id, lane, position, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(knifeId, lane, position, at, at)
}

describe('round order', () => {
  it('goes Wishlist, never checked, never searched, then oldest check', async () => {
    const settings = useSettings()
    const recent = await knife('https://shop.example.com/a')
    const old = await knife('https://shop.example.com/b')
    const fresh = await knife('https://shop.example.com/c')
    const unsearched = await knife('https://shop.example.com/d')
    const someday = await knife('https://shop.example.com/e')
    const next = await knife('https://shop.example.com/f')
    checkedAt(recent, NOW - HOUR)
    checkedAt(old, NOW - 5 * 24 * HOUR)
    checkedAt(unsearched, NOW - 2 * HOUR)
    checkedAt(someday, NOW - 10 * 60 * 1000)
    checkedAt(next, NOW - 10 * 60 * 1000)
    for (const id of [recent, old, fresh, someday, next])
      searchedAt(id, NOW - 3 * HOUR)
    wishlist(someday, 'someday', 0)
    wishlist(next, 'next', 0)

    expect(
      readRoundKnifeIds(getLocalDb(), settings, { searches: true, now: NOW }),
    ).toEqual([next, someday, fresh, unsearched, old, recent])
  })

  it('leaves never searched out when searches do not run', async () => {
    const settings = useSettings()
    const recent = await knife('https://shop.example.com/a')
    const unsearched = await knife('https://shop.example.com/b')
    const old = await knife('https://shop.example.com/c')
    checkedAt(recent, NOW - HOUR)
    checkedAt(unsearched, NOW - 2 * HOUR)
    checkedAt(old, NOW - 3 * 24 * HOUR)
    searchedAt(recent, NOW - HOUR)
    searchedAt(old, NOW - HOUR)

    expect(
      readRoundKnifeIds(getLocalDb(), settings, { searches: true, now: NOW }),
    ).toEqual([unsearched, old, recent])
    expect(
      readRoundKnifeIds(getLocalDb(), settings, { searches: false, now: NOW }),
    ).toEqual([old, unsearched, recent])
  })

  it('does not count a knife with a link at the store as never searched', async () => {
    const settings = useSettings()
    const bladehq = await knife('https://www.bladehq.com/item/test-knife-1')
    const old = await knife('https://shop.example.com/a')
    checkedAt(bladehq, NOW - HOUR)
    checkedAt(old, NOW - 2 * 24 * HOUR)
    searchedAt(old, NOW - HOUR)

    expect(
      readRoundKnifeIds(getLocalDb(), settings, { searches: true, now: NOW }),
    ).toEqual([old, bladehq])
  })
})

describe('orderKnives', () => {
  const row = (
    id: string,
    extra: Partial<Parameters<typeof orderKnives>[0][number]> = {},
  ) => ({
    id,
    onWishlist: false,
    neverChecked: false,
    neverSearched: false,
    oldestCheck: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  })

  it('keeps the Wishlist order it is given', () => {
    expect(
      orderKnives([
        row('w2', { onWishlist: true, oldestCheck: 5, addedAt: '2026-02-01' }),
        row('w1', { onWishlist: true, oldestCheck: 1, addedAt: '2026-01-01' }),
      ]),
    ).toEqual(['w2', 'w1'])
  })

  it('puts knives never checked anywhere before those checked', () => {
    expect(
      orderKnives([
        row('b', { oldestCheck: 10 }),
        row('a', { oldestCheck: null }),
        row('c', { oldestCheck: 5 }),
      ]),
    ).toEqual(['a', 'c', 'b'])
  })
})
