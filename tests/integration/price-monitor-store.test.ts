import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as knivesRoute from '@/app/api/knives/route'
import * as knifeRoute from '@/app/api/knives/[id]/route'
import * as priceWatchRoute from '@/app/api/knives/[id]/price-watch/route'
import * as checkRoute from '@/app/api/prices/check/route'
import { getLocalDb } from '@/lib/local-db'
import { checkPriceSource } from '@/lib/price-monitor/engine'
import { getPriceMonitorWorker } from '@/lib/price-monitor/worker'
import type { PriceWatchView } from '@/lib/price-monitor/shared'
import { readHostState, readLaneHealth } from '@/lib/price-monitor/store'
import type { ExtractedOffer } from '@/lib/scrape-offer'
import { ScrapeError } from '@/lib/scrape-errors'
import { monitorWholeCollection } from '@/tests/helpers/monitor-whole-collection'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

const mocks = vi.hoisted(() => ({
  browser: vi.fn(),
  http: vi.fn(),
}))

vi.mock('@/lib/price-monitor/fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/price-monitor/fetch')>()),
  checkViaBrowser: mocks.browser,
  checkViaHttp: mocks.http,
}))
vi.mock('@/lib/url-validation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/url-validation')>()),
  validateExternalUrl: async (value: string) => ({
    ok: true,
    url: new URL(value),
  }),
}))

let vault: TempVault | null = null

beforeEach(async () => {
  vault = await createTempVault()
  monitorWholeCollection()
  vi.resetAllMocks()
})
afterEach(async () => {
  await getPriceMonitorWorker().stop()
  await vault?.cleanup()
  vault = null
})

const PRODUCT_URL = 'https://shop.example/products/raccoon'

function offer(
  amount: number | null,
  availability: ExtractedOffer['availability'] = 'in_stock',
): ExtractedOffer {
  return { amount, currency: 'USD', availability, method: 'jsonld' }
}

/** One browser reading; `server` is what the raw server HTML showed. */
function browserReading(
  rendered: ExtractedOffer | null,
  server: ExtractedOffer | null = null,
) {
  mocks.browser.mockResolvedValueOnce({
    offer: rendered,
    serverOffer: server,
    finalUrl: PRODUCT_URL,
    isShopify: false,
  })
}

function json(url: string, method: string, body: unknown) {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })

async function createKnife(price: string, sourceUrl = PRODUCT_URL) {
  const response = await knivesRoute.POST(
    json('http://localhost/api/knives', 'POST', {
      name: 'Raccoon',
      brand: 'Vosteed',
      specs: { price },
      sourceUrl,
    }),
  )
  return ((await response.json()) as { knife: { id: string } }).knife.id
}

async function getWatch(knifeId: string) {
  const response = await priceWatchRoute.GET(
    new Request(`http://localhost/api/knives/${knifeId}/price-watch`),
    params(knifeId),
  )
  return {
    status: response.status,
    watch: ((await response.json()) as { watch: PriceWatchView }).watch,
  }
}

async function putWatch(knifeId: string, body: unknown) {
  const response = await priceWatchRoute.PUT(
    json(`http://localhost/api/knives/${knifeId}/price-watch`, 'PUT', body),
    params(knifeId),
  )
  return {
    status: response.status,
    body: (await response.json()) as { watch?: PriceWatchView; error?: string },
  }
}

function rows(sql: string, ...args: unknown[]) {
  return getLocalDb()
    .prepare(sql)
    .all(...args) as Array<Record<string, unknown>>
}

