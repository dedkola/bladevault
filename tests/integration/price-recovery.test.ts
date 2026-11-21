import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as knivesRoute from '@/app/api/knives/route'
import { getLocalDb } from '@/lib/local-db'
import { setAiBudgetGate } from '@/lib/price-monitor/ai-client'
import { answerPriceQuestion } from '@/lib/price-monitor/agent-inbox'
import { checkPriceSource } from '@/lib/price-monitor/engine'
import type { SolverResult } from '@/lib/price-monitor/solver'
import {
  readActiveSources,
  readRecoveryStats,
  readSource,
} from '@/lib/price-monitor/store'
import { getPriceMonitorWorker } from '@/lib/price-monitor/worker'
import { ScrapeError } from '@/lib/scrape-errors'
import type { ExtractedOffer } from '@/lib/scrape-offer'
import { getSettings, saveSettings } from '@/lib/settings'
import { DEFAULT_PRICE_MONITORING } from '@/lib/settings-shared'
import { getStorage } from '@/lib/storage'
import { getSystemMessages } from '@/lib/system-message-store'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

const mocks = vi.hoisted(() => ({
  browser: vi.fn(),
  http: vi.fn(),
  solve: vi.fn(),
}))

vi.mock('@/lib/price-monitor/fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/price-monitor/fetch')>()),
  checkViaBrowser: mocks.browser,
  checkViaHttp: mocks.http,
}))
vi.mock('@/lib/price-monitor/solver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/price-monitor/solver')>()),
  solveOnPage: mocks.solve,
}))
vi.mock('@/lib/url-validation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/url-validation')>()),
  validateExternalUrl: async (value: string) => ({
    ok: true,
    url: new URL(value),
  }),
}))

const PRODUCT_URL = 'https://shop.example/products/para-3'
const NEW_URL = 'https://shop.example/products/para-3-lightweight'
const CATEGORY = `<html><head><title>Folding knives</title></head><body>
<main><h1>Folding knives</h1><a href="/products/x">Some knife</a></main></body></html>`
const productHtml = (model: string) => `<html><head><title>Para 3</title>
<script type="application/ld+json">{"@type":"Product","name":"Spyderco Para 3 Lightweight","offers":{"@type":"Offer","price":"99.00","priceCurrency":"USD"}}</script>
</head><body><main><h1>Spyderco Para 3 Lightweight</h1><p>Model ${model}</p></main></body></html>`
const shopifyPage = (selected: string) => `<html><body>
<form action="/cart/add" method="post"><select name="id">
<option value="111"${selected === '111' ? ' selected' : ''}>Black</option>
<option value="222"${selected === '222' ? ' selected' : ''}>Blue</option>
</select></form><span class="price">$50.00</span></body></html>`

let vault: TempVault

beforeEach(async () => {
  vault = await createTempVault()
  vi.resetAllMocks()
  // AI requests other than the mocked solver are not answered.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('fetch failed')
    }),
  )
})
afterEach(async () => {
  vi.unstubAllGlobals()
  setAiBudgetGate(null)
  await getPriceMonitorWorker().stop()
  await vault.cleanup()
})

function enableAi(patch: Partial<typeof DEFAULT_PRICE_MONITORING.ai> = {}) {
  saveSettings({
    priceMonitoring: {
      ...getSettings().priceMonitoring,
      ai: {
        ...DEFAULT_PRICE_MONITORING.ai,
        enabled: true,
        baseUrl: 'http://ai.local.test/v1',
        model: 'test-model',
        ...patch,
      },
    },
  })
}

async function createKnife(sourceUrl = PRODUCT_URL, modelNumber = 'C223PBK') {
  const response = await knivesRoute.POST(
    new Request('http://localhost/api/knives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Para 3 Lightweight',
        brand: 'Spyderco',
        specs: { modelNumber },
        sourceUrl,
      }),
    }),
  )
  const id = ((await response.json()) as { knife: { id: string } }).knife.id
  const { syncAutoSource } = await import('@/lib/price-monitor/store')
  await syncAutoSource((await getStorage().getKnifeById(id))!)
  return { id, source: readActiveSources(getLocalDb(), id)[0] }
}

const offer = (amount: number): ExtractedOffer => ({
  amount,
  currency: 'USD',
  availability: 'in_stock',
  method: 'jsonld',
})

/** One browser reading: a page, or an error to throw. */
type BrowserStep =
  | Error
  | {
      offer: ExtractedOffer | null
      html: string
      finalUrl?: string
      isShopify?: boolean
    }

