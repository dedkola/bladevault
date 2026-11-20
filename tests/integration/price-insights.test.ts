import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as knivesRoute from '@/app/api/knives/route'
import * as priceWatchRoute from '@/app/api/knives/[id]/price-watch/route'
import * as historyRoute from '@/app/api/prices/history/route'
import * as overviewRoute from '@/app/api/prices/overview/route'
import { checkPriceSource } from '@/lib/price-monitor/engine'
import type { KnifeHistory, PriceOverview } from '@/lib/price-monitor/insights'
import type { PriceWatchView } from '@/lib/price-monitor/shared'
import { getLocalDb } from '@/lib/local-db'
import { readQueueCandidates } from '@/lib/price-monitor/store'
import type { ExtractedOffer } from '@/lib/scrape-offer'
import { getSettings, saveSettings } from '@/lib/settings'
import { DEFAULT_PRICE_MONITORING } from '@/lib/settings-shared'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

const mocks = vi.hoisted(() => ({ browser: vi.fn() }))
vi.mock('@/lib/price-monitor/fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/price-monitor/fetch')>()),
  checkViaBrowser: mocks.browser,
}))
vi.mock('@/lib/url-validation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/url-validation')>()),
  validateExternalUrl: async (value: string) => ({
    ok: true,
    url: new URL(value),
  }),
}))

const DAY = 24 * 60 * 60 * 1000
const START = Date.UTC(2026, 7, 1, 12)
let vault: TempVault | null = null

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(START)
  vault = await createTempVault()
  vi.resetAllMocks()
})
afterEach(async () => {
  vi.useRealTimers()
  await vault?.cleanup()
  vault = null
})

