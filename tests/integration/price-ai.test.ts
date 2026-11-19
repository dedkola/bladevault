import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as knivesRoute from '@/app/api/knives/route'
import * as solveRoute from '@/app/api/prices/sources/[id]/solve/route'
import * as advisorRoute from '@/app/api/prices/advisor/route'
import * as activityRoute from '@/app/api/prices/activity/route'
import * as keyRoute from '@/app/api/settings/price-ai-key/route'
import * as modelsRoute from '@/app/api/settings/price-ai-models/route'
import * as testRoute from '@/app/api/settings/price-ai-test/route'
import * as settingsRoute from '@/app/api/settings/route'
import { getLocalDb } from '@/lib/local-db'
import {
  loadBrowserState,
  saveBrowserState,
} from '@/lib/price-monitor/browser-state'
import { readActiveAdvice } from '@/lib/price-monitor/advice-store'
import { runPriceAdvisor } from '@/lib/price-monitor/advisor'
import {
  setAiBudgetGate,
  setAiCallObserver,
} from '@/lib/price-monitor/ai-client'
import { installAiCallJournal } from '@/lib/price-monitor/ai-journal'
import { checkPriceSource } from '@/lib/price-monitor/engine'
import { extractOfferFromHtml } from '@/lib/price-monitor/fetch'
import type { SolverPage } from '@/lib/price-monitor/solver'
import { getSystemMessages } from '@/lib/system-message-store'
import {
  getPriceAiKeyStatus,
  PRICE_AI_KEY_ENV,
  priceAiKeyPath,
  readPriceAiKey,
  writePriceAiKey,
} from '@/lib/price-monitor/secrets'
import { readActiveSources, writeLaneState } from '@/lib/price-monitor/store'
import {
  buildQueueSnapshot,
  getPriceMonitorWorker,
} from '@/lib/price-monitor/worker'
import { getSettings, saveSettings } from '@/lib/settings'
import { DEFAULT_PRICE_MONITORING } from '@/lib/settings-shared'
import { ScrapeError } from '@/lib/scrape-errors'
import type { ExtractedOffer } from '@/lib/scrape-offer'
import { getVaultAccessState } from '@/lib/vault-access'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

const mocks = vi.hoisted(() => ({
  browser: vi.fn(),
  http: vi.fn(),
  exportSession: vi.fn(),
}))

vi.mock('@/lib/scrape-interactive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/scrape-interactive')>()),
  exportInteractiveSessionState: mocks.exportSession,
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

const KEY = 'sk-integration-key-7f3a'
const BASE_URL = 'http://ai.local.test/v1'
const PRODUCT_URL = 'https://shop.example/products/raccoon'
const PAGE = `<html><head><title>Raccoon</title></head><body>
<div class="product"><span class="price-now">$118.50</span>
<p class="stock">In stock</p></div></body></html>`

let vault: TempVault
let aiFetch: ReturnType<typeof vi.fn<typeof fetch>>

beforeEach(async () => {
  vault = await createTempVault()
  vi.resetAllMocks()
  aiFetch = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', aiFetch)
  delete process.env[PRICE_AI_KEY_ENV]
})
afterEach(async () => {
  vi.unstubAllGlobals()
  delete process.env[PRICE_AI_KEY_ENV]
  await getPriceMonitorWorker().stop()
  await vault.cleanup()
})

