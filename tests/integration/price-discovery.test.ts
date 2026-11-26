import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as knivesRoute from '@/app/api/knives/route'
import * as priceWatchRoute from '@/app/api/knives/[id]/price-watch/route'
import * as discoveryRoute from '@/app/api/prices/discovery/route'
import { getLocalDb } from '@/lib/local-db'
import { AiClientError } from '@/lib/price-monitor/ai-client'
import {
  discoverKnife,
  nextDiscoveryKnife,
  type BrowseInput,
  type DiscoveryDeps,
} from '@/lib/price-monitor/discovery'
import type { PriceWatchView } from '@/lib/price-monitor/shared'
import { getPriceMonitorWorker } from '@/lib/price-monitor/worker'
import { networkBlockError } from '@/lib/scrape'
import { ScrapeError } from '@/lib/scrape-errors'
import { getSettings, saveSettings } from '@/lib/settings'
import { DEFAULT_PRICE_MONITORING } from '@/lib/settings-shared'
import { monitorWholeCollection } from '@/tests/helpers/monitor-whole-collection'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault | null = null

beforeEach(async () => {
  vault = await createTempVault()
  monitorWholeCollection()
})
afterEach(async () => {
  await getPriceMonitorWorker().stop()
  await vault?.cleanup()
  vault = null
})

const SEARCH_HTML = `<main>
  <div class="card"><a href="/item--Leather-Sheath-for-Para-3--11111">Leather Sheath for Para 3</a>
    <span>$29.95</span></div>
  <div class="card"><a href="/item--Spyderco-Para-3-Folding-Knife--106189">Spyderco Para 3 Folding Knife CTS BD1N</a>
    <span>$124.95</span></div>
</main>`

/** Blade HQ's search page when nothing matches: no product links. */
const EMPTY_SEARCH_HTML =
  '<main><p>No results found for your search.</p><a href="/cat--Knives--1">Knives</a></main>'

const PRODUCT_URL =
  'https://www.bladehq.com/item--Spyderco-Para-3-Folding-Knife--106189'

function productHtml(
  title = 'Spyderco Para 3 Folding Knife CTS BD1N',
  description = '2.95 inch CTS BD1N blade',
) {
  return `<html><head><script type="application/ld+json">${JSON.stringify({
    '@type': 'Product',
    name: title,
    description,
  })}</script></head><body><h1>${title}</h1></body></html>`
}

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/scrape/${name}`, import.meta.url), 'utf8')

function enableOtherStores(
  ai = true,
  stores = {
    bladehq: true,
    smkw: false,
    dlttrading: false,
    knifejoy: false,
    northwestknives: false,
    amazon: false,
  },
) {
  saveSettings({
    priceMonitoring: {
      ...DEFAULT_PRICE_MONITORING,
      scope: { kind: 'all', knifeIds: [] },
      ai: {
        ...DEFAULT_PRICE_MONITORING.ai,
        enabled: ai,
        baseUrl: 'http://localhost:11434/v1',
        model: 'test-model',
      },
      otherStores: { enabled: true, stores },
    },
  })
}

async function createKnife(body: Record<string, unknown>) {
  const response = await knivesRoute.POST(
    new Request('http://localhost/api/knives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: 'Spyderco', name: 'Para 3', ...body }),
    }),
  )
  return ((await response.json()) as { knife: { id: string } }).knife.id
}

async function getWatch(knifeId: string) {
  const response = await priceWatchRoute.GET(
    new Request(`http://localhost/api/knives/${knifeId}/price-watch`),
    { params: Promise.resolve({ id: knifeId }) },
  )
  return ((await response.json()) as { watch: PriceWatchView }).watch
}

