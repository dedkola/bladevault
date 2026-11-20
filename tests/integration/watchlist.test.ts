import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as compareRoute from '@/app/api/comparisons/route'
import * as knivesRoute from '@/app/api/knives/route'
import * as priceWatchRoute from '@/app/api/knives/[id]/price-watch/route'
import * as notificationsRoute from '@/app/api/price-notifications/route'
import * as overviewRoute from '@/app/api/prices/overview/route'
import * as watchlistRoute from '@/app/api/watchlist/route'
import * as watchlistItemRoute from '@/app/api/watchlist/[id]/route'
import * as boughtRoute from '@/app/api/watchlist/[id]/bought/route'
import { getLocalDb } from '@/lib/local-db'
import { checkPriceSource } from '@/lib/price-monitor/engine'
import type { PriceOverview } from '@/lib/price-monitor/insights'
import type { PriceNotificationView } from '@/lib/price-monitor/notifications'
import type { PriceWatchView } from '@/lib/price-monitor/shared'
import type { Watchlist } from '@/lib/price-monitor/watchlist-shared'
import type { ExtractedOffer } from '@/lib/scrape-offer'
import { getSettings, saveSettings } from '@/lib/settings'
import { getStorage } from '@/lib/storage'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

const mocks = vi.hoisted(() => ({
  browser: vi.fn(),
  http: vi.fn(),
  requestPriceChecks: vi.fn(),
}))

vi.mock('@/lib/price-monitor/fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/price-monitor/fetch')>()),
  checkViaBrowser: mocks.browser,
  checkViaHttp: mocks.http,
}))
vi.mock('@/lib/price-monitor/worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/price-monitor/worker')>()),
  // Queue Check now without starting a background worker.
  requestPriceChecks: mocks.requestPriceChecks,
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
  vi.resetAllMocks()
  mocks.requestPriceChecks.mockImplementation(async (ids: number[]) => ids)
})
afterEach(async () => {
  await vault?.cleanup()
  vault = null
})

const WANTED_URL = 'https://shop.example/products/bugout'
const OWNED_URL = 'https://shop.example/products/raccoon'

function json(url: string, method: string, body: unknown) {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })

function offer(
  amount: number | null,
  availability: ExtractedOffer['availability'] = 'in_stock',
): ExtractedOffer {
  return { amount, currency: 'USD', availability, method: 'jsonld' }
}

async function addWanted(body: Record<string, unknown> = {}) {
  const response = await watchlistRoute.POST(
    json('http://localhost/api/watchlist', 'POST', {
      name: 'Bugout',
      brand: 'Benchmade',
      sourceUrl: WANTED_URL,
      specs: { price: '150.00 USD', bladeLength: '3.24 in' },
      ...body,
    }),
  )
  expect(response.status).toBe(201)
  return ((await response.json()) as { knife: { id: string } }).knife.id
}

async function addOwned() {
  const response = await knivesRoute.POST(
    json('http://localhost/api/knives', 'POST', {
      name: 'Raccoon',
      brand: 'Vosteed',
      specs: { price: '129.00 USD' },
      sourceUrl: OWNED_URL,
    }),
  )
  return ((await response.json()) as { knife: { id: string } }).knife.id
}

async function watchFor(knifeId: string) {
  const response = await priceWatchRoute.GET(
    new Request(`http://localhost/api/knives/${knifeId}/price-watch`),
    params(knifeId),
  )
  return ((await response.json()) as { watch: PriceWatchView }).watch
}

async function check(
  sourceId: number,
  url: string,
  ...readings: ExtractedOffer[]
) {
  for (const reading of readings) {
    mocks.browser.mockResolvedValueOnce({
      offer: reading,
      serverOffer: null,
      finalUrl: url,
      isShopify: false,
    })
    await checkPriceSource(sourceId, { trigger: 'manual' })
  }
}

async function getWatchlist() {
  const response = await watchlistRoute.GET(
    new Request('http://localhost/api/watchlist'),
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { watchlist: Watchlist }).watchlist
}

async function setTarget(knifeId: string, target: unknown) {
  return watchlistItemRoute.PATCH(
    json(`http://localhost/api/watchlist/${knifeId}`, 'PATCH', { target }),
    params(knifeId),
  )
}