function json(url: string, method: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function chat(content: unknown) {
  return Response.json({
    choices: [
      {
        message: {
          content:
            typeof content === 'string' ? content : JSON.stringify(content),
        },
      },
    ],
  })
}

function enableAi(patch: Partial<typeof DEFAULT_PRICE_MONITORING.ai> = {}) {
  saveSettings({
    priceMonitoring: {
      ...getSettings().priceMonitoring,
      ai: {
        ...DEFAULT_PRICE_MONITORING.ai,
        enabled: true,
        baseUrl: BASE_URL,
        model: 'test-model',
        ...patch,
      },
    },
  })
}

function rows(sql: string, ...args: unknown[]) {
  return getLocalDb()
    .prepare(sql)
    .all(...args) as Array<Record<string, unknown>>
}

async function createKnife(name = 'Raccoon', sourceUrl = PRODUCT_URL) {
  const response = await knivesRoute.POST(
    json('http://localhost/api/knives', 'POST', {
      name,
      brand: 'Vosteed',
      specs: { price: '129.00 USD' },
      sourceUrl,
    }),
  )
  const id = ((await response.json()) as { knife: { id: string } }).knife.id
  const { syncAutoSource } = await import('@/lib/price-monitor/store')
  const { getStorage } = await import('@/lib/storage')
  await syncAutoSource((await getStorage().getKnifeById(id))!)
  return { id, source: readActiveSources(getLocalDb(), id)[0] }
}

function browserPage(offer: ExtractedOffer | null, html = PAGE) {
  mocks.browser.mockResolvedValueOnce({
    offer,
    serverOffer: null,
    finalUrl: PRODUCT_URL,
    isShopify: false,
    html,
  })
}

describe('AI key file', () => {
  it('stores the key owner-only in the control folder and reports only the last 4', async () => {
    expect(await getPriceAiKeyStatus()).toEqual({
      hasKey: false,
      last4: '',
      source: null,
    })
    const status = await writePriceAiKey(`  ${KEY}  `)
    expect(status).toEqual({ hasKey: true, last4: '7f3a', source: 'file' })
    const file = priceAiKeyPath()
    expect(
      file.startsWith(path.join(vault.dataDir, '._bladevault-control')),
    ).toBe(true)
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700)
    expect(JSON.parse(await fs.readFile(file, 'utf8')).apiKey).toBe(KEY)
    expect(await readPriceAiKey()).toBe(KEY)
    // Nothing is left behind from the atomic write.
    expect(
      (await fs.readdir(path.dirname(file))).filter((name) =>
        name.endsWith('.tmp'),
      ),
    ).toEqual([])
    // A short key is not hinted at.
    expect((await writePriceAiKey('short-key')).last4).toBe('')
  })

  it('prefers the environment override', async () => {
    await writePriceAiKey(KEY)
    process.env[PRICE_AI_KEY_ENV] = ' env-key-0000000000wxyz '
    expect(await readPriceAiKey()).toBe('env-key-0000000000wxyz')
    expect(await getPriceAiKeyStatus()).toEqual({
      hasKey: true,
      last4: 'wxyz',
      source: 'env',
    })
  })

  it('sets, reports and removes the key through the API without returning it', async () => {
    const set = await keyRoute.POST(
      json('http://localhost/api/settings/price-ai-key', 'POST', {
        apiKey: KEY,
      }),
    )
    const setBody = await set.text()
    expect(set.status).toBe(200)
    expect(setBody).not.toContain(KEY)
    expect(JSON.parse(setBody)).toEqual({
      key: { hasKey: true, last4: '7f3a', source: 'file' },
    })

    const read = await keyRoute.GET(
      new Request('http://localhost/api/settings/price-ai-key'),
    )
    expect(await read.text()).not.toContain(KEY)

    const invalid = await keyRoute.POST(
      json('http://localhost/api/settings/price-ai-key', 'POST', {
        apiKey: 'has spaces in it',
      }),
    )
    expect(invalid.status).toBe(400)

    const removed = await keyRoute.DELETE(
      new Request('http://localhost/api/settings/price-ai-key', {
        method: 'DELETE',
      }),
    )
    expect(await removed.json()).toEqual({
      key: { hasKey: false, last4: '', source: null },
    })
    await expect(fs.stat(priceAiKeyPath())).rejects.toMatchObject({
      code: 'ENOENT',
    })

    process.env[PRICE_AI_KEY_ENV] = 'env-managed-key-123456'
    const managed = await keyRoute.POST(
      json('http://localhost/api/settings/price-ai-key', 'POST', {
        apiKey: KEY,
      }),
    )
    expect(managed.status).toBe(409)
  })
})

