import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as knivesRoute from '@/app/api/knives/route'
import * as priceWatchRoute from '@/app/api/knives/[id]/price-watch/route'
import * as historyRoute from '@/app/api/prices/history/route'
import * as overviewRoute from '@/app/api/prices/overview/route'
import * as checksRoute from '@/app/api/prices/sources/[id]/checks/route'
import { checkPriceSource } from '@/lib/price-monitor/engine'
import { getLocalDb } from '@/lib/local-db'
import { ScrapeError } from '@/lib/scrape-errors'
import {
  buildKnifeSummaries,
  readOutOfStockSources,
  type KnifeHistory,
  type PriceOverview,
  type SourceCheckHistory,
} from '@/lib/price-monitor/insights'
import type { PriceWatchView } from '@/lib/price-monitor/shared'
import { readQueueCandidates } from '@/lib/price-monitor/store'
import type { ExtractedOffer } from '@/lib/scrape-offer'
import { getSettings, saveSettings } from '@/lib/settings'
import { DEFAULT_PRICE_MONITORING } from '@/lib/settings-shared'
import { monitorWholeCollection } from '@/tests/helpers/monitor-whole-collection'
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
  monitorWholeCollection()
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
      'https://dealer.example/raccoon',
    ])
    // A knife without a stored price is tracked but not monitored in Auto.
    const corgi = await createKnife('Corgi', '', ['https://shop.example/corgi'])

    await checkAt(0, raccoon.sources[0], offer(100))
    await checkAt(1, raccoon.sources[1], offer(95))
    await checkAt(10, raccoon.sources[0], offer(120)) // increase, outside 30 d
    await checkAt(45, raccoon.sources[0], offer(80)) // drop
    await checkAt(46, raccoon.sources[1], offer(null, 'out_of_stock'))
    await checkAt(46.5, raccoon.sources[1], offer(null, 'out_of_stock'))
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
    // The overview carries only what the page uses; no per-knife lists.
    expect(Object.keys(result).sort()).toEqual([
      'kpis',
      'monitored',
      'round',
      'windowDays',
    ])
    expect(result.kpis.knivesWithSources).toBe(2)
    const drop = result.monitored.find(
      (source) => source.sourceId === raccoon.sources[0],
    )
    expect(drop).toMatchObject({
      result: 'drop',
      knife: { id: raccoon.id, name: 'Raccoon', brand: 'Vosteed' },
      storeName: 'shop.example',
      previousPriceMinor: 12000,
      priceMinor: 8000,
      deltaPct: -33.33,
      since: null,
      retireHint: null,
    })
    // Out-of-stock rows carry when they went out of stock.
    expect(
      result.monitored.find((source) => source.sourceId === raccoon.sources[1]),
    ).toMatchObject({
      result: 'out_of_stock',
      since: new Date(START + 46 * DAY).toISOString(),
      retireHint: null,
    })
    // Corgi has no stored price, so Auto mode does not monitor it.
    expect(
      result.monitored.some((source) => source.knife.id === corgi.id),
    ).toBe(false)

    expect(result.monitored[0].knife.subtitle).toBeNull()

    // MCP reads per-knife summaries and out-of-stock sources on demand.
    const { getSettings } = await import('@/lib/settings')
    const summaries = buildKnifeSummaries(
      getLocalDb(),
      getSettings().priceMonitoring,
    )
    expect(summaries.find((k) => k.knife.id === raccoon.id)).toMatchObject({
      monitored: true,
      sources: 2,
      bestPriceMinor: 8000,
      currency: 'USD',
      paidMinor: 12900,
      outOfStock: false,
      lastChange: expect.objectContaining({ kind: 'out_of_stock' }),
    })
    expect(summaries.find((k) => k.knife.id === corgi.id)?.monitored).toBe(
      false,
    )
    expect(readOutOfStockSources(getLocalDb())).toEqual([
      expect.objectContaining({
        sourceId: raccoon.sources[1],
        since: new Date(START + 46 * DAY).toISOString(),
      }),
    ])

    // A wider window counts the earlier increase too.
    expect((await overview(60)).kpis.increases).toBe(1)
  })
})