async function collectionIds() {
  const response = await knivesRoute.GET(
    new Request('http://localhost/api/knives'),
  )
  return ((await response.json()) as { knives: Array<{ id: string }> }).knives
    .map((knife) => knife.id)
    .sort()
}

function notificationRows() {
  return getLocalDb()
    .prepare(
      `SELECT kind, occurrences, resolved_at IS NOT NULL AS resolved
       FROM price_notifications ORDER BY id`,
    )
    .all()
}

describe('watchlist', () => {
  it('keeps wanted knives out of the collection while Price Drops monitors them', async () => {
    const ownedId = await addOwned()
    const wantedId = await addWanted({
      target: { amount: '120', currency: 'usd' },
    })

    // The collection, its activity and comparisons leave it out.
    expect(await collectionIds()).toEqual([ownedId])
    const storage = getStorage()
    expect((await storage.getWantedKnives()).map((knife) => knife.id)).toEqual([
      wantedId,
    ])
    expect(
      (await storage.getKnifeActivity()).map((event) => event.knifeId),
    ).toEqual([ownedId])
    const compare = await compareRoute.POST(
      json('http://localhost/api/comparisons', 'POST', {
        action: 'create',
        name: 'Both',
        ids: [ownedId, wantedId],
      }),
    )
    expect(compare.status).toBe(404)

    // It is monitored like any knife, without a purchase price, and its
    // product link was queued for a first check.
    const wanted = await storage.getKnifeById(wantedId)
    expect(wanted).toMatchObject({ wanted: true, sold: false })
    expect(wanted?.specs.price).toBe('')
    expect(wanted?.specs.bladeLength).toBe('3.24 in')
    const watch = await watchFor(wantedId)
    expect(watch.eligibility).toEqual({
      monitored: true,
      reason: 'monitored_auto',
    })
    expect(mocks.requestPriceChecks).toHaveBeenCalledWith([watch.sources[0].id])

    const ownedSource = (await watchFor(ownedId)).sources[0].id
    await check(watch.sources[0].id, WANTED_URL, offer(135))
    await check(ownedSource, OWNED_URL, offer(120))

    const list = await getWatchlist()
    expect(list.items).toHaveLength(1)
    expect(list.items[0]).toMatchObject({
      knife: { id: wantedId, name: 'Bugout', wanted: true },
      target: { minor: 12000, currency: 'USD' },
      monitored: true,
      sources: 1,
      best: { priceMinor: 13500, currency: 'USD', storeName: 'shop.example' },
      gapMinor: 1500,
      atTarget: false,
      stock: 'in_stock',
    })

    // The collection overview of Price Drops covers owned knives only.
    const overview = (
      (await (
        await overviewRoute.GET(
          new Request('http://localhost/api/prices/overview'),
        )
      ).json()) as { overview: PriceOverview }
    ).overview
    expect(overview.kpis.monitoredKnives).toBe(1)
    expect(overview.monitored.map((source) => source.knife.id)).toEqual([
      ownedId,
    ])
  })

  it('notifies when a price reaches the target and when a wanted knife is back in stock', async () => {
    // Back in stock is off in settings; a wanted knife notifies anyway.
    const settings = getSettings()
    saveSettings({
      ...settings,
      priceMonitoring: {
        ...settings.priceMonitoring,
        notify: { ...settings.priceMonitoring.notify, backInStock: false },
      },
    })
    const knifeId = await addWanted({
      target: { amount: 90, currency: 'USD' },
    })
    const sourceId = (await watchFor(knifeId)).sources[0].id

    await check(sourceId, WANTED_URL, offer(100))
    expect(notificationRows()).toEqual([])

    // 100 → 85 meets the target; the target alert stands in for the drop.
    await check(sourceId, WANTED_URL, offer(85))
    expect(notificationRows()).toEqual([
      { kind: 'target_reached', occurrences: 1, resolved: 0 },
    ])

    // Staying at target does not notify again.
    await check(sourceId, WANTED_URL, offer(85), offer(84.5))
    expect(notificationRows()).toEqual([
      { kind: 'target_reached', occurrences: 1, resolved: 0 },
    ])

    // Selling out closes the target; coming back at target notifies both.
    await check(sourceId, WANTED_URL, offer(null, 'out_of_stock'), offer(84.5))
    expect(notificationRows()).toEqual([
      { kind: 'target_reached', occurrences: 1, resolved: 1 },
      { kind: 'back_in_stock', occurrences: 1, resolved: 0 },
      { kind: 'target_reached', occurrences: 1, resolved: 0 },
    ])

    const response = await notificationsRoute.GET(
      new Request('http://localhost/api/price-notifications'),
    )
    const views = (
      (await response.json()) as { notifications: PriceNotificationView[] }
    ).notifications
    const target = views.find(
      (row) => row.kind === 'target_reached' && !row.resolvedAt,
    )!
    expect(target.event).toMatchObject({
      type: 'target',
      kind: 'target_reached',
      knife: { id: knifeId, name: 'Bugout', wanted: true },
      storeName: 'shop.example',
      sourceUrl: WANTED_URL,
      priceMinor: 8450,
      currency: 'USD',
    })

    // Raising the price above the target resolves it.
    await check(sourceId, WANTED_URL, offer(95))
    expect(notificationRows().at(-1)).toEqual({
      kind: 'target_reached',
      occurrences: 1,
      resolved: 1,
    })
  })

  it('applies a new target to the latest reading right away', async () => {
    const knifeId = await addWanted()
    const sourceId = (await watchFor(knifeId)).sources[0].id
    await check(sourceId, WANTED_URL, offer(100))

    expect(
      (await setTarget(knifeId, { amount: 99, currency: 'EUR' })).status,
    ).toBe(200)
    // Another currency says nothing either way.
    expect(notificationRows()).toEqual([])

    await setTarget(knifeId, { amount: 110, currency: 'USD' })
    expect(notificationRows()).toEqual([
      { kind: 'target_reached', occurrences: 1, resolved: 0 },
    ])
    expect((await getWatchlist()).items[0]).toMatchObject({
      gapMinor: -1000,
      atTarget: true,
    })

    // Clearing the target closes it.
    await setTarget(knifeId, null)
    expect(notificationRows()).toEqual([
      { kind: 'target_reached', occurrences: 1, resolved: 1 },
    ])

    expect(
      (await setTarget(knifeId, { amount: -1, currency: 'USD' })).status,
    ).toBe(400)
    const ownedId = await addOwned()
    expect(
      (await setTarget(ownedId, { amount: 1, currency: 'USD' })).status,
    ).toBe(400)
  })

  it('moves a bought knife into the collection with its price history', async () => {
    const knifeId = await addWanted({ target: { amount: 90, currency: 'USD' } })
    const sourceId = (await watchFor(knifeId)).sources[0].id
    await check(sourceId, WANTED_URL, offer(100), offer(85))
    const snapshots = () =>
      getLocalDb()
        .prepare('SELECT COUNT(*) AS n FROM price_snapshots WHERE knife_id = ?')
        .get(knifeId)

    const response = await boughtRoute.POST(
      json(`http://localhost/api/watchlist/${knifeId}/bought`, 'POST', {
        price: '85.00 USD',
      }),
      params(knifeId),
    )
    expect(response.status).toBe(200)

    expect(await collectionIds()).toEqual([knifeId])
    expect((await getWatchlist()).items).toEqual([])
    const knife = await getStorage().getKnifeById(knifeId)
    expect(knife?.wanted).toBeUndefined()
    expect(knife?.specs.price).toBe('85.00 USD')
    expect(snapshots()).toEqual({ n: 2 })
    expect((await watchFor(knifeId)).sources.map((s) => s.id)).toEqual([
      sourceId,
    ])
    // The target alert is closed.
    expect(notificationRows()).toEqual([
      { kind: 'target_reached', occurrences: 1, resolved: 1 },
    ])
    expect(
      (await getStorage().getKnifeActivity()).map((event) => [
        event.knifeId,
        event.type,
      ]),
    ).toEqual([[knifeId, 'created']])

    const again = await boughtRoute.POST(
      json(`http://localhost/api/watchlist/${knifeId}/bought`, 'POST', {}),
      params(knifeId),
    )
    expect(again.status).toBe(409)
  })
})