describe('AI settings routes', () => {
  it('saves AI settings through the settings API with partial merges', async () => {
    const response = await settingsRoute.POST(
      json('http://localhost/api/settings', 'POST', {
        priceMonitoring: {
          ai: { enabled: true, baseUrl: `${BASE_URL}/`, model: 'm1' },
        },
      }),
    )
    expect(response.status).toBe(200)
    expect(getSettings().priceMonitoring.ai).toEqual({
      enabled: true,
      baseUrl: BASE_URL,
      model: 'm1',
      extractionFallback: true,
      advisor: true,
      resolveErrors: true,
      vision: false,
      maxPageKb: 200,
      maxAnswerTokens: 16_384,
      usage: DEFAULT_PRICE_MONITORING.ai.usage,
      headers: {},
    })
    await settingsRoute.POST(
      json('http://localhost/api/settings', 'POST', {
        priceMonitoring: { ai: { advisor: false } },
      }),
    )
    expect(getSettings().priceMonitoring.ai).toMatchObject({
      enabled: true,
      model: 'm1',
      advisor: false,
    })
    expect(getSettings().priceMonitoring.notify).toEqual(
      DEFAULT_PRICE_MONITORING.notify,
    )
  })

  it('discovers models from the saved base URL with the stored or a one-time key', async () => {
    const discover = (body: unknown) =>
      modelsRoute.POST(
        json('http://localhost/api/settings/price-ai-models', 'POST', body),
      )
    expect((await discover({})).status).toBe(400)

    enableAi()
    await writePriceAiKey(KEY)
    aiFetch.mockResolvedValue(
      Response.json({ data: [{ id: 'b-model' }, { id: 'a-model' }] }),
    )
    const response = await discover({})
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(JSON.parse(text)).toEqual({ models: ['a-model', 'b-model'] })
    expect(text).not.toContain(KEY)
    expect(aiFetch.mock.calls[0][0]).toBe(`${BASE_URL}/models`)
    expect(
      new Headers(aiFetch.mock.calls[0][1]?.headers).get('Authorization'),
    ).toBe(`Bearer ${KEY}`)

    await discover({ apiKey: 'one-time-key-0000' })
    expect(
      new Headers(aiFetch.mock.calls[1][1]?.headers).get('Authorization'),
    ).toBe('Bearer one-time-key-0000')
    // The one-time key is not stored.
    expect(await readPriceAiKey()).toBe(KEY)

    aiFetch.mockResolvedValueOnce(
      Response.json({ error: { message: `bad key ${KEY}` } }, { status: 401 }),
    )
    const failed = await discover({})
    const failedText = await failed.text()
    expect(failed.status).toBe(502)
    expect(failedText).toContain('HTTP 401')
    expect(failedText).not.toContain(KEY)
  })

  it('tests the connection with a made-up page', async () => {
    enableAi()
    aiFetch.mockResolvedValueOnce(
      chat({
        price: '$123.45',
        currency: 'USD',
        availability: 'in_stock',
        confidence: 0.9,
      }),
    )
    const response = await testRoute.POST(
      json('http://localhost/api/settings/price-ai-test', 'POST', {}),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      price: 123.45,
      currency: 'USD',
      model: 'test-model',
    })
    const sent = JSON.parse(String(aiFetch.mock.calls[0][1]?.body))
    expect(sent.model).toBe('test-model')
    // No key stored: none is sent (local servers).
    expect(
      new Headers(aiFetch.mock.calls[0][1]?.headers).has('Authorization'),
    ).toBe(false)

    aiFetch.mockResolvedValueOnce(
      chat({
        price: '$149.00',
        currency: 'USD',
        availability: 'in_stock',
        confidence: 0.9,
      }),
    )
    const wrong = await testRoute.POST(
      json('http://localhost/api/settings/price-ai-test', 'POST', {
        model: 'other-model',
      }),
    )
    expect(await wrong.json()).toMatchObject({ ok: false, price: 149 })
  })
})