describe('long out-of-stock and missing pages', () => {
  const HOUR = 60 * 60 * 1000
  const nextCheckAt = (sourceId: number) =>
    (
      getLocalDb()
        .prepare('SELECT next_check_at FROM price_sources WHERE id = ?')
        .get(sourceId) as { next_check_at: string }
    ).next_check_at

  async function checkEvery6h(dayOffset: number, sourceId: number) {
    vi.setSystemTime(START + dayOffset * DAY)
    mocks.browser.mockResolvedValueOnce({
      offer: offer(null, 'out_of_stock'),
      serverOffer: null,
      finalUrl: 'https://shop.example/p',
      isShopify: false,
    })
    await checkPriceSource(sourceId, {
      trigger: 'scheduled',
      intervalMs: 6 * HOUR,
    })
  }

  it('checks a page out of stock for two weeks once a day and hints Pause after 60 days', async () => {
    const raccoon = await createKnife('Raccoon', '129.00 USD', [
      'https://shop.example/raccoon',
    ])
    const [source] = raccoon.sources
    await checkAt(0, source, offer(100))
    await checkEvery6h(1, source) // out of stock from day 1
    expect(nextCheckAt(source)).toBe(
      new Date(START + DAY + 6 * HOUR).toISOString(),
    )
    await checkEvery6h(14, source) // 13 days: still the normal pace
    expect(nextCheckAt(source)).toBe(
      new Date(START + 14 * DAY + 6 * HOUR).toISOString(),
    )
    await checkEvery6h(15, source) // 14 days: once a day
    expect(nextCheckAt(source)).toBe(new Date(START + 16 * DAY).toISOString())

    let row = (await overview()).monitored[0]
    expect(row).toMatchObject({
      since: new Date(START + DAY).toISOString(),
      retireHint: null,
    })
    await checkEvery6h(61, source)
    row = (await overview()).monitored[0]
    expect(row.retireHint).toBe('long_out_of_stock')

    // Back in stock: the normal pace and no hint.
    vi.setSystemTime(START + 62 * DAY)
    await checkAt(62, source, offer(90))
    expect(nextCheckAt(source)).toBe(new Date(START + 63 * DAY).toISOString())
    row = (await overview()).monitored[0]
    expect(row).toMatchObject({ since: null, retireHint: null })
  })

  it('does not slow down when the setting is off', async () => {
    const { saveSettings, getSettings } = await import('@/lib/settings')
    const settings = getSettings().priceMonitoring
    saveSettings({
      priceMonitoring: {
        ...settings,
        schedule: { ...settings.schedule, slowOutOfStock: false },
      },
    })
    const raccoon = await createKnife('Raccoon', '129.00 USD', [
      'https://shop.example/raccoon',
    ])
    const [source] = raccoon.sources
    await checkEvery6h(0, source)
    await checkEvery6h(20, source)
    expect(nextCheckAt(source)).toBe(
      new Date(START + 20 * DAY + 6 * HOUR).toISOString(),
    )
  })

  it('hints that a page is gone after a 404', async () => {
    const raccoon = await createKnife('Raccoon', '129.00 USD', [
      'https://shop.example/raccoon',
    ])
    const [source] = raccoon.sources
    await checkAt(0, source, offer(100))
    vi.setSystemTime(START + DAY)
    mocks.browser.mockRejectedValueOnce(
      new ScrapeError('http', 'The store returned HTTP 404.'),
    )
    await checkPriceSource(source, { trigger: 'scheduled' })
    expect((await overview()).monitored[0]).toMatchObject({
      result: 'attention',
      retireHint: 'page_gone',
    })
    const watch = (
      (await (
        await priceWatchRoute.GET(new Request('http://localhost/x'), {
          params: Promise.resolve({ id: raccoon.id }),
        })
      ).json()) as { watch: PriceWatchView }
    ).watch
    expect(watch.sources[0].retireHint).toBe('page_gone')
  })
})