function json(url: string, method: string, body: unknown) {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function createKnife(name: string, price: string, urls: string[]) {
  const response = await knivesRoute.POST(
    json('http://localhost/api/knives', 'POST', {
      name,
      brand: 'Vosteed',
      specs: { price },
      sourceUrl: urls[0],
    }),
  )
  const id = ((await response.json()) as { knife: { id: string } }).knife.id
  const params = { params: Promise.resolve({ id }) }
  let watch = (
    (await (
      await priceWatchRoute.GET(new Request('http://localhost/x'), params)
    ).json()) as { watch: PriceWatchView }
  ).watch
  if (urls.length > 1)
    watch = (
      (await (
        await priceWatchRoute.PUT(
          json('http://localhost/x', 'PUT', {
            add: urls.slice(1).map((url) => ({ url })),
          }),
          params,
        )
      ).json()) as { watch: PriceWatchView }
    ).watch
  return { id, sources: watch.sources.map((source) => source.id) }
}

function offer(
  amount: number | null,
  availability: ExtractedOffer['availability'] = 'in_stock',
  currency = 'USD',
): ExtractedOffer {
  return { amount, currency, availability, method: 'jsonld' }
}

/** Advances the clock, then runs one check that reads `reading`. */
async function checkAt(
  dayOffset: number,
  sourceId: number,
  reading: ExtractedOffer,
) {
  vi.setSystemTime(START + dayOffset * DAY)
  mocks.browser.mockResolvedValueOnce({
    offer: reading,
    serverOffer: null,
    finalUrl: 'https://shop.example/p',
    isShopify: false,
  })
  await checkPriceSource(sourceId, { trigger: 'manual' })
}

async function overview(days?: number) {
  const response = await overviewRoute.GET(
    new Request(
      `http://localhost/api/prices/overview${days ? `?days=${days}` : ''}`,
    ),
  )
  return ((await response.json()) as { overview: PriceOverview }).overview
}

async function history(knifeId: string, range: string) {
  const response = await historyRoute.GET(
    new Request(
      `http://localhost/api/prices/history?knifeId=${knifeId}&range=${range}`,
    ),
  )
  return {
    status: response.status,
    history: ((await response.json()) as { history: KnifeHistory }).history,
  }
}

describe('price overview', () => {
  it('summarizes monitored knives, changes and stock', async () => {
    const raccoon = await createKnife('Raccoon', '129.00 USD', [
      'https://shop.example/raccoon',
      'https://amazon.example/raccoon',
    ])
    // A knife without a stored price is tracked but not monitored in Auto.
    const corgi = await createKnife('Corgi', '', ['https://shop.example/corgi'])

    await checkAt(0, raccoon.sources[0], offer(100))
    await checkAt(1, raccoon.sources[1], offer(95))
    await checkAt(10, raccoon.sources[0], offer(120)) // increase, outside 30 d
    await checkAt(45, raccoon.sources[0], offer(80)) // drop
    await checkAt(46, raccoon.sources[1], offer(null, 'out_of_stock'))
    await checkAt(47, corgi.sources[0], offer(40))

    const result = await overview()
    expect(result.kpis).toMatchObject({
      monitoredKnives: 1,
      sources: 2,
      stores: 2,
      drops: 1,
      increases: 0,
      outOfStock: 1,
      lastSuccessAt: new Date(START + 47 * DAY).toISOString(),
    })
    expect(result.recent.map((event) => event.kind)).toEqual([
      'out_of_stock',
      'drop',
      'increase',
    ])
    expect(result.drops[0]).toMatchObject({
      type: 'price',
      knife: { id: raccoon.id, name: 'Raccoon', brand: 'Vosteed' },
      storeName: 'shop.example',
      previousPriceMinor: 12000,
      priceMinor: 8000,
      deltaPct: -33.33,
    })
    expect(result.outOfStock).toEqual([
      expect.objectContaining({
        sourceId: raccoon.sources[1],
        since: new Date(START + 46 * DAY).toISOString(),
      }),
    ])
    expect(result.recentlyMonitored[0].knife.id).toBe(corgi.id)

    const summary = result.knives.find((k) => k.knife.id === raccoon.id)
    expect(summary).toMatchObject({
      monitored: true,
      sources: 2,
      bestPriceMinor: 8000,
      currency: 'USD',
      paidMinor: 12900,
      outOfStock: false,
      lastChange: expect.objectContaining({ kind: 'out_of_stock' }),
    })
    expect(result.knives.find((k) => k.knife.id === corgi.id)?.monitored).toBe(
      false,
    )

    // A wider window counts the earlier increase too.
    expect((await overview(60)).kpis.increases).toBe(1)
  })
})

describe('monitoring status', () => {
  it('gives each monitored source a result and counts checks per hour', async () => {
    const raccoon = await createKnife('Raccoon', '129.00 USD', [
      'https://shop.example/raccoon',
      'https://amazon.example/raccoon',
    ])
    const bean = await createKnife('Bean', '45.00 USD', [
      'https://other.example/bean',
    ])
    const [shop, amazon] = raccoon.sources
    await checkAt(0, shop, offer(100))
    await checkAt(0.01, amazon, offer(95))
    await checkAt(1, shop, offer(80)) // drop
    await checkAt(1.01, amazon, offer(null, 'out_of_stock'))
    await checkAt(1.02, bean.sources[0], offer(null)) // no price on the page

    const result = await overview()
    const bySource = new Map(result.monitored.map((s) => [s.sourceId, s]))
    expect(bySource.get(shop)).toMatchObject({
      result: 'drop',
      priceMinor: 8000,
      previousPriceMinor: 10000,
      deltaMinor: -2000,
      paidMinor: 12900,
      changedAt: new Date(START + DAY).toISOString(),
    })
    expect(bySource.get(shop)?.nextCheckAt).toEqual(expect.any(String))
    expect(bySource.get(amazon)).toMatchObject({
      result: 'out_of_stock',
      previousPriceMinor: null,
    })
    expect(bySource.get(bean.sources[0])?.result).toBe('attention')

    // The day-old baseline checks fall outside the 24 hourly buckets.
    expect(result.checksByHour).toHaveLength(24)
    expect(result.checksByHour.at(-1)).toMatchObject({
      drop: 1,
      out_of_stock: 1,
      attention: 1,
      same: 0,
    })
    const total = result.checksByHour.reduce(
      (sum, hour) =>
        sum +
        hour.drop +
        hour.increase +
        hour.out_of_stock +
        hour.same +
        hour.attention,
      0,
    )
    expect(total).toBe(3)
    expect(result.round).toMatchObject({
      failed24h: 0,
      oldestCheckAt: new Date(START + DAY).toISOString(),
    })
    expect(result.round.intervalHours).toBeGreaterThan(0)
  })

  it('reports no change once a later check moves the price again', async () => {
    const raccoon = await createKnife('Raccoon', '129.00 USD', [
      'https://shop.example/raccoon',
    ])
    const [shop] = raccoon.sources
    await checkAt(0, shop, offer(100))
    await checkAt(1, shop, offer(80))
    await checkAt(2, shop, offer(80))
    expect(
      (await overview()).monitored.find((s) => s.sourceId === shop)?.result,
    ).toBe('drop')
  })
})

describe('noise on the page', () => {
  it('shows moves under the Minimum change as no change with a hint', async () => {
    const chef = await createKnife('Chef', '129.00 USD', [
      'https://uah.example/chef',
    ])
    const bowie = await createKnife('Bowie', '200.00 USD', [
      'https://flap.example/bowie',
    ])
    const drift = await createKnife('Drift', '90.00 USD', [
      'https://drift.example/drift',
    ])
    const [uah] = chef.sources
    const [flap] = bowie.sources
    const [slow] = drift.sources
    // Currency conversion noise: 0.3% on a UAH price.
    await checkAt(0, uah, offer(5000, 'in_stock', 'UAH'))
    await checkAt(1, uah, offer(4985, 'in_stock', 'UAH'))
    // Rose in the morning, back in the afternoon.
    await checkAt(0, flap, offer(200))
    await checkAt(1.35, flap, offer(210))
    await checkAt(1.6, flap, offer(200))
    // Small steps that add up past 5%.
    await checkAt(0, slow, offer(100))
    await checkAt(1, slow, offer(98))
    await checkAt(2, slow, offer(96))
    await checkAt(3, slow, offer(94))
    await checkAt(3.5, slow, offer(93.9))

    const result = await overview()
    const bySource = new Map(result.monitored.map((s) => [s.sourceId, s]))
    expect(bySource.get(uah)).toMatchObject({
      result: 'same',
      driftPct: -0.3,
      fluctuating: false,
      deltaMinor: null,
      previousPriceMinor: null,
      // Bought in USD, priced in UAH: not comparable, but explained.
      paidMinor: null,
      paidCurrency: 'USD',
      currency: 'UAH',
    })
    expect(bySource.get(flap)).toMatchObject({
      result: 'same',
      driftPct: null,
      fluctuating: true,
      paidMinor: 20000,
      paidCurrency: 'USD',
    })
    expect(bySource.get(slow)).toMatchObject({
      result: 'drop',
      previousPriceMinor: 10000,
      deltaMinor: -610,
      changedAt: new Date(START + 3 * DAY).toISOString(),
    })

    // Only the drift crossing and the two flap moves count; the 0.3% and
    // the small steps stay in Recent but not in the lists or KPIs.
    expect(result.kpis).toMatchObject({ drops: 2, increases: 1 })
    expect(result.drops.map((event) => event.sourceId).sort()).toEqual(
      [flap, slow].sort(),
    )
    expect(result.recent.filter((event) => event.kind === 'drop')).toHaveLength(
      6,
    )
    const lastHour = result.checksByHour.at(-1)!
    expect(lastHour).toMatchObject({ drop: 0, same: 1 })

    // At 0% every move counts again, as in notifications.
    const settingsModule = await import('@/lib/settings')
    const settings = settingsModule.getSettings()
    settingsModule.saveSettings({
      ...settings,
      priceMonitoring: {
        ...settings.priceMonitoring,
        thresholds: { minPercent: 0 },
      },
    })
    const strict = new Map(
      (await overview()).monitored.map((s) => [s.sourceId, s]),
    )
    expect(strict.get(uah)).toMatchObject({ result: 'drop', deltaPct: -0.3 })
    expect(strict.get(flap)).toMatchObject({
      result: 'same',
      fluctuating: true,
    })
  })
})

describe('price history', () => {
  it('returns step lines per source for a range, starting at its left edge', async () => {
    const raccoon = await createKnife('Raccoon', '129.00 USD', [
      'https://shop.example/raccoon',
      'https://second.example/raccoon',
    ])
    const [main, second] = raccoon.sources
    await checkAt(0, main, offer(100))
    await checkAt(10, main, offer(100))
    await checkAt(20, main, offer(90))
    await checkAt(28, main, offer(90))
    await checkAt(29, second, offer(70))
    await checkAt(29.5, main, offer(85))
    // Removing a source keeps its line, labelled as removed.
    await priceWatchRoute.PUT(
      json('http://localhost/x', 'PUT', { remove: [second] }),
      { params: Promise.resolve({ id: raccoon.id }) },
    )
    vi.setSystemTime(START + 30 * DAY)

    const week = (await history(raccoon.id, '7d')).history
    expect(week.rangeStart).toBe(new Date(START + 23 * DAY).toISOString())
    expect(week.paid).toEqual({ amount: 129, currency: 'USD' })
    const mainLine = week.sources.find((s) => s.sourceId === main)!
    expect(mainLine.points.map((p) => [p.from, p.priceMinor])).toEqual([
      [new Date(START + 23 * DAY).toISOString(), 9000],
      [new Date(START + 29.5 * DAY).toISOString(), 8500],
    ])
    expect(week.sources.find((s) => s.sourceId === second)).toMatchObject({
      removed: true,
      points: [expect.objectContaining({ priceMinor: 7000 })],
    })
    expect(week.events.map((event) => event.kind)).toEqual(['drop'])

    const all = (await history(raccoon.id, 'all')).history
    expect(all.rangeStart).toBeNull()
    expect(
      all.sources
        .find((s) => s.sourceId === main)!
        .points.map((p) => [p.priceMinor, p.from, p.to]),
    ).toEqual([
      [
        10000,
        new Date(START).toISOString(),
        new Date(START + 10 * DAY).toISOString(),
      ],
      [
        9000,
        new Date(START + 20 * DAY).toISOString(),
        new Date(START + 28 * DAY).toISOString(),
      ],
      [
        8500,
        new Date(START + 29.5 * DAY).toISOString(),
        new Date(START + 29.5 * DAY).toISOString(),
      ],
    ])
    expect(all.events.map((event) => event.kind)).toEqual(['drop', 'drop'])
  })

  it('validates the request', async () => {
    const response = await historyRoute.GET(
      new Request('http://localhost/api/prices/history'),
    )
    expect(response.status).toBe(400)
    expect((await history('missing', '1m')).status).toBe(404)
  })
})

describe('ignore out of stock on the official site', () => {
  it('drops the knife’s own sold-out link from stock counts and the schedule', async () => {
    const knife = await createKnife('Raccoon', '129.00 USD', [
      'https://shop.example/raccoon',
      'https://amazon.example/raccoon',
    ])
    const [official, other] = knife.sources
    await checkAt(0, official, offer(129, 'out_of_stock'))
    await checkAt(0, other, offer(119))

    const before = await overview()
    expect(before.kpis.outOfStock).toBe(1)
    expect(
      before.monitored.find((source) => source.sourceId === official)?.result,
    ).toBe('out_of_stock')

    saveSettings({
      priceMonitoring: {
        ...DEFAULT_PRICE_MONITORING,
        ignoreOfficialOutOfStock: true,
      },
    })
    const after = await overview()
    expect(after.kpis.outOfStock).toBe(0)
    expect(after.outOfStock).toEqual([])
    const officialRow = after.monitored.find(
      (source) => source.sourceId === official,
    )
    expect(officialRow).toMatchObject({ official: true, stockIgnored: true })
    expect(officialRow?.result).not.toBe('out_of_stock')
    expect(
      after.knives.find((row) => row.knife.id === knife.id)?.outOfStock,
    ).toBe(false)

    // Not checked on schedule; the other store still is.
    const scheduled = new Map(
      readQueueCandidates(getLocalDb(), getSettings().priceMonitoring).map(
        (row) => [row.sourceId, row.scheduled],
      ),
    )
    expect(scheduled.get(official)).toBe(false)
    expect(scheduled.get(other)).toBe(true)

    // A manually added store selling out still counts.
    await checkAt(1, other, offer(119, 'out_of_stock'))
    expect((await overview()).kpis.outOfStock).toBe(1)
  })
})