describe('AI extraction fallback in a check', () => {
  it('reads the price with AI when the parsers find none, once per day', async () => {
    enableAi()
    await writePriceAiKey(KEY)
    const { source } = await createKnife()

    browserPage(null)
    aiFetch.mockResolvedValueOnce(
      chat({
        price: '$118.50',
        currency: 'USD',
        availability: 'in_stock',
        confidence: 0.9,
      }),
    )
    const summary = await checkPriceSource(source.id, { trigger: 'manual' })
    expect(summary).toMatchObject({ status: 'done', outcome: 'ok' })
    expect(aiFetch).toHaveBeenCalledTimes(1)
    const sent = JSON.parse(String(aiFetch.mock.calls[0][1]?.body))
    expect(sent.messages[1].content).toContain('$118.50')

    expect(
      rows(
        'SELECT price_minor, currency, extraction_status, extraction_method FROM price_snapshots',
      ),
    ).toEqual([
      {
        price_minor: 11850,
        currency: 'USD',
        extraction_status: 'ai',
        extraction_method: 'ai',
      },
    ])
    expect(rows('SELECT method FROM price_check_log')).toEqual([
      { method: 'ai' },
    ])
    expect(rows('SELECT ai_used FROM price_monitor_daily')).toEqual([
      { ai_used: 1 },
    ])
    expect(
      rows('SELECT last_ai_at FROM price_sources WHERE id = ?', source.id)[0]
        .last_ai_at,
    ).toEqual(expect.any(String))

    // Within 24 hours AI is not asked again.
    browserPage(null)
    const second = await checkPriceSource(source.id, { trigger: 'manual' })
    expect(second).toMatchObject({
      outcome: 'no_price',
      errorCode: 'not_found',
    })
    expect(aiFetch).toHaveBeenCalledTimes(1)
  })

  it('asks AI again on the next check in Unlimited mode', async () => {
    enableAi({
      usage: { ...DEFAULT_PRICE_MONITORING.ai.usage, mode: 'unlimited' },
    })
    const { source } = await createKnife()
    const answer = {
      price: '$118.50',
      currency: 'USD',
      availability: 'in_stock',
      confidence: 0.9,
    }
    browserPage(null)
    aiFetch.mockResolvedValueOnce(chat(answer))
    await checkPriceSource(source.id, { trigger: 'manual' })
    browserPage(null)
    aiFetch.mockResolvedValueOnce(chat(answer))
    const second = await checkPriceSource(source.id, { trigger: 'manual' })
    expect(second).toMatchObject({ status: 'done', outcome: 'ok' })
    expect(aiFetch).toHaveBeenCalledTimes(2)
  })

  it('stops at the Limited daily budget without counting a refusal as AI use', async () => {
    installAiCallJournal()
    try {
      enableAi({
        usage: { ...DEFAULT_PRICE_MONITORING.ai.usage, dailyCalls: 1 },
      })
      const { source } = await createKnife()
      browserPage(null)
      aiFetch.mockResolvedValueOnce(
        chat({
          price: '$118.50',
          currency: 'USD',
          availability: 'in_stock',
          confidence: 0.9,
        }),
      )
      await checkPriceSource(source.id, { trigger: 'manual' })
      expect(aiFetch).toHaveBeenCalledTimes(1)
      expect(rows('SELECT purpose, ok FROM price_ai_calls')).toEqual([
        { purpose: 'extraction', ok: 1 },
      ])

      getLocalDb().prepare('UPDATE price_sources SET last_ai_at = NULL').run()
      browserPage(null)
      const refused = await checkPriceSource(source.id, { trigger: 'manual' })
      expect(refused).toMatchObject({ outcome: 'no_price' })
      expect(aiFetch).toHaveBeenCalledTimes(1)
      // Nothing was sent: no AI use recorded, no journal row, no wait.
      expect(
        rows('SELECT last_ai_at FROM price_sources WHERE id = ?', source.id)[0]
          .last_ai_at,
      ).toBeNull()
      expect(rows('SELECT COUNT(*) AS count FROM price_ai_calls')).toEqual([
        { count: 1 },
      ])
      const log = rows(
        'SELECT error_message FROM price_check_log ORDER BY id DESC LIMIT 1',
      )[0].error_message as string
      expect(log).toContain('daily AI budget is used up')
    } finally {
      setAiCallObserver(null)
      setAiBudgetGate(null)
    }
  })

  it('stores nothing from an untrusted answer and never asks AI when parsers work', async () => {
    enableAi()
    const { source } = await createKnife()

    browserPage(null)
    aiFetch.mockResolvedValueOnce(
      chat({
        price: '$99.00',
        currency: 'USD',
        availability: 'in_stock',
        confidence: 0.99,
      }),
    )
    const rejected = await checkPriceSource(source.id, { trigger: 'manual' })
    expect(rejected).toMatchObject({ outcome: 'no_price' })
    expect(rows('SELECT COUNT(*) AS n FROM price_snapshots')).toEqual([
      { n: 0 },
    ])
    expect(
      rows('SELECT error_message FROM price_check_log')[0].error_message,
    ).toContain('not on the page')

    getLocalDb().prepare('UPDATE price_sources SET last_ai_at = NULL').run()
    browserPage({
      amount: 120,
      currency: 'USD',
      availability: 'in_stock',
      method: 'jsonld',
    })
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(aiFetch).toHaveBeenCalledTimes(1)
  })

  it('keeps checks working when the AI endpoint fails or AI is off', async () => {
    enableAi()
    await writePriceAiKey(KEY)
    const { source } = await createKnife()
    browserPage(null)
    aiFetch.mockRejectedValueOnce(new TypeError('fetch failed'))
    const failed = await checkPriceSource(source.id, { trigger: 'manual' })
    expect(failed).toMatchObject({
      outcome: 'no_price',
      errorCode: 'not_found',
    })
    const message = String(
      rows('SELECT error_message FROM price_check_log')[0].error_message,
    )
    expect(message).toContain('Could not reach the AI endpoint')
    expect(message).not.toContain(KEY)

    enableAi({ enabled: false })
    getLocalDb().prepare('UPDATE price_sources SET last_ai_at = NULL').run()
    browserPage(null)
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(aiFetch).toHaveBeenCalledTimes(1)
  })
})