describe('monitoring status', () => {
  it('gives each monitored source a result and counts checks per hour', async () => {
    const raccoon = await createKnife('Raccoon', '129.00 USD', [
      'https://shop.example/raccoon',
      'https://dealer.example/raccoon',
    ])
    const bean = await createKnife('Bean', '45.00 USD', [
      'https://other.example/bean',
    ])
    const [shop, dealer] = raccoon.sources
    await checkAt(0, shop, offer(100))
    await checkAt(0.01, dealer, offer(95))
    await checkAt(1, shop, offer(80)) // drop
    await checkAt(1.01, dealer, offer(null, 'out_of_stock'))
    await checkAt(1.015, dealer, offer(null, 'out_of_stock')) // confirms it
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
    expect(bySource.get(dealer)).toMatchObject({
      result: 'out_of_stock',
      previousPriceMinor: null,
    })
    expect(bySource.get(bean.sources[0])?.result).toBe('attention')

    expect(result.round).toMatchObject({
      failed24h: 0,
      oldestCheckAt: new Date(START + DAY).toISOString(),
    })
    expect(result.round.intervalHours).toBeGreaterThan(0)
  })

  it('marks recent restocks, out-of-stock age and the last price date', async () => {
    const raccoon = await createKnife('Raccoon', '129.00 USD', [
      'https://shop.example/raccoon',
    ])
    const bean = await createKnife('Bean', '45.00 USD', [
      'https://other.example/bean',
    ])
    const [shop] = raccoon.sources
    const [other] = bean.sources
    await checkAt(0, shop, offer(100))
    await checkAt(1, shop, offer(100, 'out_of_stock'))
    await checkAt(1.5, shop, offer(100, 'out_of_stock')) // confirms it
    await checkAt(3, shop, offer(100)) // back in stock, same price
    await checkAt(3.01, shop, offer(100)) // confirms it
    await checkAt(0, other, offer(50))
    await checkAt(2, other, offer(50, 'out_of_stock'))
    await checkAt(2.5, other, offer(50, 'out_of_stock')) // confirms it

    let result = await overview()
    let bySource = new Map(result.monitored.map((s) => [s.sourceId, s]))
    expect(bySource.get(shop)).toMatchObject({
      result: 'restocked',
      restockedAt: new Date(START + 3 * DAY).toISOString(),
      since: null,
      priceSeenAt: new Date(START + 3.01 * DAY).toISOString(),
    })
    expect(bySource.get(other)).toMatchObject({
      result: 'out_of_stock',
      since: new Date(START + 2 * DAY).toISOString(),
      restockedAt: null,
    })

    // After a week the restock is old news.
    vi.setSystemTime(START + 11 * DAY)
    result = await overview()
    bySource = new Map(result.monitored.map((s) => [s.sourceId, s]))
    expect(bySource.get(shop)).toMatchObject({
      result: 'same',
      restockedAt: null,
    })
  })

  it('keeps the price date on failure', async () => {
    const raccoon = await createKnife('Raccoon', '129.00 USD', [
      'https://shop.example/raccoon',
    ])
    const [shop] = raccoon.sources
    await checkAt(0, shop, offer(100, 'out_of_stock'))
    await checkAt(0.5, shop, offer(100, 'out_of_stock')) // confirms it
    await checkAt(1, shop, offer(100))
    await checkAt(1.01, shop, offer(100)) // confirms it

    // A page without a price keeps the last price and its date.
    await checkAt(2, shop, offer(null))
    const later = (await overview()).monitored[0]
    expect(later).toMatchObject({
      result: 'attention',
      priceMinor: 10000,
      priceSeenAt: new Date(START + 1.01 * DAY).toISOString(),
    })
  })

  it('gives knives a subtitle from model number, steel and handle', async () => {
    const response = await knivesRoute.POST(
      json('http://localhost/api/knives', 'POST', {
        name: 'Drop Bear',
        brand: 'Kizer',
        handleMaterial: 'Micarta',
        specs: {
          price: '80 USD',
          modelNumber: '1101A2',
          bladeMaterial: '14C28N',
        },
        sourceUrl: 'https://shop.example/drop-bear',
      }),
    )
    const id = ((await response.json()) as { knife: { id: string } }).knife.id
    await priceWatchRoute.GET(new Request('http://localhost/x'), {
      params: Promise.resolve({ id }),
    })
    const source = (await overview()).monitored.find((s) => s.knife.id === id)
    expect(source?.knife.subtitle).toBe('1101A2 · 14C28N · Micarta')
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
    // the small steps stay in history but not in the KPIs.
    expect(result.kpis).toMatchObject({ drops: 2, increases: 1 })

    // At 0% every move counts again, as in notifications.
    const settingsModule = await import('@/lib/settings')
    const settings = settingsModule.getSettings()
    settingsModule.saveSettings({
      ...settings,
      priceMonitoring: {
        ...settings.priceMonitoring,
        thresholds: { minPercent: 0, minAmount: 0, allTimeLow: false },
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
    // The second store's first reading undercut the main store: a drop of
    // the knife, measured against that store.
    expect(
      week.events.map((event) => [event.kind, event.previousStoreName]),
    ).toEqual([
      ['drop', null],
      ['drop', 'shop.example'],
    ])

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
    expect(all.events.map((event) => event.kind)).toEqual([
      'drop',
      'drop',
      'drop',
    ])
  })

  it('validates the request', async () => {
    const response = await historyRoute.GET(
      new Request('http://localhost/api/prices/history'),
    )
    expect(response.status).toBe(400)
    expect((await history('missing', '1m')).status).toBe(404)
  })

  it('fits the chart to the first reading and summarizes all history', async () => {
    const raccoon = await createKnife('Raccoon', '129.00 USD', [
      'https://shop.example/raccoon',
      'https://second.example/raccoon',
    ])
    const [main, second] = raccoon.sources
    await checkAt(0, main, offer(100))
    await checkAt(2, main, offer(140)) // increase: highest
    await checkAt(4, main, offer(null, 'out_of_stock'))
    await checkAt(4.5, main, offer(null, 'out_of_stock')) // confirms it
    await checkAt(6, main, offer(90, 'limited')) // back, lowest
    await checkAt(6.5, main, offer(90, 'limited')) // confirms it
    await checkAt(8, main, offer(110))
    await checkAt(8.5, second, offer(95, 'preorder'))
    vi.setSystemTime(START + 10 * DAY)

    // Three months reach back before tracking began on day 0.
    const quarter = (await history(raccoon.id, '3m')).history
    expect(quarter.rangeStart).toBe(new Date(START - 80 * DAY).toISOString())
    expect(quarter.chartStart).toBe(new Date(START).toISOString())
    expect(quarter.stats).toEqual({
      currency: 'USD',
      lowest: expect.objectContaining({
        priceMinor: 9000,
        at: new Date(START + 6 * DAY).toISOString(),
        sourceId: main,
        storeName: 'shop.example',
      }),
      highest: expect.objectContaining({ priceMinor: 14000 }),
      trackingSince: new Date(START).toISOString(),
      bestNow: {
        priceMinor: 9500,
        sourceId: second,
        storeName: 'second.example',
        url: 'https://second.example/raccoon',
        availability: 'preorder',
      },
      paidMinor: 12900,
      gapMinor: -3400,
      gapPct: -26.4,
    })
    expect(quarter.events.map((event) => event.kind)).toEqual([
      'drop', // the second store, first read below the main store's 110
      'increase',
      'drop',
      'back_in_stock',
      'out_of_stock',
      'increase',
    ])

    // A week inside the history starts at the range, but the stats still
    // cover everything.
    const week = (await history(raccoon.id, '7d')).history
    expect(week.chartStart).toBe(week.rangeStart)
    expect(week.stats.highest?.priceMinor).toBe(14000)
    expect(
      week.sources.every((source) => source.unconfirmed.length === 0),
    ).toBe(true)
  })

  it('keeps AI-unconfirmed readings out of the line', async () => {
    const raccoon = await createKnife('Raccoon', '129.00 USD', [
      'https://shop.example/raccoon',
    ])
    const [main] = raccoon.sources
    await checkAt(0, main, offer(100))
    vi.setSystemTime(START + 2 * DAY)
    getLocalDb()
      .prepare(
        `INSERT INTO price_snapshots
          (knife_id, source_id, price_minor, currency, availability,
           extraction_status, extraction_method, observed_at, last_seen_at,
           ai_review)
         VALUES (?, ?, 1000, 'USD', 'in_stock', 'ok', 'jsonld', ?, ?,
                 'unconfirmed')`,
      )
      .run(
        raccoon.id,
        main,
        new Date(START + DAY).toISOString(),
        new Date(START + DAY).toISOString(),
      )
    const all = (await history(raccoon.id, 'all')).history
    const line = all.sources.find((source) => source.sourceId === main)!
    expect(line.points.map((point) => point.priceMinor)).toEqual([10000])
    expect(line.unconfirmed).toEqual([
      expect.objectContaining({ priceMinor: 1000, currency: 'USD' }),
    ])
    expect(all.stats.lowest?.priceMinor).toBe(10000)
  })
})

describe('source check history', () => {
  async function checks(id: string | number) {
    const response = await checksRoute.GET(
      new Request(`http://localhost/api/prices/sources/${id}/checks`),
      { params: Promise.resolve({ id: String(id) }) },
    )
    return {
      status: response.status,
      body: (await response.json()) as SourceCheckHistory & { error?: string },
    }
  }

  it('lists recent checks with their readings, newest first', async () => {
    const raccoon = await createKnife('Raccoon', '129.00 USD', [
      'https://shop.example/raccoon',
    ])
    const [main] = raccoon.sources
    await checkAt(0, main, offer(100))
    await checkAt(1, main, offer(100)) // confirms the same reading
    await checkAt(2, main, offer(80, 'limited'))
    const database = getLocalDb()
    database
      .prepare(
        `UPDATE price_check_log SET solver_steps = ? WHERE id =
           (SELECT MAX(id) FROM price_check_log)`,
      )
      .run(
        JSON.stringify([
          { action: 'click', detail: 'Accept cookies', result: 'clicked' },
          { action: 'read', detail: '', result: 'price read', html: '<p>' },
        ]),
      )

    const { status, body } = await checks(main)
    expect(status).toBe(200)
    expect(body.source).toMatchObject({
      id: main,
      knifeId: raccoon.id,
      storeName: 'shop.example',
      removed: false,
    })
    expect(body.checks).toHaveLength(3)
    expect(body.checks.map((check) => check.reading?.priceMinor)).toEqual([
      8000, 10000, 10000,
    ])
    expect(body.checks[0]).toMatchObject({
      trigger: 'manual',
      outcome: 'ok',
      method: 'browser',
      attempt: 1,
      reading: {
        currency: 'USD',
        availability: 'limited',
        aiReview: null,
      },
      solverSteps: [
        { action: 'click', detail: 'Accept cookies', result: 'clicked' },
        { action: 'read', detail: '', result: 'price read' },
      ],
    })
    expect(typeof body.checks[0].durationMs).toBe('number')
  })

  it('marks readings AI could not confirm', async () => {
    const raccoon = await createKnife('Raccoon', '129.00 USD', [
      'https://shop.example/raccoon',
    ])
    const [main] = raccoon.sources
    await checkAt(0, main, offer(100))
    const database = getLocalDb()
    const at = new Date(START + DAY).toISOString()
    const logId = database
      .prepare(
        `INSERT INTO price_check_log
          (lane_key, trigger, source_id, knife_id, started_at, duration_ms,
           outcome, method, error_code, error_message)
         VALUES ('shop.example', 'scheduled', ?, ?, ?, 900, 'ok', 'http',
                 'ai_unconfirmed', 'AI could not confirm this price')`,
      )
      .run(main, raccoon.id, at).lastInsertRowid
    database
      .prepare(
        `INSERT INTO price_snapshots
          (knife_id, source_id, price_minor, currency, availability,
           extraction_status, extraction_method, observed_at, last_seen_at,
           check_log_id, ai_review)
         VALUES (?, ?, 1000, 'USD', 'in_stock', 'ok', 'jsonld', ?, ?, ?,
                 'unconfirmed')`,
      )
      .run(raccoon.id, main, at, at, logId)

    const { body } = await checks(main)
    expect(body.checks[0]).toMatchObject({
      errorCode: 'ai_unconfirmed',
      reading: { priceMinor: 1000, aiReview: 'unconfirmed' },
    })
  })

  it('validates the source id', async () => {
    expect((await checks('abc')).status).toBe(400)
    expect((await checks(9999)).status).toBe(404)
  })
})

describe('ignore out of stock on the official site', () => {
  it('drops the knife’s own sold-out link from stock counts and the schedule', async () => {
    const knife = await createKnife('Raccoon', '129.00 USD', [
      'https://shop.example/raccoon',
      'https://dealer.example/raccoon',
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
        scope: { kind: 'all', knifeIds: [] },
        ignoreOfficialOutOfStock: true,
      },
    })
    const after = await overview()
    expect(after.kpis.outOfStock).toBe(0)
    const settings = getSettings().priceMonitoring
    expect(readOutOfStockSources(getLocalDb(), settings)).toEqual([])
    const officialRow = after.monitored.find(
      (source) => source.sourceId === official,
    )
    expect(officialRow).toMatchObject({ official: true, stockIgnored: true })
    expect(officialRow?.result).not.toBe('out_of_stock')
    expect(
      buildKnifeSummaries(getLocalDb(), settings).find(
        (row) => row.knife.id === knife.id,
      )?.outOfStock,
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