describe('price watch API', () => {
  it('creates the auto source and reports Auto eligibility', async () => {
    const id = await createKnife('129.00 USD')
    const { status, watch } = await getWatch(id)
    expect(status).toBe(200)
    expect(watch).toMatchObject({
      mode: 'auto',
      eligibility: { monitored: true, reason: 'monitored_auto', tier: 'scope' },
      maxSources: 10,
    })
    expect(watch.sources).toEqual([
      expect.objectContaining({
        url: PRODUCT_URL,
        origin: 'auto',
        storeName: 'shop.example',
        laneKey: 'shop.example',
        status: 'pending',
        enabled: true,
      }),
    ])
    // A second read does not duplicate it.
    expect((await getWatch(id)).watch.sources).toHaveLength(1)
  })

  it('monitors Auto knives without a price; Always monitor too', async () => {
    const id = await createKnife('')
    expect((await getWatch(id)).watch.eligibility.reason).toBe('monitored_auto')
    const { body } = await putWatch(id, { mode: 'on' })
    expect(body.watch?.eligibility).toEqual({
      monitored: true,
      reason: 'monitored_forced',
      tier: 'scope',
    })
  })

  it('adds, pauses and removes sources up to the limit', async () => {
    const id = await createKnife('50 USD')
    await getWatch(id)
    const added = await putWatch(id, {
      add: Array.from({ length: 9 }, (_, i) => ({
        url: `https://store${i}.example/p`,
      })),
    })
    expect(added.status).toBe(200)
    expect(added.body.watch?.sources).toHaveLength(10)

    const full = await putWatch(id, {
      add: [{ url: 'https://more.example/p' }],
    })
    expect(full).toMatchObject({ status: 400 })
    expect(full.body.error).toContain('at most 10')

    const duplicate = await putWatch(id, {
      add: [{ url: `${PRODUCT_URL}?utm_source=mail` }],
    })
    expect(duplicate.status).toBe(409)

    const sources = added.body.watch!.sources
    const autoSource = sources.find((s) => s.origin === 'auto')!
    const manual = sources.find((s) => s.origin === 'manual')!
    expect((await putWatch(id, { remove: [autoSource.id] })).status).toBe(400)

    const paused = await putWatch(id, {
      update: [{ id: autoSource.id, enabled: false, storeName: 'Vosteed' }],
      remove: [manual.id],
    })
    expect(paused.body.watch?.sources).toHaveLength(9)
    expect(
      paused.body.watch?.sources.find((s) => s.id === autoSource.id),
    ).toMatchObject({ enabled: false, storeName: 'Vosteed' })
    // The removed source stays in the table for history.
    expect(
      rows('SELECT removed_at FROM price_sources WHERE id = ?', manual.id)[0]
        .removed_at,
    ).toEqual(expect.any(String))
  })

  it('moves the auto source when the product link changes', async () => {
    const id = await createKnife('50 USD')
    const first = (await getWatch(id)).watch.sources[0]
    await knifeRoute.PATCH(
      json(`http://localhost/api/knives/${id}`, 'PATCH', {
        sourceUrl: 'https://shop.example/products/raccoon-2',
      }),
      params(id),
    )
    const { watch } = await getWatch(id)
    expect(watch.sources).toHaveLength(1)
    expect(watch.sources[0]).toMatchObject({
      origin: 'auto',
      url: 'https://shop.example/products/raccoon-2',
    })
    expect(watch.sources[0].id).not.toBe(first.id)
  })
})