describe('AI troubleshooting of failed checks', () => {
  function sourceRow(id: number) {
    return rows(
      'SELECT enabled, next_check_at, last_ai_at FROM price_sources WHERE id = ?',
      id,
    )[0]
  }

  it('recovers from a bot check within bounds and explains it in the log', async () => {
    enableAi()
    await writePriceAiKey(KEY)
    const { source } = await createKnife('Secret Raccoon Knife')
    await saveBrowserState(source.lane_key, { cookies: [], origins: [] })

    mocks.browser.mockRejectedValueOnce(new ScrapeError('challenge'))
    aiFetch.mockResolvedValueOnce(
      chat({
        resetCookies: true,
        useBrowser: false,
        // Sooner than the backoff: raised to it.
        retryInMinutes: 5,
        pauseSource: false,
        explanation: 'The store showed a bot check; cookies were reset.',
      }),
    )
    const before = Date.now()
    const summary = await checkPriceSource(source.id, { trigger: 'manual' })
    expect(summary).toMatchObject({
      status: 'done',
      outcome: 'blocked',
      errorCode: 'challenge',
    })
    expect(aiFetch).toHaveBeenCalledTimes(1)
    const sent = String(aiFetch.mock.calls[0][1]?.body)
    expect(sent).toContain('shop.example')
    expect(sent).not.toContain(PRODUCT_URL)
    expect(sent).not.toContain('Raccoon')
    expect(sent).not.toContain(KEY)

    expect(
      String(
        rows('SELECT error_message FROM price_check_log')[0].error_message,
      ),
    ).toContain('AI: The store showed a bot check; cookies were reset.')
    const row = sourceRow(source.id)
    expect(row.last_ai_at).toEqual(expect.any(String))
    // The default backoff after a first failure is the 24 h frequency.
    expect(Date.parse(String(row.next_check_at))).toBeGreaterThanOrEqual(
      before + 24 * 60 * 60 * 1000 - 1000,
    )
    expect(await loadBrowserState(source.lane_key)).toBeUndefined()

    // Within 24 hours AI is not asked again.
    mocks.browser.mockRejectedValueOnce(new ScrapeError('challenge'))
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(aiFetch).toHaveBeenCalledTimes(1)
  })

  it('pins the store to the browser and pauses a gone page', async () => {
    enableAi()
    const { source } = await createKnife()
    getLocalDb()
      .prepare('UPDATE price_sources SET consecutive_failures = 1 WHERE id = ?')
      .run(source.id)
    mocks.browser.mockRejectedValueOnce(
      new ScrapeError('http', 'The store returned HTTP 404.'),
    )
    aiFetch.mockResolvedValueOnce(
      chat({
        resetCookies: true,
        useBrowser: true,
        retryInMinutes: null,
        pauseSource: true,
        explanation: 'The product page no longer exists.',
      }),
    )
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(sourceRow(source.id).enabled).toBe(0)
    expect(
      String(
        rows('SELECT error_message FROM price_check_log')[0].error_message,
      ),
    ).toContain('AI paused this source')
    expect(
      rows(
        'SELECT strategy FROM price_host_state WHERE lane_key = ?',
        source.lane_key,
      ),
    ).toEqual([{ strategy: 'browser_first' }])
  })

  it('keeps the normal failure handling when AI fails, is off or cannot help', async () => {
    enableAi()
    await writePriceAiKey(KEY)
    const { source } = await createKnife()
    mocks.browser.mockRejectedValueOnce(new ScrapeError('timeout'))
    aiFetch.mockRejectedValueOnce(new TypeError('fetch failed'))
    const failed = await checkPriceSource(source.id, { trigger: 'manual' })
    expect(failed).toMatchObject({ outcome: 'failed', errorCode: 'timeout' })
    const message = String(
      rows('SELECT error_message FROM price_check_log')[0].error_message,
    )
    expect(message).toContain('AI troubleshooting: Could not reach')
    expect(message).not.toContain(KEY)

    getLocalDb().prepare('UPDATE price_sources SET last_ai_at = NULL').run()
    mocks.browser.mockRejectedValueOnce(new ScrapeError('browser'))
    await checkPriceSource(source.id, { trigger: 'manual' })
    enableAi({ resolveErrors: false })
    mocks.browser.mockRejectedValueOnce(new ScrapeError('challenge'))
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(aiFetch).toHaveBeenCalledTimes(1)
  })
})

