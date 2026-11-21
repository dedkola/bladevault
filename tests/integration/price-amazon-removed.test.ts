import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as knivesRoute from '@/app/api/knives/route'
import * as priceWatchRoute from '@/app/api/knives/[id]/price-watch/route'
import { closeLocalDb, getLocalDb } from '@/lib/local-db'
import {
  AMAZON_NOT_SUPPORTED,
  type PriceWatchView,
} from '@/lib/price-monitor/shared'
import { getPriceMonitorWorker } from '@/lib/price-monitor/worker'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

// Amazon forbids automated AI access, so Price Drops does not monitor it.

let vault: TempVault | null = null

beforeEach(async () => {
  vault = await createTempVault()
})
afterEach(async () => {
  await getPriceMonitorWorker().stop()
  await vault?.cleanup()
  vault = null
})

async function createKnife(sourceUrl = '') {
  const response = await knivesRoute.POST(
    new Request('http://localhost/api/knives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brand: 'Vosteed',
        name: 'Raccoon TiSlim',
        specs: { price: '$135' },
        sourceUrl,
      }),
    }),
  )
  return ((await response.json()) as { knife: { id: string } }).knife.id
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })

async function getWatch(knifeId: string) {
  const response = await priceWatchRoute.GET(
    new Request(`http://localhost/api/knives/${knifeId}/price-watch`),
    params(knifeId),
  )
  return ((await response.json()) as { watch: PriceWatchView }).watch
}

function addSource(knifeId: string, url: string) {
  return priceWatchRoute.PUT(
    new Request(`http://localhost/api/knives/${knifeId}/price-watch`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ add: [{ url }] }),
    }),
    params(knifeId),
  )
}

describe('Price Drops without Amazon', () => {
  it('refuses Amazon links as price sources', async () => {
    const knifeId = await createKnife(
      'https://www.vosteed.com/products/raccoon',
    )
    for (const url of [
      'https://www.amazon.com/dp/B0FRRWK52D',
      'https://smile.amazon.co.uk/Vosteed-Raccoon/dp/B0FRRWK52D',
      'https://amzn.to/3xYzAbC',
    ]) {
      const response = await addSource(knifeId, url)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: AMAZON_NOT_SUPPORTED })
    }
    expect((await getWatch(knifeId)).sources.map((s) => s.url)).toEqual([
      'https://www.vosteed.com/products/raccoon',
    ])
  })

  it('gives a knife whose product link is on Amazon no automatic source', async () => {
    const knifeId = await createKnife('https://www.amazon.com/dp/B0FRRWK52D')
    const watch = await getWatch(knifeId)
    expect(watch.sources).toEqual([])
    expect(watch.eligibility).toMatchObject({
      monitored: false,
      reason: 'no_source',
    })
    // Other stores can still be added by hand.
    const response = await addSource(
      knifeId,
      'https://www.bladehq.com/item--Vosteed-Raccoon-TiSlim-A4501--227649',
    )
    expect(response.status).toBe(200)
    expect((await getWatch(knifeId)).sources).toHaveLength(1)
  })

  it('removes Amazon sources from a vault that has them and keeps their history', async () => {
    const knifeId = await createKnife(
      'https://www.vosteed.com/products/raccoon',
    )
    const database = getLocalDb()
    const now = new Date().toISOString()
    // Saved by an older BladeVault that still monitored Amazon.
    const insert = database.prepare(
      `INSERT INTO price_sources
         (knife_id, url, normalized_url, provider, lane_key, store_name,
          origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?)`,
    )
    const amazon = Number(
      insert.run(
        knifeId,
        'https://www.amazon.com/dp/B0FRRWK52D',
        'https://www.amazon.com/dp/B0FRRWK52D',
        'amazon',
        'amazon',
        'amazon',
        now,
        now,
      ).lastInsertRowid,
    )
    const shortLink = Number(
      insert.run(
        knifeId,
        'https://amzn.to/3xYzAbC',
        'https://amzn.to/3xYzAbC',
        'generic',
        'amzn.to',
        'amzn.to',
        now,
        now,
      ).lastInsertRowid,
    )
    database
      .prepare(
        `INSERT INTO price_snapshots
           (knife_id, source_id, price_minor, currency, availability,
            extraction_status, extraction_method, observed_at, last_seen_at)
         VALUES (?, ?, 9450, 'USD', 'in_stock', 'ok', 'amazon', ?, ?)`,
      )
      .run(knifeId, amazon, now, now)
    database
      .prepare(
        `INSERT INTO price_discovery
           (knife_id, store, marketplace, status, attempts, last_attempt_at)
         VALUES (?, 'amazon', 'amazon.com', 'not_found', 1, ?),
                (?, 'bladehq', 'bladehq.com', 'not_found', 1, ?)`,
      )
      .run(knifeId, now, knifeId, now)
    database
      .prepare(
        `INSERT INTO price_host_state (lane_key, min_gap_ms, ready_at, updated_at)
         VALUES ('amazon', 300000, ?, ?)`,
      )
      .run(now, now)

    // The next time the vault opens.
    closeLocalDb()
    const reopened = getLocalDb()
    const removedAt = reopened
      .prepare('SELECT id, removed_at FROM price_sources WHERE id IN (?, ?)')
      .all(amazon, shortLink) as Array<{ id: number; removed_at: string }>
    expect(removedAt).toHaveLength(2)
    for (const row of removedAt) expect(row.removed_at).toBeTruthy()
    expect((await getWatch(knifeId)).sources.map((s) => s.url)).toEqual([
      'https://www.vosteed.com/products/raccoon',
    ])
    // Past readings stay, like any removed source.
    expect(
      reopened
        .prepare(
          'SELECT COUNT(*) AS n FROM price_snapshots WHERE source_id = ?',
        )
        .get(amazon),
    ).toEqual({ n: 1 })
    expect(
      reopened
        .prepare('SELECT store FROM price_discovery WHERE knife_id = ?')
        .all(knifeId),
    ).toEqual([{ store: 'bladehq' }])
    expect(
      reopened
        .prepare("SELECT 1 FROM price_host_state WHERE lane_key = 'amazon'")
        .get(),
    ).toBeUndefined()

    // Opening again changes nothing.
    const before = reopened
      .prepare(
        'SELECT id, removed_at, updated_at FROM price_sources ORDER BY id',
      )
      .all()
    closeLocalDb()
    expect(
      getLocalDb()
        .prepare(
          'SELECT id, removed_at, updated_at FROM price_sources ORDER BY id',
        )
        .all(),
    ).toEqual(before)
  })
})