/** Browser readings in order; a solver run gets its interact call. */
function browserReads(...steps: BrowserStep[]) {
  mocks.browser.mockImplementation(
    async (
      url: string,
      operation: unknown,
      options: { interact?: (page: unknown, op: unknown) => Promise<void> },
    ) => {
      const next = steps.shift()
      if (!next) throw new Error('no more browser readings')
      if (next instanceof Error) throw next
      if (options?.interact) await options.interact({}, operation)
      return {
        serverOffer: null,
        isShopify: false,
        finalUrl: url,
        ...next,
      }
    },
  )
}

function solverReturns(result: Partial<SolverResult>) {
  mocks.solve.mockResolvedValueOnce({
    status: 'failed',
    offer: null,
    readByAi: false,
    recipe: null,
    steps: [{ action: 'search', detail: 'Para 3', result: 'searched' }],
    aiCalls: 2,
    note: null,
    ...result,
  })
}

const lastLog = () =>
  getLocalDb()
    .prepare('SELECT * FROM price_check_log ORDER BY id DESC LIMIT 1')
    .get() as Record<string, unknown>

describe('pages that moved', () => {
  it('asks in the Inbox to use the new link AI found, then moves the source', async () => {
    enableAi()
    const { id, source } = await createKnife()
    browserReads(
      {
        offer: null,
        html: CATEGORY,
        finalUrl: 'https://shop.example/collections/folding',
      },
      { offer: null, html: CATEGORY },
    )
    solverReturns({
      status: 'solved',
      offer: offer(99),
      finalUrl: NEW_URL,
      html: productHtml('C223PBK'),
    })
    await checkPriceSource(source.id, { trigger: 'manual' })

    // The search started on the category page the store redirected to.
    expect(mocks.browser.mock.calls[1][0]).toBe(
      'https://shop.example/collections/folding',
    )
    const input = mocks.solve.mock.calls[0][1]
    expect(input.problem.code).toBe('find_product')
    expect(input.search.queries[0]).toContain('C223PBK')
    expect(readSource(getLocalDb(), source.id)).toMatchObject({
      url: PRODUCT_URL,
      last_error_code: 'moved',
    })
    expect(lastLog()).toMatchObject({ recovery: 'relink:asked' })

    const question = (await getSystemMessages()).find(
      (message) => message.kind === 'price-question',
    )
    expect(question?.payload).toMatchObject({
      ask: 'relink',
      sourceId: source.id,
      url: NEW_URL,
    })
    await answerPriceQuestion(question!.id, 'yes')
    expect(readSource(getLocalDb(), source.id)).toMatchObject({
      url: NEW_URL,
      enabled: 1,
      status: 'pending',
      consecutive_failures: 0,
    })
    // The knife's own product link moved with its source.
    expect((await getStorage().getKnifeById(id))?.sourceUrl).toBe(NEW_URL)
    expect(readActiveSources(getLocalDb(), id)).toHaveLength(1)
  })

  it('moves the source at once when allowed and the model number shows', async () => {
    enableAi({ autoRelink: true })
    const { source } = await createKnife()
    browserReads(
      {
        offer: null,
        html: CATEGORY,
        finalUrl: 'https://shop.example/collections/folding',
      },
      { offer: null, html: CATEGORY },
    )
    solverReturns({
      status: 'solved',
      offer: offer(99),
      finalUrl: `${NEW_URL}.js`,
      html: productHtml('C223PBK'),
    })
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(readSource(getLocalDb(), source.id)).toMatchObject({
      url: NEW_URL,
      status: 'ok',
      last_price_minor: 9900,
    })
    expect(String(readSource(getLocalDb(), source.id)?.last_error)).toContain(
      'moved this source there',
    )
    expect(lastLog()).toMatchObject({
      method: 'solver',
      recovery: 'relink:fixed',
    })
  })

  it('asks instead when the page shows another model number', async () => {
    enableAi({ autoRelink: true })
    const { source } = await createKnife()
    browserReads(
      {
        offer: null,
        html: CATEGORY,
        finalUrl: 'https://shop.example/collections/folding',
      },
      { offer: null, html: CATEGORY },
    )
    solverReturns({
      status: 'solved',
      offer: offer(99),
      finalUrl: NEW_URL,
      html: productHtml('C223GP'),
    })
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(readSource(getLocalDb(), source.id)?.url).toBe(PRODUCT_URL)
    expect(lastLog()).toMatchObject({ recovery: 'relink:asked' })
  })

  it('searches from the store home page after a 404', async () => {
    enableAi()
    const { source } = await createKnife()
    browserReads(new ScrapeError('http', 'The website returned HTTP 404.'), {
      offer: null,
      html: CATEGORY,
    })
    solverReturns({
      status: 'failed',
      note: 'AI could not find the product on the store.',
    })
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(mocks.browser.mock.calls[1][0]).toBe('https://shop.example/')
    expect(readSource(getLocalDb(), source.id)).toMatchObject({
      status: 'failed',
      last_error_code: 'http',
    })
    expect(String(readSource(getLocalDb(), source.id)?.last_error)).toContain(
      'AI could not find the product',
    )
    expect(lastLog()).toMatchObject({ recovery: 'relink:failed' })
  })

  it('records a "not found" page without AI when page search is off', async () => {
    enableAi({ findMovedPages: false })
    const { source } = await createKnife()
    browserReads(
      {
        offer: null,
        html: '<html><head><title>Page not found</title></head><body></body></html>',
      },
      { offer: null, html: '' },
    )
    solverReturns({ status: 'failed', steps: [] })
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(readSource(getLocalDb(), source.id)).toMatchObject({
      status: 'failed',
      last_error_code: 'soft_missing',
    })
    // The plain solver may still try; no relink search ran.
    expect(mocks.solve.mock.calls[0]?.[1].search).toBeUndefined()
    expect(await getSystemMessages()).not.toContainEqual(
      expect.objectContaining({ kind: 'price-question' }),
    )
  })
})