describe('AI problem solver in a check', () => {
  const NO_PRICE = `<html><head><title>Raccoon</title></head><body><h1>Raccoon</h1>
<div class="cookie-banner"><button id="accept">Accept cookies</button></div></body></html>`
  const PRICED = `<html><head><title>Raccoon</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Raccoon","offers":{"@type":"Offer","price":"118.50","priceCurrency":"USD","availability":"https://schema.org/InStock"}}</script>
</head><body><h1>Raccoon</h1></body></html>`

  /** Each browser reading renders a page where #accept reveals the price. */
  function storeWithCookieWall() {
    const clicks: string[] = []
    mocks.browser.mockImplementation(
      async (
        url: string,
        operation: unknown,
        options: {
          interact?: (page: SolverPage, op: unknown) => Promise<void>
        },
      ) => {
        let html = NO_PRICE
        const page = {
          url: () => url,
          content: async () => html,
          evaluate: async (_fn: unknown, arg?: unknown) =>
            typeof arg === 'number' && html === NO_PRICE
              ? [
                  {
                    tag: 'button',
                    text: 'Accept cookies',
                    selector: '#accept',
                    inDialog: true,
                    submit: false,
                  },
                ]
              : typeof arg === 'number'
                ? []
                : undefined,
          locator: (selector: string) => ({
            first: () => ({
              innerText: async () => 'Accept cookies',
              click: async () => {
                clicks.push(selector)
                if (selector === '#accept') html = PRICED
              },
            }),
          }),
          waitForTimeout: async () => {},
          waitForLoadState: async () => {},
          keyboard: { press: async () => {} },
        } as unknown as SolverPage
        if (options.interact) await options.interact(page, operation)
        return {
          offer: extractOfferFromHtml(html, url),
          serverOffer: null,
          finalUrl: url,
          isShopify: false,
          html,
        }
      },
    )
    return clicks
  }

  it('solves a cookie wall, remembers the recipe and replays it without AI', async () => {
    enableAi({ extractionFallback: false })
    const { source } = await createKnife()
    const clicks = storeWithCookieWall()
    aiFetch.mockResolvedValueOnce(
      chat({
        action: 'click',
        target: 0,
        value: null,
        seconds: null,
        price: null,
        currency: null,
        availability: 'unknown',
        confidence: 0,
        reason: 'A cookie banner hides the page.',
      }),
    )
    const first = await checkPriceSource(source.id, { trigger: 'manual' })
    expect(first).toMatchObject({ status: 'done', outcome: 'ok' })
    expect(aiFetch).toHaveBeenCalledTimes(1)
    const log = rows('SELECT method, solver_steps FROM price_check_log')[0]
    expect(log.method).toBe('solver')
    expect(JSON.parse(String(log.solver_steps))).toEqual([
      { action: 'click', detail: 'Accept cookies', result: 'clicked' },
    ])
    expect(
      JSON.parse(
        String(
          rows(
            'SELECT solver_recipe FROM price_host_state WHERE lane_key = ?',
            source.lane_key,
          )[0].solver_recipe,
        ),
      ),
    ).toEqual([
      { action: 'click', selector: '#accept', label: 'Accept cookies' },
    ])
    expect(rows('SELECT price_minor FROM price_snapshots')).toEqual([
      { price_minor: 11850 },
    ])

    // Next check: the recipe runs first, no AI call.
    const second = await checkPriceSource(source.id, { trigger: 'manual' })
    expect(second).toMatchObject({ outcome: 'ok' })
    expect(aiFetch).toHaveBeenCalledTimes(1)
    expect(clicks).toEqual(['#accept', '#accept'])
  })

  it('stays off with the switch off and logs what it tried when it fails', async () => {
    enableAi({ extractionFallback: false, resolveErrors: false })
    const { source } = await createKnife()
    browserPage(null)
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(aiFetch).not.toHaveBeenCalled()

    enableAi({ extractionFallback: false })
    storeWithCookieWall()
    aiFetch.mockResolvedValueOnce(
      chat({
        action: 'give_up',
        target: null,
        value: null,
        seconds: null,
        price: null,
        currency: null,
        availability: 'unknown',
        confidence: 0,
        reason: 'The price is not shown.',
      }),
    )
    const result = await checkPriceSource(source.id, { trigger: 'manual' })
    expect(result).toMatchObject({
      outcome: 'no_price',
      errorCode: 'not_found',
    })
    expect(
      String(
        rows('SELECT error_message FROM price_check_log ORDER BY id DESC')[0]
          .error_message,
      ),
    ).toContain('AI gave up: The price is not shown.')
  })
})

