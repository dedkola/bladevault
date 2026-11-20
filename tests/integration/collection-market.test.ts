import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as knivesRoute from '@/app/api/knives/route'
import * as priceWatchRoute from '@/app/api/knives/[id]/price-watch/route'
import * as marketRoute from '@/app/api/prices/market/route'
import { checkPriceSource } from '@/lib/price-monitor/engine'
import {
  toMarketSummaryMap,
  type KnifeMarketSummary,
} from '@/lib/market-status'
import type { PriceWatchView } from '@/lib/price-monitor/shared'
import type { ExtractedOffer } from '@/lib/scrape-offer'
import type { Knife } from '@/lib/data'
import { matchesCollection } from '@/lib/smart-collections'
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

async function createKnife(
  name: string,
  price: string,
  urls: string[],
  extra: Record<string, unknown> = {},
) {
  const response = await knivesRoute.POST(
    json('http://localhost/api/knives', 'POST', {
      name,
      brand: 'Vosteed',
      specs: { price },
      sourceUrl: urls[0] ?? '',
      ...extra,
    }),
  )
  const knife = ((await response.json()) as { knife: Knife }).knife
  const params = { params: Promise.resolve({ id: knife.id }) }
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
  return { knife, sources: watch.sources.map((source) => source.id) }
}

function offer(
  amount: number | null,
  availability: ExtractedOffer['availability'] = 'in_stock',
): ExtractedOffer {
  return { amount, currency: 'USD', availability, method: 'jsonld' }
}

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

async function market(dayOffset: number) {
  vi.setSystemTime(START + dayOffset * DAY)
  const response = await marketRoute.GET(
    new Request('http://localhost/api/prices/market'),
  )
  expect(response.status).toBe(200)
  return toMarketSummaryMap(
    ((await response.json()) as { summaries: unknown }).summaries,
  )
}

const at = (dayOffset: number) =>
  new Date(START + dayOffset * DAY).toISOString()

describe('collection market summaries', () => {
  it('summarizes price, drops, restocks, stock and purchase price per knife', async () => {
    const raccoon = await createKnife('Raccoon', '129.00 USD', [
      'https://shop.example/raccoon',
      'https://amazon.example/raccoon',
    ])
    const corgi = await createKnife('Corgi', '', ['https://shop.example/corgi'])
    const kiwi = await createKnife('Kiwi', '50.00 USD', [
      'https://shop.example/kiwi',
    ])
    const mutt = await createKnife('Mutt', '70.00 USD', [
      'https://shop.example/mutt',
    ])
    const bare = await createKnife('Bare', '20.00 USD', [])

    await checkAt(0, raccoon.sources[0], offer(100))
    await checkAt(1, raccoon.sources[1], offer(95))
    await checkAt(40, kiwi.sources[0], offer(55))
    await checkAt(41, kiwi.sources[0], offer(null, 'out_of_stock'))
    await checkAt(44, mutt.sources[0], offer(null, 'out_of_stock'))
    await checkAt(45, raccoon.sources[0], offer(80)) // drop of 20%
    await checkAt(45, kiwi.sources[0], offer(60)) // back in stock
    await checkAt(46, raccoon.sources[1], offer(null, 'out_of_stock'))
    await checkAt(47, corgi.sources[0], offer(40))

    const summaries = await market(47)
    expect(summaries.has(bare.knife.id)).toBe(false)
    expect(summaries.get(raccoon.knife.id)).toMatchObject({
      monitored: true,
      sources: 2,
      bestPriceMinor: 8000,
      currency: 'USD',
      paidMinor: 12900,
      outOfStock: false,
      droppedAt: at(45),
      restockedAt: null,
    } satisfies Partial<KnifeMarketSummary>)
    expect(summaries.get(raccoon.knife.id)?.dropPct).toBeCloseTo(-20)
    // No stored price: Auto mode does not monitor it, but it has a price.
    expect(summaries.get(corgi.knife.id)).toMatchObject({
      monitored: false,
      bestPriceMinor: 4000,
      paidMinor: null,
    })
    expect(summaries.get(kiwi.knife.id)).toMatchObject({
      bestPriceMinor: 6000,
      paidMinor: 5000,
      outOfStock: false,
      droppedAt: null,
      restockedAt: at(45),
    })
    expect(summaries.get(mutt.knife.id)).toMatchObject({
      bestPriceMinor: null,
      outOfStock: true,
      outOfStockSince: at(44),
      droppedAt: null,
      restockedAt: null,
    })

    // Collection filters read the same map.
    const knives = [raccoon, corgi, kiwi, mutt, bare].map((item) => item.knife)
    const names = (query: string) =>
      knives
        .filter((knife) =>
          matchesCollection(
            knife,
            new URLSearchParams(query),
            undefined,
            summaries,
          ),
        )
        .map((knife) => knife.name)
    expect(names('market=dropped')).toEqual(['Raccoon'])
    expect(names('market=restocked')).toEqual(['Kiwi'])
    expect(names('market=out_of_stock')).toEqual(['Mutt'])
    expect(names('market=below_paid')).toEqual(['Raccoon'])
    expect(names('market=monitored')).toEqual(['Raccoon', 'Kiwi', 'Mutt'])
    expect(names('market=not_monitored')).toEqual(['Corgi', 'Bare'])
    expect(names('market=dropped&market=restocked')).toEqual([
      'Raccoon',
      'Kiwi',
    ])
    expect(names('market=dropped&brand=Other')).toEqual([])
    // Without market data the condition is ignored, as in the static app.
    expect(
      knives.filter((knife) =>
        matchesCollection(knife, new URLSearchParams('market=dropped')),
      ),
    ).toHaveLength(5)

    // Restocks and drops age out of their windows.
    const later = await market(56)
    expect(later.get(kiwi.knife.id)?.restockedAt).toBeNull()
    expect(later.get(raccoon.knife.id)?.droppedAt).toBe(at(45))
    const muchLater = await market(80)
    expect(muchLater.get(raccoon.knife.id)?.droppedAt).toBeNull()
  })

  it('drops a drop that a later increase undid, and skips paused links', async () => {
    const raccoon = await createKnife('Raccoon', '129.00 USD', [
      'https://shop.example/raccoon',
    ])
    await checkAt(0, raccoon.sources[0], offer(100))
    await checkAt(2, raccoon.sources[0], offer(90))
    expect((await market(2)).get(raccoon.knife.id)?.droppedAt).toBe(at(2))
    await checkAt(3, raccoon.sources[0], offer(110))
    expect((await market(3)).get(raccoon.knife.id)).toMatchObject({
      droppedAt: null,
      bestPriceMinor: 11000,
    })

    await priceWatchRoute.PUT(
      json('http://localhost/x', 'PUT', {
        update: [{ id: raccoon.sources[0], enabled: false }],
      }),
      { params: Promise.resolve({ id: raccoon.knife.id }) },
    )
    expect((await market(3)).has(raccoon.knife.id)).toBe(false)
  })
})
