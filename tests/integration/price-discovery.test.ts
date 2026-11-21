import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as knivesRoute from '@/app/api/knives/route'
import * as priceWatchRoute from '@/app/api/knives/[id]/price-watch/route'
import * as discoveryRoute from '@/app/api/prices/discovery/route'
import { getLocalDb } from '@/lib/local-db'
import { AiClientError } from '@/lib/price-monitor/ai-client'
import { AmazonLocationError } from '@/lib/price-monitor/amazon-location'
import {
  discoverKnife,
  nextDiscoveryKnife,
  type DiscoveryDeps,
} from '@/lib/price-monitor/discovery'
import type { PriceWatchView } from '@/lib/price-monitor/shared'
import { getPriceMonitorWorker } from '@/lib/price-monitor/worker'
import { networkBlockError } from '@/lib/scrape'
import { ScrapeError } from '@/lib/scrape-errors'
import { getSettings, saveSettings } from '@/lib/settings'
import { DEFAULT_PRICE_MONITORING } from '@/lib/settings-shared'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault | null = null

beforeEach(async () => {
  vault = await createTempVault()
})
afterEach(async () => {
  await getPriceMonitorWorker().stop()
  await vault?.cleanup()
  vault = null
})

const SEARCH_HTML = `
  <div data-component-type="s-search-result" data-asin="B0CASE0001">
    <h2>Leather Sheath for Para 3</h2></div>
  <div data-component-type="s-search-result" data-asin="B07PARA003">
    <h2>Spyderco Para 3 Folding Knife CTS BD1N</h2>
    <span class="a-price"><span class="a-offscreen">$124.95</span></span></div>`