describe('Needs attention in the Inbox', () => {
  it('lists a newly blocked store once and resolves when it reads again', async () => {
    const { source } = await createKnife('Secret Raccoon')
    mocks.browser.mockRejectedValueOnce(new ScrapeError('challenge'))
    await checkPriceSource(source.id, { trigger: 'manual' })
    let messages = (await getSystemMessages()).filter(
      (row) => row.kind === 'price-attention',
    )
    expect(messages).toHaveLength(1)
    expect(messages[0].title).toBe('A price check needs attention')
    expect(messages[0].detail).toContain(
      'Vosteed Secret Raccoon at shop.example',
    )
    expect(messages[0].detail).toContain('solve the bot check')

    // Still blocked: no new notification.
    mocks.browser.mockRejectedValueOnce(new ScrapeError('challenge'))
    await checkPriceSource(source.id, { trigger: 'manual' })
    messages = (await getSystemMessages()).filter(
      (row) => row.kind === 'price-attention',
    )
    expect(messages[0].occurrences).toBe(1)

    browserPage({
      amount: 120,
      currency: 'USD',
      availability: 'in_stock',
      method: 'jsonld',
    })
    await checkPriceSource(source.id, { trigger: 'manual' })
    messages = (await getSystemMessages()).filter(
      (row) => row.kind === 'price-attention',
    )
    expect(messages[0].resolvedAt).toEqual(expect.any(String))
  })
})

describe('Solve in browser', () => {
  it('keeps the window cookies for the store and queues a check', async () => {
    const { source } = await createKnife()
    mocks.exportSession.mockResolvedValueOnce({
      finalUrl: 'https://www.shop.example/products/raccoon',
      storageState: { cookies: [], origins: [] },
    })
    const response = await solveRoute.POST(
      json(`http://localhost/api/prices/sources/${source.id}/solve`, 'POST', {
        sessionId: 'abc',
      }),
      { params: Promise.resolve({ id: String(source.id) }) },
    )
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({
      saved: true,
      queued: [source.id],
    })
    expect(await loadBrowserState(source.lane_key)).toEqual({
      cookies: [],
      origins: [],
    })
    await getPriceMonitorWorker().stop()
  })

  it('refuses cookies from another site and reports a bot check still open', async () => {
    const { source } = await createKnife()
    const call = () =>
      solveRoute.POST(
        json(`http://localhost/api/prices/sources/${source.id}/solve`, 'POST', {
          sessionId: 'abc',
        }),
        { params: Promise.resolve({ id: String(source.id) }) },
      )
    mocks.exportSession.mockResolvedValueOnce({
      finalUrl: 'https://login.other.example/',
      storageState: { cookies: [], origins: [] },
    })
    expect((await call()).status).toBe(409)
    expect(await loadBrowserState(source.lane_key)).toBeUndefined()

    mocks.exportSession.mockRejectedValueOnce(new ScrapeError('challenge'))
    const blocked = await call()
    expect(await blocked.json()).toMatchObject({ code: 'challenge' })
  })
})