describe('variants', () => {
  it('reads the tracked Shopify variant when the page shows another', async () => {
    enableAi()
    const { source } = await createKnife(`${PRODUCT_URL}?variant=111`)
    browserReads({
      offer: offer(50),
      html: shopifyPage('222'),
      isShopify: true,
    })
    mocks.http.mockResolvedValueOnce({
      offer: offer(80),
      finalUrl: `${PRODUCT_URL}?variant=111`,
      isShopify: true,
    })
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(mocks.http.mock.calls[0][0]).toContain('variant=111')
    expect(readSource(getLocalDb(), source.id)).toMatchObject({
      status: 'ok',
      last_price_minor: 8000,
    })
    expect(lastLog()).toMatchObject({ recovery: 'variant:fixed' })
  })

  it('learns the variant, then keeps another variant’s price out', async () => {
    enableAi()
    const { source } = await createKnife()
    browserReads(
      { offer: offer(50), html: shopifyPage('111') },
      { offer: offer(60), html: shopifyPage('222') },
      { offer: null, html: shopifyPage('222') },
    )
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(
      JSON.parse(String(readSource(getLocalDb(), source.id)?.expected_variant)),
    ).toMatchObject({ id: '111' })

    solverReturns({ status: 'gave_up', note: 'AI gave up: no Black.' })
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(mocks.solve.mock.calls[0][1].problem).toMatchObject({
      code: 'wrong_variant',
    })
    expect(mocks.solve.mock.calls[0][1].problem.message).toContain('"Blue"')
    expect(readSource(getLocalDb(), source.id)).toMatchObject({
      status: 'failed',
      last_error_code: 'wrong_variant',
      last_price_minor: 5000,
    })
    expect(lastLog()).toMatchObject({ recovery: 'variant:failed' })
  })
})

describe('bot checks', () => {
  it('tries once more with fresh cookies without touching the bot check', async () => {
    enableAi()
    const { source } = await createKnife()
    browserReads(new ScrapeError('challenge'), {
      offer: offer(70),
      html: productHtml('C223PBK'),
    })
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(mocks.browser).toHaveBeenCalledTimes(2)
    expect(mocks.browser.mock.calls[1][2].storageState).toBeUndefined()
    expect(mocks.solve).not.toHaveBeenCalled()
    expect(readSource(getLocalDb(), source.id)).toMatchObject({
      status: 'ok',
      last_price_minor: 7000,
    })
    expect(lastLog()).toMatchObject({ recovery: 'blocked:fixed' })
  })

  it('leaves a remaining bot check to the user and counts it', async () => {
    enableAi()
    const { source } = await createKnife()
    browserReads(new ScrapeError('challenge'), new ScrapeError('challenge'))
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(readSource(getLocalDb(), source.id)?.status).toBe('blocked')
    expect(lastLog()).toMatchObject({ recovery: 'blocked:asked' })
    expect(
      readRecoveryStats(getLocalDb()).find((row) => row.kind === 'blocked'),
    ).toEqual({ kind: 'blocked', tried: 1, fixed: 0, asked: 1 })
  })

  it('does nothing extra with the switch off', async () => {
    enableAi({ retryBlocked: false })
    const { source } = await createKnife()
    browserReads(new ScrapeError('challenge'))
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(mocks.browser).toHaveBeenCalledTimes(1)
    expect(lastLog().recovery).toBeNull()
  })
})