function deps(overrides: Partial<DiscoveryDeps> = {}): Partial<DiscoveryDeps> {
  return {
    readKey: async () => null,
    fetchPage: vi.fn(async (url: string) => ({
      html: url.includes('?search=') ? SEARCH_HTML : productHtml(),
      finalUrl: url,
    })),
    match: vi.fn(async ({ candidates }) => ({
      accepted: true,
      variants: [],
      confidence: 0.9,
      reason: 'Same model and steel.',
      candidate: candidates[1],
    })),
    verify: vi.fn(async () => ({
      accepted: true,
      confidence: 0.95,
      reason: 'The page sells the Para 3 in BD1N.',
      kind: null,
      sameModel: false,
    })),
    // Never a real browser in tests: AI browsing finds nothing by default.
    browse: vi.fn(async () => ({ page: null, note: null })),
    ...overrides,
  }
}

describe('Other stores discovery', () => {
  it('searches again without the model number when the first search finds nothing', async () => {
    enableOtherStores()
    const knifeId = await createKnife({
      specs: { price: '$150', modelNumber: 'C223GP' },
    })
    const fetchPage = vi.fn(async (url: string) => ({
      html: url.includes('C223GP')
        ? EMPTY_SEARCH_HTML
        : url.includes('?search=')
          ? SEARCH_HTML
          : // The title leaves the code out; the details show it.
            productHtml(undefined, '2.95 inch CTS BD1N blade. Model: C223GP'),
      finalUrl: url,
    }))
    const run = deps({ fetchPage })
    const summary = await discoverKnife(knifeId, { deps: run })

    expect(summary).toMatchObject({ status: 'done', result: 'found' })
    expect(fetchPage.mock.calls.map(([url]) => url)).toEqual([
      'https://www.bladehq.com/?search=Spyderco+Para+3+C223GP',
      'https://www.bladehq.com/?search=Spyderco+Para+3',
      PRODUCT_URL,
    ])
  })

  it('records "not found" when the store’s result lists are empty', async () => {
    enableOtherStores()
    const knifeId = await createKnife({
      specs: { price: '$150', modelNumber: 'C223GP' },
    })
    const run = deps({
      fetchPage: vi.fn(async (url: string) => ({
        html: EMPTY_SEARCH_HTML,
        finalUrl: url,
      })),
    })
    expect(await discoverKnife(knifeId, { deps: run })).toMatchObject({
      status: 'done',
      result: 'not_found',
      laneOutcome: 'success',
    })
    expect(run.match).not.toHaveBeenCalled()
    const row = getLocalDb()
      .prepare('SELECT detail FROM price_discovery WHERE knife_id = ?')
      .get(knifeId) as { detail: string }
    expect(row.detail).toBe(
      'Blade HQ had no results for “Spyderco Para 3 C223GP” or “Spyderco Para 3”.',
    )
  })

  it('ends a search whose page never loads when its time budget runs out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      enableOtherStores()
      const knifeId = await createKnife({ specs: { price: '$150' } })
      const pending = discoverKnife(knifeId, {
        deps: deps({ fetchPage: () => new Promise(() => {}) }),
      })
      await vi.advanceTimersByTimeAsync(240_000)
      expect(await pending).toMatchObject({
        status: 'done',
        result: 'failed',
        laneOutcome: 'neutral',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('finds the knife on SMKW too, from its result cards and SKU', async () => {
    enableOtherStores(true, {
      bladehq: true,
      smkw: true,
      dlttrading: false,
      knifejoy: false,
      northwestknives: false,
      amazon: false,
    })
    const knifeId = await createKnife({
      specs: { price: '$150', modelNumber: 'C223GP' },
    })
    const smkwUrl = 'https://smkw.com/spyderco-para-3-folding-knife-black-g-10'
    const fetchPage = vi.fn(
      async (url: string, _signal: AbortSignal, _laneKey: string) => ({
        html: url.startsWith('https://smkw.com/shop/')
          ? fixture('smkw-search-para-3.html')
          : fixture('smkw-item-para-3-c223gbk.html'),
        finalUrl: url,
      }),
    )
    const run = deps({
      fetchPage,
      match: vi.fn(async ({ candidates }) => ({
        accepted: true,
        variants: [],
        confidence: 0.9,
        reason: 'Same model.',
        candidate: candidates[0],
      })),
    })
    const summary = await discoverKnife(knifeId, { deps: run, store: 'smkw' })

    expect(summary).toMatchObject({ status: 'done', result: 'found' })
    expect(fetchPage.mock.calls.map(([url, , lane]) => [url, lane])).toEqual([
      [
        'https://smkw.com/shop/?search_query=Spyderco+Para+3+C223GP',
        'smkw.com',
      ],
      [smkwUrl, 'smkw.com'],
    ])
    const watch = await getWatch(knifeId)
    expect(watch.sources).toEqual([
      expect.objectContaining({
        url: smkwUrl,
        laneKey: 'smkw.com',
        storeName: 'smkw.com',
        foundByAi: true,
      }),
    ])
    // Found at SMKW; Blade HQ still searches for it.
    const settings = getSettings().priceMonitoring
    expect(nextDiscoveryKnife(settings, Date.now(), 'smkw')).toBeNull()
    expect(nextDiscoveryKnife(settings, Date.now(), 'bladehq')).toBe(knifeId)
  })

  it('finds the knife on Northwest Knives through Shopify JSON, as a Shopify source', async () => {
    enableOtherStores(true, {
      bladehq: false,
      smkw: false,
      dlttrading: false,
      knifejoy: false,
      northwestknives: true,
      amazon: false,
    })
    const knifeId = await createKnife({
      specs: { price: '$212', modelNumber: 'C223GPBK' },
    })
    const productUrl =
      'https://northwestknives.com/products/spyderco-paramilitary-3-black-g10-black-cpm-s30v-blade-c223gpbk'
    const fetchPage = vi.fn(
      async (url: string, _signal: AbortSignal, _laneKey: string) => ({
        html: url.includes('/search/suggest.json')
          ? fixture('northwestknives-search-para-3.json')
          : fixture('northwestknives-item-para-3-c223gpbk.json'),
        finalUrl: url,
      }),
    )
    const match = vi.fn(async ({ candidates }) => ({
      accepted: true,
      variants: [],
      confidence: 0.9,
      reason: 'Same model.',
      candidate: candidates.find((item: { title: string }) =>
        item.title.includes('C223GPBK'),
      ),
    }))
    const summary = await discoverKnife(knifeId, {
      deps: deps({ fetchPage, match }),
      store: 'northwestknives',
    })

    expect(summary).toMatchObject({ status: 'done', result: 'found' })
    expect(fetchPage.mock.calls.map(([url, , lane]) => [url, lane])).toEqual([
      [
        'https://northwestknives.com/search/suggest.json?q=Spyderco+Para+3+C223GPBK&resources%5Btype%5D=product&resources%5Blimit%5D=10',
        'northwestknives.com',
      ],
      [productUrl, 'northwestknives.com'],
    ])
    const watch = await getWatch(knifeId)
    expect(watch.sources).toEqual([
      expect.objectContaining({
        url: productUrl,
        laneKey: 'northwestknives.com',
        // Checked through /products/<handle>.js from the first check.
        provider: 'shopify',
        foundByAi: true,
      }),
    ])
  })

  it('does nothing until AI is connected and the store is on', async () => {
    const knifeId = await createKnife({ specs: { price: '$150' } })
    expect(nextDiscoveryKnife(getSettings().priceMonitoring)).toBeNull()
    enableOtherStores(false)
    expect(nextDiscoveryKnife(getSettings().priceMonitoring)).toBeNull()
    expect(await discoverKnife(knifeId, { deps: deps() })).toEqual({
      status: 'skipped',
      reason: 'disabled',
    })
    enableOtherStores()
    expect(nextDiscoveryKnife(getSettings().priceMonitoring)).toBe(knifeId)
  })

  it('finds, verifies and adds the Blade HQ listing as a monitored source', async () => {
    enableOtherStores()
    // No product link: Other stores still covers a knife with a price.
    const knifeId = await createKnife({ specs: { price: '$150' } })
    // A knife set to Never monitor is not searched.
    const off = await createKnife({ name: 'Off' })
    await priceWatchRoute.PUT(
      new Request(`http://localhost/api/knives/${off}/price-watch`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'off' }),
      }),
      { params: Promise.resolve({ id: off }) },
    )
    const run = deps()
    const summary = await discoverKnife(knifeId, { deps: run })

    expect(summary).toMatchObject({
      status: 'done',
      result: 'found',
      laneOutcome: 'success',
    })
    expect(run.fetchPage).toHaveBeenNthCalledWith(
      1,
      'https://www.bladehq.com/?search=Spyderco+Para+3',
      expect.anything(),
      'bladehq.com',
    )
    expect(run.fetchPage).toHaveBeenNthCalledWith(
      2,
      PRODUCT_URL,
      expect.anything(),
      'bladehq.com',
    )
    // AI sees the knife's identity, never what was paid.
    const matchInput = vi.mocked(run.match!).mock.calls[0][0]
    expect(matchInput.knife).toEqual({ brand: 'Spyderco', name: 'Para 3' })
    expect(JSON.stringify(matchInput)).not.toContain('150')

    const watch = await getWatch(knifeId)
    expect(watch.eligibility.monitored).toBe(true)
    expect(watch.sources).toEqual([
      expect.objectContaining({
        url: PRODUCT_URL,
        provider: 'generic',
        laneKey: 'bladehq.com',
        origin: 'manual',
        status: 'pending',
        foundByAi: true,
      }),
    ])
    // A knife with a Blade HQ source is not searched there again.
    expect(nextDiscoveryKnife(getSettings().priceMonitoring)).toBeNull()

    const response = await discoveryRoute.GET(
      new Request('http://localhost/api/prices/discovery'),
    )
    const { discovery: all } = (await response.json()) as {
      discovery: {
        active: boolean
        stores: Array<{
          store: string
          active: boolean
          counts: Record<string, number>
          recent: Array<{ status: string; sourceActive: boolean }>
        }>
      }
    }
    expect(all.active).toBe(true)
    expect(all.stores.map((store) => [store.store, store.active])).toEqual([
      ['bladehq', true],
      ['smkw', false],
      ['dlttrading', false],
      ['knifejoy', false],
      ['northwestknives', false],
      ['amazon', false],
    ])
    const discovery = all.stores[0]
    expect(discovery.counts.found).toBe(1)
    expect(discovery.recent[0]).toMatchObject({
      status: 'found',
      sourceActive: true,
    })

    // Removing the source keeps it removed: found knives are never re-added.
    const removed = await priceWatchRoute.PUT(
      new Request(`http://localhost/api/knives/${knifeId}/price-watch`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remove: [watch.sources[0].id] }),
      }),
      { params: Promise.resolve({ id: knifeId }) },
    )
    expect(removed.status).toBe(200)
    expect(nextDiscoveryKnife(getSettings().priceMonitoring)).toBeNull()
  })

  it('records a rejected product page and searches again later', async () => {
    enableOtherStores()
    const knifeId = await createKnife({ specs: { price: '$150' } })
    const summary = await discoverKnife(knifeId, {
      deps: deps({
        verify: vi.fn(async () => ({
          accepted: false,
          confidence: 0.9,
          reason: 'The page sells the Para Military 2.',
          kind: null,
          sameModel: false,
        })),
      }),
    })
    expect(summary).toMatchObject({ status: 'done', result: 'rejected' })
    expect((await getWatch(knifeId)).sources).toEqual([])
    expect(nextDiscoveryKnife(getSettings().priceMonitoring)).toBeNull()

    const row = getLocalDb()
      .prepare('SELECT * FROM price_discovery WHERE knife_id = ?')
      .get(knifeId) as { detail: string; next_attempt_at: string }
    expect(row.detail).toBe('The page sells the Para Military 2.')
    // Looked for again the next day, not a month later.
    const wait = Date.parse(row.next_attempt_at) - Date.now()
    expect(wait).toBeGreaterThan(23 * 3_600_000)
    expect(wait).toBeLessThanOrEqual(24 * 3_600_000)

    const retry = await discoveryRoute.POST(
      new Request('http://localhost/api/prices/discovery', { method: 'POST' }),
    )
    expect(((await retry.json()) as { reset: number }).reset).toBe(1)
    expect(nextDiscoveryKnife(getSettings().priceMonitoring)).toBe(knifeId)
  })

  it('rejects a listing whose page does not show the knife’s model number', async () => {
    enableOtherStores()
    const knifeId = await createKnife({
      specs: { price: '$150', modelNumber: 'C223GPBK' },
    })
    const summary = await discoverKnife(knifeId, { deps: deps() })
    expect(summary).toMatchObject({ status: 'done', result: 'rejected' })
    expect((await getWatch(knifeId)).sources).toEqual([])
    const row = getLocalDb()
      .prepare('SELECT detail FROM price_discovery WHERE knife_id = ?')
      .get(knifeId) as { detail: string }
    expect(row.detail).toBe(
      'The Blade HQ page does not show model number C223GPBK.',
    )
  })

  it('lets AI browse the store when its search finds nothing, and adds what AI confirmed', async () => {
    enableOtherStores()
    const knifeId = await createKnife({
      specs: { price: '$150', modelNumber: 'C223GP' },
    })
    const browsedUrl = 'https://www.bladehq.com/item--Spyderco-Para-3--999'
    const browse = vi.fn(async (_input: BrowseInput) => ({
      page: {
        html: productHtml('Spyderco Para 3 Folding Knife CTS BD1N - C223GP'),
        finalUrl: browsedUrl,
      },
      note: null,
    }))
    const run = deps({
      fetchPage: vi.fn(async (url: string) => ({
        html: EMPTY_SEARCH_HTML,
        finalUrl: url,
      })),
      browse,
    })
    expect(await discoverKnife(knifeId, { deps: run })).toMatchObject({
      status: 'done',
      result: 'found',
    })
    expect(browse).toHaveBeenCalledTimes(1)
    expect(browse.mock.calls[0][0]).toMatchObject({
      store: { id: 'bladehq' },
      knife: { id: knifeId },
    })
    const sources = (await getWatch(knifeId)).sources
    expect(sources).toHaveLength(1)
    expect(sources[0].url).toBe(browsedUrl)
    const row = getLocalDb()
      .prepare('SELECT status, detail FROM price_discovery WHERE knife_id = ?')
      .get(knifeId) as { status: string; detail: string }
    expect(row).toEqual({
      status: 'found',
      detail:
        "AI found it by browsing Blade HQ after the store's search did not lead to it.",
    })
  })

  it('keeps a turned-down listing rejected when AI browsing finds nothing either', async () => {
    enableOtherStores()
    const knifeId = await createKnife({
      specs: { price: '$150', modelNumber: 'C223GPBK' },
    })
    const browse = vi.fn(async () => ({
      page: null,
      note: 'AI also browsed Blade HQ and did not find it.',
    }))
    const summary = await discoverKnife(knifeId, { deps: deps({ browse }) })
    expect(summary).toMatchObject({ status: 'done', result: 'rejected' })
    expect(browse).toHaveBeenCalledTimes(1)
    const row = getLocalDb()
      .prepare('SELECT detail FROM price_discovery WHERE knife_id = ?')
      .get(knifeId) as { detail: string }
    expect(row.detail).toBe(
      'The Blade HQ page does not show model number C223GPBK. AI also browsed Blade HQ and did not find it.',
    )
  })

  it('does not browse the store when AI may not solve problems in the browser', async () => {
    enableOtherStores()
    const settings = getSettings().priceMonitoring
    saveSettings({
      priceMonitoring: {
        ...settings,
        ai: { ...settings.ai, resolveErrors: false },
      },
    })
    const knifeId = await createKnife({
      specs: { price: '$150', modelNumber: 'C223GPBK' },
    })
    const browse = vi.fn(async () => ({ page: null, note: null }))
    expect(
      await discoverKnife(knifeId, { deps: deps({ browse }) }),
    ).toMatchObject({ status: 'done', result: 'rejected' })
    expect(browse).not.toHaveBeenCalled()
  })

  it('adds a listing whose page shows the knife’s model number', async () => {
    enableOtherStores()
    const knifeId = await createKnife({
      specs: { price: '$150', modelNumber: 'C223GP' },
    })
    const run = deps({
      fetchPage: vi.fn(async (url: string) => ({
        html: url.includes('?search=')
          ? SEARCH_HTML
          : productHtml('Spyderco Para 3 Folding Knife CTS BD1N - C223GP'),
        finalUrl: url,
      })),
    })
    expect(await discoverKnife(knifeId, { deps: run })).toMatchObject({
      status: 'done',
      result: 'found',
    })
    expect((await getWatch(knifeId)).sources).toHaveLength(1)
  })

  it('adds a page that shows the exact model number even when AI words a spec differently', async () => {
    enableOtherStores()
    const knifeId = await createKnife({
      brand: 'Vosteed',
      name: 'Raccoon',
      specs: { price: '$69', modelNumber: 'A2918' },
    })
    const productUrl = 'https://www.bladehq.com/item--Vosteed-Raccoon--2918'
    const match = vi.fn(async () => ({
      accepted: false,
      confidence: 0.4,
      reason: 'The result names a bowie blade, not a flat one.',
      candidate: null,
      variants: [],
    }))
    const run = deps({
      fetchPage: vi.fn(async (url: string) => ({
        html: url.includes('?search=')
          ? `<main><div class="card"><a href="/item--Vosteed-Raccoon--2918">Vosteed Raccoon Bowie A2918</a><span>$69.00</span></div></main>`
          : productHtml('Vosteed Raccoon Bowie 14C28N A2918', 'Bowie blade'),
        finalUrl: url,
      })),
      match: match as unknown as DiscoveryDeps['match'],
      verify: vi.fn(async () => ({
        accepted: false,
        confidence: 0.8,
        reason: 'The page describes a bowie blade, not a flat one.',
        kind: 'knife' as const,
        sameModel: true,
      })),
    })

    expect(await discoverKnife(knifeId, { deps: run })).toMatchObject({
      status: 'done',
      result: 'found',
    })
    const sources = (await getWatch(knifeId)).sources
    expect(sources.map((source) => source.url)).toEqual([productUrl])
    const row = getLocalDb()
      .prepare(
        'SELECT detail, confidence FROM price_discovery WHERE knife_id = ?',
      )
      .get(knifeId)
    expect(row).toEqual({
      detail: 'The Blade HQ page shows model number A2918.',
      confidence: null,
    })
  })

  it('never adds an accessory page, even when it shows the model number', async () => {
    enableOtherStores()
    const knifeId = await createKnife({
      specs: { price: '$150', modelNumber: 'C223GP' },
    })
    const run = deps({
      fetchPage: vi.fn(async (url: string) => ({
        html: url.includes('?search=')
          ? SEARCH_HTML
          : productHtml('Leather Sheath for Spyderco Para 3 C223GP'),
        finalUrl: url,
      })),
      verify: vi.fn(async () => ({
        accepted: false,
        confidence: 0.9,
        reason: '',
        kind: 'accessory' as const,
        sameModel: false,
      })),
    })
    expect(await discoverKnife(knifeId, { deps: run })).toMatchObject({
      status: 'done',
      result: 'rejected',
    })
    expect((await getWatch(knifeId)).sources).toEqual([])
    const row = getLocalDb()
      .prepare('SELECT detail FROM price_discovery WHERE knife_id = ?')
      .get(knifeId) as { detail: string }
    expect(row.detail).toBe(
      'AI says the Blade HQ page sells an accessory, not the knife.',
    )
  })

  it('keeps other variants of the model as related listings, monitoring them as variants', async () => {
    enableOtherStores()
    const knifeId = await createKnife({
      brand: 'Vosteed',
      name: 'Porcupine TiSlim',
      specs: { price: '$139', modelNumber: 'A4804' },
    })
    const search = `<main>
      <div class="card"><a href="/item--Vosteed-Porcupine-TiSlim--4801">Vosteed Porcupine TiSlim A4801 Black</a><span>$129.00</span></div>
      <div class="card"><a href="/item--Vosteed-Porcupine-TiSlim--4815">Vosteed Porcupine TiSlim A4815 S90V</a><span>$189.00</span></div>
    </main>`
    const run = deps({
      fetchPage: vi.fn(async (url: string) => ({
        html: url.includes('?search=')
          ? search
          : productHtml('Vosteed Porcupine TiSlim A4815 S90V'),
        finalUrl: url,
      })),
      match: vi.fn(async ({ candidates }) => ({
        accepted: true,
        confidence: 0.8,
        reason: 'Closest listing.',
        candidate: candidates[1],
        variants: [candidates[0]],
      })) as unknown as DiscoveryDeps['match'],
      verify: vi.fn(async () => ({
        accepted: false,
        confidence: 0.9,
        reason: 'The page shows A4815, not A4804.',
        kind: 'knife' as const,
        sameModel: true,
      })),
    })

    expect(await discoverKnife(knifeId, { deps: run })).toMatchObject({
      status: 'done',
      result: 'variant',
    })
    // Monitored apart from the knife: variant listings, not its own store.
    expect(
      (await getWatch(knifeId)).sources.map((source) => [
        source.url,
        source.variantTitle,
      ]),
    ).toEqual([
      [
        'https://www.bladehq.com/item--Vosteed-Porcupine-TiSlim--4801',
        'Vosteed Porcupine TiSlim A4801 Black',
      ],
      [
        'https://www.bladehq.com/item--Vosteed-Porcupine-TiSlim--4815',
        'Vosteed Porcupine TiSlim A4815 S90V',
      ],
    ])
    const variants = getLocalDb()
      .prepare(
        `SELECT url, title, price_text FROM price_discovery_variants
         WHERE knife_id = ? ORDER BY position`,
      )
      .all(knifeId)
    expect(variants).toEqual([
      {
        url: 'https://www.bladehq.com/item--Vosteed-Porcupine-TiSlim--4801',
        title: 'Vosteed Porcupine TiSlim A4801 Black',
        price_text: '$129.00',
      },
      {
        url: 'https://www.bladehq.com/item--Vosteed-Porcupine-TiSlim--4815',
        title: 'Vosteed Porcupine TiSlim A4815 S90V',
        price_text: '$189.00',
      },
    ])
    // A variant-only store is searched again the next day, like a miss.
    const row = getLocalDb()
      .prepare('SELECT next_attempt_at FROM price_discovery WHERE knife_id = ?')
      .get(knifeId) as { next_attempt_at: string }
    const wait = Date.parse(row.next_attempt_at) - Date.now()
    expect(wait).toBeGreaterThan(23 * 3_600_000)
    expect(wait).toBeLessThanOrEqual(24 * 3_600_000)
  })

  it('reports a bot check to the store’s lane without asking AI', async () => {
    enableOtherStores()
    const knifeId = await createKnife({ specs: { price: '$150' } })
    const run = deps({
      fetchPage: vi.fn(async () => {
        throw new ScrapeError('challenge')
      }),
    })
    expect(await discoverKnife(knifeId, { deps: run })).toMatchObject({
      status: 'done',
      result: 'blocked',
      laneOutcome: 'blocked',
    })
    expect(run.match).not.toHaveBeenCalled()
  })

  it('finds a knife on Blade HQ from its live search and product pages', async () => {
    enableOtherStores()
    const knifeId = await createKnife({
      specs: { price: '$150', modelNumber: 'C223GPBK' },
    })
    const product =
      'https://www.bladehq.com/item--Spyderco-Para-3-Compression-Lock--67321'
    const fetchPage = vi.fn<DiscoveryDeps['fetchPage']>(async (url) =>
      url.includes('?search=')
        ? {
            html: fixture('bladehq-search-para-3.html'),
            // Blade HQ redirects a close match to the model's category.
            finalUrl: 'https://www.bladehq.com/cat--Spyderco-Para-3--2475',
          }
        : { html: fixture('bladehq-item-para-3-c223gpbk.html'), finalUrl: url },
    )
    const match = vi.fn(
      async ({ candidates }: { candidates: Array<{ title: string }> }) => ({
        accepted: true,
        variants: [],
        confidence: 0.9,
        reason: 'Same model number.',
        candidate: candidates.find((item) => item.title.endsWith('C223GPBK'))!,
      }),
    )
    const run = deps({
      fetchPage,
      match: match as unknown as DiscoveryDeps['match'],
    })
    expect(
      await discoverKnife(knifeId, { deps: run, store: 'bladehq' }),
    ).toMatchObject({ status: 'done', result: 'found', laneOutcome: 'success' })
    expect(fetchPage.mock.calls.map(([url, , lane]) => [url, lane])).toEqual([
      [
        'https://www.bladehq.com/?search=Spyderco+Para+3+C223GPBK',
        'bladehq.com',
      ],
      [product, 'bladehq.com'],
    ])
    // AI sees the selling price, not the struck-through MSRP.
    expect(match.mock.calls[0][0].candidates[1]).toMatchObject({
      title:
        'Spyderco Para 3 Compression Lock Knife Black G-10 (3" Black DLC) C223GPBK',
      price: '$212.25',
    })
    const sources = (await getWatch(knifeId)).sources
    expect(sources.map((source) => source.url)).toEqual([product])
  })

  it('says a store blocks this network rather than showing a bot check', async () => {
    enableOtherStores()
    const knifeId = await createKnife({ specs: { price: '$150' } })
    const run = deps({
      fetchPage: vi.fn(async () => {
        throw networkBlockError(403)
      }),
    })
    expect(
      await discoverKnife(knifeId, { deps: run, store: 'bladehq' }),
    ).toMatchObject({
      status: 'done',
      result: 'blocked',
      // Pauses the store's lane like a bot check would.
      laneOutcome: 'blocked',
    })
    expect(run.match).not.toHaveBeenCalled()
    const row = getLocalDb()
      .prepare(
        "SELECT status, detail FROM price_discovery WHERE knife_id = ? AND store = 'bladehq'",
      )
      .get(knifeId) as { status: string; detail: string }
    expect(row.status).toBe('blocked')
    expect(row.detail).toContain(
      'Blade HQ blocks visitors from this network or IP address',
    )
    expect(row.detail).not.toContain('showed a bot check')
  })

  it('does not blame the knife when the AI endpoint fails', async () => {
    enableOtherStores()
    const knifeId = await createKnife({ specs: { price: '$150' } })
    const summary = await discoverKnife(knifeId, {
      deps: deps({
        match: vi.fn(async () => {
          throw new AiClientError('network', 'Could not reach the AI endpoint.')
        }),
      }),
    })
    expect(summary).toMatchObject({ status: 'done', aiProblem: true })
    expect(
      getLocalDb().prepare('SELECT COUNT(*) AS n FROM price_discovery').get(),
    ).toEqual({ n: 0 })
    expect(nextDiscoveryKnife(getSettings().priceMonitoring)).toBe(knifeId)
  })
})