describe('price checks', () => {
  async function sourceIdFor(knifeId: string) {
    return (await getWatch(knifeId)).watch.sources[0].id
  }

  it('compresses snapshots and records price and stock events permanently', async () => {
    const knifeId = await createKnife('129.00 USD')
    const sourceId = await sourceIdFor(knifeId)

    browserReading(offer(100))
    browserReading(offer(100))
    browserReading(offer(80))
    // Stock changes are recorded once a second reading agrees.
    browserReading(offer(null, 'out_of_stock'))
    browserReading(offer(null, 'out_of_stock'))
    browserReading(offer(75, 'in_stock'))
    browserReading(offer(75, 'in_stock'))
    for (let i = 0; i < 7; i += 1)
      await checkPriceSource(sourceId, { trigger: 'manual' })

    const snapshots = rows(
      'SELECT price_minor, availability, observations FROM price_snapshots WHERE source_id = ? ORDER BY id',
      sourceId,
    )
    expect(snapshots).toEqual([
      { price_minor: 10000, availability: 'in_stock', observations: 2 },
      { price_minor: 8000, availability: 'in_stock', observations: 1 },
      { price_minor: null, availability: 'out_of_stock', observations: 2 },
      { price_minor: 7500, availability: 'in_stock', observations: 2 },
    ])
    expect(
      rows(
        'SELECT direction, previous_price_minor, price_minor, delta_pct, source_url, store_name FROM price_change_events ORDER BY id',
      ),
    ).toEqual([
      {
        direction: 'drop',
        previous_price_minor: 10000,
        price_minor: 8000,
        delta_pct: -20,
        source_url: PRODUCT_URL,
        store_name: 'shop.example',
      },
      {
        direction: 'drop',
        previous_price_minor: 8000,
        price_minor: 7500,
        delta_pct: -6.25,
        source_url: PRODUCT_URL,
        store_name: 'shop.example',
      },
    ])
    expect(
      rows('SELECT kind FROM stock_events ORDER BY id').map((r) => r.kind),
    ).toEqual(['out_of_stock', 'back_in_stock'])

    const { watch } = await getWatch(knifeId)
    expect(watch.sources[0]).toMatchObject({
      status: 'ok',
      lastPriceMinor: 7500,
      lastCurrency: 'USD',
      lastAvailability: 'in_stock',
      consecutiveFailures: 0,
    })
    expect(rows('SELECT checks, ok FROM price_monitor_daily')).toEqual([
      { checks: 7, ok: 7 },
    ])
    // The regular price is never touched.
    const knife = await knifeRoute.GET(
      new Request(`http://localhost/api/knives/${knifeId}`),
      params(knifeId),
    )
    expect(
      ((await knife.json()) as { knife: { specs: { price: string } } }).knife
        .specs.price,
    ).toBe('129.00 USD')
  })

  it('needs a second matching reading for an implausible jump', async () => {
    const knifeId = await createKnife('129.00 USD')
    const sourceId = await sourceIdFor(knifeId)
    browserReading(offer(100))
    await checkPriceSource(sourceId, { trigger: 'manual' })

    browserReading(offer(10))
    browserReading(offer(12))
    await expect(
      checkPriceSource(sourceId, { trigger: 'manual' }),
    ).resolves.toMatchObject({ outcome: 'failed', errorCode: 'implausible' })
    expect(rows('SELECT id FROM price_snapshots')).toHaveLength(1)

    browserReading(offer(10))
    browserReading(offer(10))
    await expect(
      checkPriceSource(sourceId, { trigger: 'manual' }),
    ).resolves.toMatchObject({ outcome: 'ok' })
    expect(rows('SELECT direction FROM price_change_events')).toEqual([
      { direction: 'drop' },
    ])
  })

  it('learns plain HTTP per store and falls back to the browser', async () => {
    const knifeId = await createKnife('129.00 USD')
    const sourceId = await sourceIdFor(knifeId)
    for (let i = 0; i < 3; i += 1) {
      browserReading(offer(100), offer(100))
      await checkPriceSource(sourceId, { trigger: 'manual' })
    }
    expect(readHostState(getLocalDb(), 'shop.example').strategy).toBe(
      'http_first',
    )

    mocks.http.mockResolvedValueOnce({
      offer: offer(100),
      finalUrl: PRODUCT_URL,
      isShopify: false,
    })
    await checkPriceSource(sourceId, { trigger: 'manual' })
    expect(mocks.http).toHaveBeenCalledTimes(1)
    expect(mocks.browser).toHaveBeenCalledTimes(3)

    mocks.http.mockRejectedValueOnce(new ScrapeError('challenge'))
    browserReading(offer(100))
    await expect(
      checkPriceSource(sourceId, { trigger: 'manual' }),
    ).resolves.toMatchObject({ outcome: 'ok' })
    expect(readHostState(getLocalDb(), 'shop.example')).toMatchObject({
      strategy: 'browser_first',
      strategyUntil: expect.any(String),
    })
    expect(
      rows('SELECT method FROM price_check_log ORDER BY id').map(
        (r) => r.method,
      ),
    ).toEqual(['browser', 'browser', 'browser', 'http', 'browser'])
  })

  it('pauses a source whose page is missing three times in a row', async () => {
    const knifeId = await createKnife('129.00 USD')
    const sourceId = await sourceIdFor(knifeId)
    for (let i = 0; i < 3; i += 1) {
      mocks.browser.mockRejectedValueOnce(
        new ScrapeError('http', 'The website returned HTTP 404. Open the URL'),
      )
      await checkPriceSource(sourceId, { trigger: 'manual' })
    }
    const { watch } = await getWatch(knifeId)
    expect(watch.sources[0]).toMatchObject({
      enabled: false,
      status: 'failed',
      consecutiveFailures: 3,
      lastError: expect.stringContaining('paused'),
    })
    expect(
      rows('SELECT http_status FROM price_check_log').map((r) => r.http_status),
    ).toEqual([404, 404, 404])
  })

  it('marks a page without a price as suspect only after a price', async () => {
    const knifeId = await createKnife('129.00 USD')
    const sourceId = await sourceIdFor(knifeId)
    browserReading(null)
    await expect(
      checkPriceSource(sourceId, { trigger: 'manual' }),
    ).resolves.toMatchObject({ outcome: 'no_price', suspect: false })
    browserReading(offer(100))
    await expect(
      checkPriceSource(sourceId, { trigger: 'manual' }),
    ).resolves.toMatchObject({ outcome: 'ok', suspect: false })
    browserReading(null)
    await expect(
      checkPriceSource(sourceId, { trigger: 'manual' }),
    ).resolves.toMatchObject({
      outcome: 'no_price',
      errorCode: 'not_found',
      suspect: true,
      laneOutcome: 'success',
    })
  })

  it('counts each store’s last 24 hours by what happened', async () => {
    const database = getLocalDb()
    const insert = database.prepare(
      `INSERT INTO price_check_log (lane_key, trigger, source_id, knife_id,
         started_at, duration_ms, outcome, http_status)
       VALUES (?, 'scheduled', 1, 'k', ?, 1000, ?, ?)`,
    )
    const now = Date.UTC(2026, 10, 18, 12)
    const recent = new Date(now - 60 * 60_000).toISOString()
    insert.run('shop.example', recent, 'ok', 200)
    insert.run('shop.example', recent, 'no_price', 200)
    insert.run('shop.example', recent, 'blocked', 429)
    insert.run('shop.example', recent, 'failed', 503)
    insert.run('shop.example', recent, 'blocked', 403)
    insert.run('shop.example', recent, 'failed', null)
    insert.run(
      'shop.example',
      new Date(now - 25 * 60 * 60_000).toISOString(),
      'ok',
      200,
    )
    expect(
      readLaneHealth(database, now - 24 * 60 * 60_000).get('shop.example'),
    ).toEqual({
      checks: 6,
      ok: 1,
      noPrice: 1,
      throttled: 2,
      blocked: 1,
      failed: 1,
    })
  })

  it('records blocks and failures without touching history', async () => {
    const knifeId = await createKnife('129.00 USD')
    const sourceId = await sourceIdFor(knifeId)
    mocks.browser.mockRejectedValueOnce(new ScrapeError('challenge'))
    await expect(
      checkPriceSource(sourceId, { trigger: 'manual' }),
    ).resolves.toMatchObject({ outcome: 'blocked', errorCode: 'challenge' })
    mocks.browser.mockRejectedValueOnce(new ScrapeError('network'))
    await checkPriceSource(sourceId, { trigger: 'manual' })
    browserReading(null)
    await expect(
      checkPriceSource(sourceId, { trigger: 'manual' }),
    ).resolves.toMatchObject({ outcome: 'no_price', errorCode: 'not_found' })

    expect(rows('SELECT id FROM price_snapshots')).toHaveLength(0)
    expect(
      rows('SELECT outcome, error_code FROM price_check_log ORDER BY id'),
    ).toEqual([
      { outcome: 'blocked', error_code: 'challenge' },
      { outcome: 'failed', error_code: 'network' },
      { outcome: 'no_price', error_code: 'not_found' },
    ])
    const { watch } = await getWatch(knifeId)
    expect(watch.sources[0]).toMatchObject({
      status: 'price_unavailable',
      lastError: 'No price or stock status found on the page.',
    })
  })

  it('runs Check now through the queue, one check per store', async () => {
    const knifeId = await createKnife('129.00 USD')
    await getWatch(knifeId)
    await putWatch(knifeId, { add: [{ url: 'https://other.example/p' }] })
    mocks.browser.mockImplementation(async (url: string) => ({
      offer: offer(url.includes('other.example') ? 90 : 100),
      serverOffer: null,
      finalUrl: url,
      isShopify: false,
    }))
    const response = await checkRoute.POST(
      json('http://localhost/api/prices/check', 'POST', {
        scope: 'knife',
        id: knifeId,
      }),
    )
    expect(response.status).toBe(202)
    expect(
      ((await response.json()) as { queued: number[] }).queued,
    ).toHaveLength(2)
    expect((await getWatch(knifeId)).watch.queuedSourceIds).toHaveLength(2)

    const worker = getPriceMonitorWorker()
    for (
      let i = 0;
      i < 20 && rows('SELECT 1 FROM price_check_log').length < 2;
      i += 1
    ) {
      await worker.pass()
      await worker.idle()
    }
    const { watch } = await getWatch(knifeId)
    expect(watch.queuedSourceIds).toEqual([])
    expect(watch.sources.map((s) => s.lastPriceMinor)).toEqual([10000, 9000])
    // Each store's pace is recorded for the next scheduled check.
    expect(
      rows(
        'SELECT lane_key, circuit, last_request_at FROM price_host_state ORDER BY lane_key',
      ),
    ).toEqual([
      expect.objectContaining({ lane_key: 'other.example', circuit: 'closed' }),
      expect.objectContaining({ lane_key: 'shop.example', circuit: 'closed' }),
    ])
  })

  it('keeps history of removed sources and deletes it with the knife', async () => {
    const knifeId = await createKnife('129.00 USD')
    const otherKnife = await createKnife('60 USD', 'https://other.example/p')
    await getWatch(otherKnife)
    const sourceId = await sourceIdFor(knifeId)
    const added = await putWatch(knifeId, {
      add: [{ url: 'https://second.example/p' }],
    })
    const second = added.body.watch!.sources.find((s) => s.origin === 'manual')!

    browserReading(offer(100))
    browserReading(offer(90))
    browserReading(offer(50))
    browserReading(offer(45))
    await checkPriceSource(sourceId, { trigger: 'manual' })
    await checkPriceSource(sourceId, { trigger: 'manual' })
    await checkPriceSource(second.id, { trigger: 'manual' })
    await checkPriceSource(second.id, { trigger: 'manual' })

    await putWatch(knifeId, { remove: [second.id] })
    expect(
      rows('SELECT id FROM price_snapshots WHERE source_id = ?', second.id),
    ).toHaveLength(2)
    // Its first reading undercut the first store (a drop of the knife),
    // then its own drop.
    expect(
      rows('SELECT id FROM price_change_events WHERE source_id = ?', second.id),
    ).toHaveLength(2)

    await knifeRoute.DELETE(
      new Request(`http://localhost/api/knives/${knifeId}`, {
        method: 'DELETE',
      }),
      params(knifeId),
    )
    for (const table of [
      'price_sources',
      'price_snapshots',
      'price_change_events',
      'price_check_log',
    ])
      expect(
        rows(`SELECT 1 FROM ${table} WHERE knife_id = ?`, knifeId),
      ).toHaveLength(0)
    expect(
      rows('SELECT 1 FROM price_sources WHERE knife_id = ?', otherKnife),
    ).toHaveLength(1)
    // Store-level rollups are not tied to a knife.
    expect(rows('SELECT 1 FROM price_monitor_daily').length).toBeGreaterThan(0)
  })
})
