import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as knivesRoute from '@/app/api/knives/route'
import * as priceWatchRoute from '@/app/api/knives/[id]/price-watch/route'
import { closeLocalDb, getLocalDb } from '@/lib/local-db'
import type { PriceWatchView } from '@/lib/price-monitor/shared'
import { syncAllAutoSources } from '@/lib/price-monitor/store'
import { getPriceMonitorWorker } from '@/lib/price-monitor/worker'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

// A product link is checked whatever store it is on, Amazon included.

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
        brand: 'Benchmade',
        name: 'Bugout 535GRY-1',
        specs: { price: '$180' },
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

const BUGOUT = 'https://www.amazon.com/Benchmade-Bugout-535GRY-1/dp/B07B4JJZ5W'

describe('Amazon price sources', () => {
  it('monitors a knife whose product link is on Amazon', async () => {
    const knifeId = await createKnife(BUGOUT)
    const watch = await getWatch(knifeId)
    expect(watch.sources).toHaveLength(1)
    expect(watch.sources[0]).toMatchObject({
      url: BUGOUT,
      origin: 'auto',
      laneKey: 'amazon',
    })
    expect(watch.eligibility.monitored).toBe(true)
  })

  it('accepts Amazon links added by hand', async () => {
    const knifeId = await createKnife(
      'https://www.vosteed.com/products/raccoon',
    )
    const response = await addSource(
      knifeId,
      'https://www.amazon.co.uk/Vosteed-Raccoon/dp/B0FRRWK52D',
    )
    expect(response.status).toBe(200)
    expect((await getWatch(knifeId)).sources.map((s) => s.laneKey)).toEqual([
      'vosteed.com',
      'amazon',
    ])
  })

  it('brings back an Amazon source removed by an earlier version, with its history', async () => {
    const knifeId = await createKnife(BUGOUT)
    expect(await syncAllAutoSources()).toBe(1)
    const database = getLocalDb()
    const [{ id }] = database
      .prepare('SELECT id FROM price_sources WHERE knife_id = ?')
      .all(knifeId) as Array<{ id: number }>
    const removedAt = new Date().toISOString()
    // BladeVault 2.5.12 removed Amazon sources when the vault opened.
    database
      .prepare(
        `UPDATE price_sources SET removed_at = ?, status = 'ok',
           next_check_at = ? WHERE id = ?`,
      )
      .run(removedAt, removedAt, id)
    database
      .prepare(
        `INSERT INTO price_snapshots
           (knife_id, source_id, price_minor, currency, availability,
            extraction_status, extraction_method, observed_at, last_seen_at)
         VALUES (?, ?, 16000, 'USD', 'in_stock', 'ok', 'amazon', ?, ?)`,
      )
      .run(knifeId, id, removedAt, removedAt)

    // Opening the vault no longer removes anything.
    closeLocalDb()
    expect(
      getLocalDb()
        .prepare('SELECT removed_at FROM price_sources WHERE id = ?')
        .get(id),
    ).toEqual({ removed_at: removedAt })

    expect(await syncAllAutoSources()).toBe(1)
    const reopened = getLocalDb()
    expect(
      reopened
        .prepare(
          `SELECT id, removed_at, status, next_check_at FROM price_sources
           WHERE knife_id = ?`,
        )
        .all(knifeId),
    ).toEqual([
      { id, removed_at: null, status: 'pending', next_check_at: null },
    ])
    expect(
      reopened
        .prepare(
          'SELECT COUNT(*) AS n FROM price_snapshots WHERE source_id = ?',
        )
        .get(id),
    ).toEqual({ n: 1 })
    // Repeat-safe.
    expect(await syncAllAutoSources()).toBe(0)
  })
})