const PRODUCT_HTML = `<html><body>
  <span id="productTitle">Spyderco Para 3 Folding Knife CTS BD1N</span>
  <div id="feature-bullets"><ul><li>2.95 inch CTS BD1N blade</li></ul></div>
</body></html>`

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/scrape/${name}`, import.meta.url), 'utf8')

function enableOtherStores(
  ai = true,
  stores = { amazon: true, bladehq: false },
) {
  saveSettings({
    priceMonitoring: {
      ...DEFAULT_PRICE_MONITORING,
      ai: {
        ...DEFAULT_PRICE_MONITORING.ai,
        enabled: ai,
        baseUrl: 'http://localhost:11434/v1',
        model: 'test-model',
      },
      otherStores: {
        enabled: true,
        stores,
        amazonMarketplace: 'amazon.com',
        amazonPostcode: '',
      },
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
      html: url.includes('/s?') ? SEARCH_HTML : PRODUCT_HTML,
      finalUrl: url,
    })),
    match: vi.fn(async ({ candidates }) => ({
      accepted: true,
      confidence: 0.9,
      reason: 'Same model and steel.',
      candidate: candidates[1],
    })),
    verify: vi.fn(async () => ({
      accepted: true,
      confidence: 0.95,
      reason: 'The page sells the Para 3 in BD1N.',
    })),
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
        ? fixture('amazon-search-no-results.html')
        : url.includes('/s?')
          ? SEARCH_HTML
          : // The title leaves the code out; the details show it.
            PRODUCT_HTML.replace('</ul>', '<li>Model: C223GP</li></ul>'),
      finalUrl: url,
    }))
    const run = deps({ fetchPage })
    const summary = await discoverKnife(knifeId, { deps: run })

    expect(summary).toMatchObject({ status: 'done', result: 'found' })
    expect(fetchPage.mock.calls.map(([url]) => url)).toEqual([
      'https://www.amazon.com/s?k=Spyderco+Para+3+C223GP',
      'https://www.amazon.com/s?k=Spyderco+Para+3',
      'https://www.amazon.com/dp/B07PARA003',
    ])
  })

  it('records "not found" when Amazon’s own result lists are empty', async () => {
    enableOtherStores()
    const knifeId = await createKnife({
      specs: { price: '$150', modelNumber: 'C223GP' },
    })
    const run = deps({
      fetchPage: vi.fn(async (url: string) => ({
        html: fixture('amazon-search-no-results.html'),
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
      'Amazon had no results for “Spyderco Para 3 C223GP” or “Spyderco Para 3”.',
    )
  })

  it('does not record "not found" for a search page without a result list', async () => {
    enableOtherStores()
    const knifeId = await createKnife({ specs: { price: '$150' } })
    const before = Date.now()
    const run = deps({
      fetchPage: vi.fn(async () => ({
        // A checkpoint page the browser's bot-check detection missed.
        html: fixture('amazon-search-checkpoint.html').replace(
          'action="/checkpoint/validate"',
          'action="/checkpoint/next"',
        ),
        finalUrl: 'https://www.amazon.com/checkpoint/continue?token=x',
      })),
    })
    expect(await discoverKnife(knifeId, { deps: run })).toMatchObject({
      status: 'done',
      result: 'failed',
      laneOutcome: 'failed',
    })
    expect(run.match).not.toHaveBeenCalled()
    expect(run.fetchPage).toHaveBeenCalledTimes(1)
    const row = getLocalDb()
      .prepare(
        'SELECT status, detail, next_attempt_at FROM price_discovery WHERE knife_id = ?',
      )
      .get(knifeId) as {
      status: string
      detail: string
      next_attempt_at: string
    }
    expect(row.status).toBe('failed')
    expect(row.detail).toContain('Amazon showed a page without search results')
    // Searched again within hours, not after the 30 days of "not found".
    expect(Date.parse(row.next_attempt_at) - before).toBeLessThan(
      24 * 60 * 60 * 1000,
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

  it('finds, verifies and adds the Amazon listing as a monitored source', async () => {
    enableOtherStores()
    // No product link: Other stores still covers a knife with a price.
    const knifeId = await createKnife({ specs: { price: '$150' } })
    await createKnife({ name: 'No price' })
    const run = deps()
    const summary = await discoverKnife(knifeId, { deps: run })

    expect(summary).toMatchObject({
      status: 'done',
      result: 'found',
      laneOutcome: 'success',
    })
    expect(run.fetchPage).toHaveBeenNthCalledWith(
      1,
      'https://www.amazon.com/s?k=Spyderco+Para+3',
      expect.anything(),
      'amazon',
      // Amazon pages first get a delivery address in the marketplace.
      expect.any(Function),
    )
    expect(run.fetchPage).toHaveBeenNthCalledWith(
      2,
      'https://www.amazon.com/dp/B07PARA003',
      expect.anything(),
      'amazon',
      // Amazon pages first get a delivery address in the marketplace.
      expect.any(Function),
    )
    // AI sees the knife's identity, never what was paid.
    const matchInput = vi.mocked(run.match!).mock.calls[0][0]
    expect(matchInput.knife).toEqual({ brand: 'Spyderco', name: 'Para 3' })
    expect(JSON.stringify(matchInput)).not.toContain('150')

    const watch = await getWatch(knifeId)
    expect(watch.eligibility.monitored).toBe(true)
    expect(watch.sources).toEqual([
      expect.objectContaining({
        url: 'https://www.amazon.com/dp/B07PARA003',
        provider: 'amazon',
        laneKey: 'amazon',
        origin: 'manual',
        status: 'pending',
        foundByAi: true,
      }),
    ])
    // A knife with an Amazon source is not searched again.
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
      ['amazon', true],
      ['bladehq', false],
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
    expect(Date.parse(row.next_attempt_at)).toBeGreaterThan(
      Date.now() + 29 * 24 * 3_600_000,
    )

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
      'The Amazon page does not show model number C223GPBK.',
    )
  })

  it('adds a listing whose page shows the knife’s model number', async () => {
    enableOtherStores()
    const knifeId = await createKnife({
      specs: { price: '$150', modelNumber: 'C223GP' },
    })
    const run = deps({
      fetchPage: vi.fn(async (url: string) => ({
        html: url.includes('/s?')
          ? SEARCH_HTML
          : PRODUCT_HTML.replace('CTS BD1N</span>', 'CTS BD1N - C223GP</span>'),
        finalUrl: url,
      })),
    })
    expect(await discoverKnife(knifeId, { deps: run })).toMatchObject({
      status: 'done',
      result: 'found',
    })
    expect((await getWatch(knifeId)).sources).toHaveLength(1)
  })

  it('does not record "not found" when Amazon will not deliver to the marketplace', async () => {
    enableOtherStores()
    const knifeId = await createKnife({ specs: { price: '$150' } })
    const run = deps({
      fetchPage: vi.fn(async () => {
        throw new AmazonLocationError('Ukraine', '10001')
      }),
    })
    expect(await discoverKnife(knifeId, { deps: run })).toMatchObject({
      status: 'done',
      result: 'failed',
      laneOutcome: 'neutral',
    })
    expect(run.match).not.toHaveBeenCalled()
    const row = getLocalDb()
      .prepare('SELECT status, detail FROM price_discovery WHERE knife_id = ?')
      .get(knifeId) as { status: string; detail: string }
    expect(row.status).toBe('failed')
    expect(row.detail).toContain('Amazon delivers to Ukraine')
  })

  it('reports a bot check to the Amazon lane without asking AI', async () => {
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
    enableOtherStores(true, {
      amazon: false,
      bladehq: true,
    })
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
    enableOtherStores(true, { amazon: false, bladehq: true })
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