describe('AI pacing advisor', () => {
  async function seedChecks() {
    const { source } = await createKnife('Secret Raccoon Knife')
    browserPage({
      amount: 129,
      currency: 'USD',
      availability: 'in_stock',
      method: 'jsonld',
    })
    await checkPriceSource(source.id, { trigger: 'manual' })
    return source
  }

  it('sends statistics without URLs or names and applies clamped advice', async () => {
    await seedChecks()
    enableAi()
    await writePriceAiKey(KEY)
    aiFetch.mockResolvedValueOnce(
      chat({
        stores: [
          {
            store: 'shop.example',
            minGapSeconds: 1800,
            cooldownMinutes: 99_999,
            quietHours: { start: 20, end: 23 },
            strategy: 'keep',
            reason: 'Blocks cluster in the evening.',
          },
          {
            store: 'not-ours.example',
            minGapSeconds: 10,
            cooldownMinutes: null,
            quietHours: null,
            strategy: null,
            reason: 'x',
          },
        ],
      }),
    )
    const now = Date.now()
    const result = await runPriceAdvisor({ trigger: 'manual', now })
    expect(result).toMatchObject({ status: 'done' })

    const body = String(aiFetch.mock.calls[0][1]?.body)
    const sent = JSON.parse(JSON.parse(body).messages[1].content)
    expect(sent.stores).toEqual([
      expect.objectContaining({ store: 'shop.example', checks: 1, sources: 1 }),
    ])
    expect(body).not.toContain('/products/')
    expect(body).not.toContain('https://')
    expect(body).not.toContain('Raccoon')
    expect(body).not.toContain(KEY.slice(3))

    const active = readActiveAdvice(getLocalDb(), now)
    expect([...active.keys()]).toEqual(['shop.example'])
    expect(active.get('shop.example')).toMatchObject({
      minGapMs: 1_800_000,
      pauseUntil: now + 48 * 60 * 60 * 1000,
      quietHours: [20, 23],
      reason: 'Blocks cluster in the evening.',
    })

    const lane = buildQueueSnapshot(now).lanes.find(
      (entry) => entry.laneKey === 'shop.example',
    )
    expect(lane?.minGapMs).toBe(1_800_000)
    expect(lane?.advice).toMatchObject({ quietHours: [20, 23] })

    const activity = await activityRoute.GET(
      new Request('http://localhost/api/prices/activity'),
    )
    const history = (await activity.json()) as {
      advice: Array<{ trigger: string; lanes: unknown[]; error: unknown }>
    }
    expect(history.advice[0]).toMatchObject({
      trigger: 'manual',
      error: null,
      lanes: [expect.objectContaining({ laneKey: 'shop.example' })],
    })

    // Expired advice no longer applies.
    expect(readActiveAdvice(getLocalDb(), now + 49 * 60 * 60 * 1000).size).toBe(
      0,
    )
  })

  it('never shortens an open circuit', async () => {
    const source = await seedChecks()
    enableAi()
    const now = Date.now()
    await writeLaneState(
      {
        laneKey: source.lane_key,
        minGapMs: 60_000,
        readyAt: now + 8 * 60 * 60 * 1000,
        circuit: 'open',
        cooldownUntil: now + 8 * 60 * 60 * 1000,
        openCount: 3,
        successStreak: 0,
        failureStreak: 0,
        lastRequestAt: now,
      },
      getVaultAccessState().generation,
    )
    aiFetch.mockResolvedValueOnce(
      chat({
        stores: [
          {
            store: 'shop.example',
            minGapSeconds: 120,
            cooldownMinutes: 5,
            quietHours: null,
            strategy: null,
            reason: 'Try again soon.',
          },
        ],
      }),
    )
    await runPriceAdvisor({ trigger: 'repeated_blocks', now })
    const lane = buildQueueSnapshot(now).lanes.find(
      (entry) => entry.laneKey === 'shop.example',
    )
    expect(lane?.circuit).toBe('open')
    expect(lane?.cooldownUntil).toBe(
      new Date(now + 8 * 60 * 60 * 1000).toISOString(),
    )
  })

  it('records a failed call and keeps the previous pacing', async () => {
    await seedChecks()
    enableAi()
    aiFetch.mockResolvedValueOnce(
      Response.json({ error: { message: 'overloaded' } }, { status: 503 }),
    )
    const result = await runPriceAdvisor({ trigger: 'daily' })
    expect(result).toMatchObject({ status: 'failed' })
    expect(
      rows('SELECT trigger, error, applied FROM price_regulator_advice'),
    ).toEqual([
      {
        trigger: 'daily',
        error: expect.stringContaining('HTTP 503'),
        applied: null,
      },
    ])
    expect(readActiveAdvice(getLocalDb(), Date.now()).size).toBe(0)
  })

  it('does nothing without AI, and the route says why', async () => {
    await seedChecks()
    expect(await runPriceAdvisor({ trigger: 'daily' })).toEqual({
      status: 'skipped',
      reason: 'disabled',
    })
    const response = await advisorRoute.POST(
      new Request('http://localhost/api/prices/advisor', { method: 'POST' }),
    )
    expect(response.status).toBe(409)
    enableAi({ advisor: false })
    expect(await runPriceAdvisor({ trigger: 'manual' })).toMatchObject({
      reason: 'disabled',
    })
    expect(aiFetch).not.toHaveBeenCalled()
  })
})
