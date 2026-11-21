import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as knivesRoute from '@/app/api/knives/route'
import * as powerRoute from '@/app/api/prices/power/route'
import { getLocalDb } from '@/lib/local-db'
import {
  AiClientError,
  requestJsonCompletion,
} from '@/lib/price-monitor/ai-client'
import {
  installAiCallJournal,
  readAiCallSummary,
} from '@/lib/price-monitor/ai-journal'
import { readDigestData } from '@/lib/price-monitor/digest'
import { checkPriceSource } from '@/lib/price-monitor/engine'
import {
  RESUME_WARMUP_MS,
  monitorHoldMs,
  notePowerSuspend,
  resetPowerState,
} from '@/lib/price-monitor/power'
import { readActiveSources } from '@/lib/price-monitor/store'
import { getPriceMonitorWorker } from '@/lib/price-monitor/worker'
import { ScrapeError } from '@/lib/scrape-errors'
import type { ExtractedOffer } from '@/lib/scrape-offer'
import { getSettings, saveSettings } from '@/lib/settings'
import { DEFAULT_PRICE_MONITORING } from '@/lib/settings-shared'
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

const BASE_URL = 'http://ai.local.test/v1'
const NO_PRICE = '<html><body><h1>Raccoon</h1></body></html>'

let vault: TempVault
let aiFetch: ReturnType<typeof vi.fn<typeof fetch>>

beforeEach(async () => {
  vault = await createTempVault()
  vi.resetAllMocks()
  aiFetch = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', aiFetch)
  resetPowerState({ settleMs: 50, hasNetworkInterface: () => true })
})
afterEach(async () => {
  vi.unstubAllGlobals()
  resetPowerState()
  await getPriceMonitorWorker().stop()
  await vault.cleanup()
})

function rows(sql: string, ...args: unknown[]) {
  return getLocalDb()
    .prepare(sql)
    .all(...args) as Array<Record<string, unknown>>
}

function enableAi() {
  saveSettings({
    priceMonitoring: {
      ...getSettings().priceMonitoring,
      ai: {
        ...DEFAULT_PRICE_MONITORING.ai,
        enabled: true,
        baseUrl: BASE_URL,
        model: 'test-model',
      },
    },
  })
}

async function createKnife(url: string, price = '129.00 USD') {
  const response = await knivesRoute.POST(
    new Request('http://localhost/api/knives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Raccoon',
        brand: 'Vosteed',
        specs: { price },
        sourceUrl: url,
      }),
    }),
  )
  const id = ((await response.json()) as { knife: { id: string } }).knife.id
  const { syncAutoSource } = await import('@/lib/price-monitor/store')
  const { getStorage } = await import('@/lib/storage')
  await syncAutoSource((await getStorage().getKnifeById(id))!)
  return readActiveSources(getLocalDb(), id)[0]
}

function page(offer: ExtractedOffer | null, url: string, html = NO_PRICE) {
  return { offer, serverOffer: null, finalUrl: url, isShopify: false, html }
}

const sourceState = (id: number) =>
  rows(
    `SELECT status, consecutive_failures, last_ai_at, next_check_at
     FROM price_sources WHERE id = ?`,
    id,
  )[0]

describe('local network outages', () => {
  it('blames a store that fails alone', async () => {
    const source = await createKnife('https://bokerusa.example/p/raccoon')
    mocks.browser.mockRejectedValueOnce(new ScrapeError('network'))
    const summary = await checkPriceSource(source.id, { trigger: 'manual' })
    expect(summary).toMatchObject({ status: 'done', errorCode: 'network' })
    expect(sourceState(source.id)).toMatchObject({
      status: 'failed',
      consecutive_failures: 1,
    })
  })

  it('defers checks at several stores failing together without counting them', async () => {
    const boker = await createKnife('https://bokerusa.example/p/raccoon')
    const vosteed = await createKnife('https://vosteed.example/p/raccoon')
    mocks.browser.mockRejectedValue(new ScrapeError('network'))
    const before = Date.now()
    const [first, second] = await Promise.all([
      checkPriceSource(boker.id, { trigger: 'scheduled' }),
      checkPriceSource(vosteed.id, { trigger: 'scheduled' }),
    ])
    expect(first).toEqual({ status: 'deferred', reason: 'offline' })
    expect(second).toEqual({ status: 'deferred', reason: 'offline' })
    for (const source of [boker, vosteed]) {
      const state = sourceState(source.id)
      expect(state).toMatchObject({
        status: source.status,
        consecutive_failures: 0,
      })
      expect(Date.parse(String(state.next_check_at))).toBeGreaterThan(before)
    }
    // Nothing reaches the check log, the daily rollup or the stores' state.
    expect(rows('SELECT id FROM price_check_log')).toEqual([])
    expect(rows('SELECT day FROM price_monitor_daily')).toEqual([])
    expect(rows('SELECT lane_key FROM price_host_state')).toEqual([])
    expect(monitorHoldMs()).toBeGreaterThan(0)
  })

  it('defers a store failure while the AI host fails DNS', async () => {
    enableAi()
    // The AI fallback reads a page without a price and cannot reach AI.
    const first = await createKnife('https://vosteed.example/p/raccoon')
    mocks.browser.mockResolvedValueOnce(
      page(null, 'https://vosteed.example/p/raccoon'),
    )
    aiFetch.mockRejectedValueOnce(
      new TypeError('fetch failed', {
        cause: new Error('getaddrinfo ENOTFOUND opencode.ai'),
      }),
    )
    const read = await checkPriceSource(first.id, { trigger: 'manual' })
    expect(read).toMatchObject({ status: 'done', errorCode: 'not_found' })

    const other = await createKnife('https://bokerusa.example/p/raccoon')
    mocks.browser.mockRejectedValueOnce(new ScrapeError('network'))
    const summary = await checkPriceSource(other.id, { trigger: 'manual' })
    expect(summary).toEqual({ status: 'deferred', reason: 'offline' })
    expect(sourceState(other.id)).toMatchObject({ consecutive_failures: 0 })
  })
})

describe('AI that could not be reached', () => {
  it('does not start the source AI pause', async () => {
    enableAi()
    const source = await createKnife('https://vosteed.example/p/raccoon')
    mocks.browser.mockResolvedValueOnce(
      page(null, 'https://vosteed.example/p/raccoon'),
    )
    aiFetch.mockRejectedValueOnce(new TypeError('fetch failed'))
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(aiFetch).toHaveBeenCalledTimes(1)
    expect(sourceState(source.id).last_ai_at).toBeNull()
    expect(rows('SELECT ai_used FROM price_monitor_daily')).toEqual([
      { ai_used: 0 },
    ])
  })
})

describe('sleep', () => {
  it('stops an AI call in flight on suspend and records it as neutral', async () => {
    installAiCallJournal()
    aiFetch.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
          setTimeout(() => notePowerSuspend(), 10)
        }),
    )
    const call = requestJsonCompletion(
      { baseUrl: BASE_URL, apiKey: null },
      {
        model: 'test-model',
        system: 'plan',
        user: 'data',
        schemaName: 'plan',
        purpose: 'agent',
        schema: { type: 'object', properties: {}, required: [] },
      },
      { timeoutMs: 60_000 },
    )
    await expect(call).rejects.toMatchObject({
      name: 'AiClientError',
      code: 'suspended',
    } satisfies Partial<AiClientError>)
    expect(aiFetch).toHaveBeenCalledTimes(1)
    expect(rows('SELECT ok, error_code FROM price_ai_calls')).toEqual([
      { ok: 0, error_code: 'suspended' },
    ])
    const summary = readAiCallSummary(getLocalDb())
    expect(summary).toMatchObject({ calls: 1, failed: 0, lastError: null })
  })

  it('defers a check the computer slept through', async () => {
    const source = await createKnife('https://vosteed.example/p/raccoon')
    mocks.browser.mockImplementationOnce(async () => {
      notePowerSuspend()
      throw new ScrapeError('timeout')
    })
    const summary = await checkPriceSource(source.id, { trigger: 'scheduled' })
    expect(summary).toEqual({ status: 'deferred', reason: 'suspended' })
    expect(sourceState(source.id)).toMatchObject({ consecutive_failures: 0 })
    expect(rows('SELECT id FROM price_check_log')).toEqual([])
  })

  it('takes suspend and resume notices from the desktop app', async () => {
    const post = (body: unknown) =>
      powerRoute.POST(
        new Request('http://localhost/api/prices/power', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )
    expect((await post({ state: 'nap' })).status).toBe(400)
    expect((await post({ state: 'suspend' })).status).toBe(200)
    expect(monitorHoldMs()).toBeGreaterThan(0)
    expect((await post({ state: 'resume' })).status).toBe(200)
    const hold = monitorHoldMs()
    expect(hold).toBeGreaterThan(RESUME_WARMUP_MS - 5_000)
    expect(hold).toBeLessThanOrEqual(RESUME_WARMUP_MS)
  })
})

describe('digest headlines', () => {
  it('leaves out a deal that is suspect against the stored regular price', async () => {
    const url = 'https://vosteed.example/p/gmf1'
    // A bad stored regular price: $7,559 for a $300 knife.
    const source = await createKnife(url, '7559.00 USD')
    const offer = (amount: number): ExtractedOffer => ({
      amount,
      currency: 'USD',
      availability: 'in_stock',
      method: 'jsonld',
    })
    mocks.browser.mockResolvedValueOnce(page(offer(320), url))
    await checkPriceSource(source.id, { trigger: 'manual' })
    mocks.browser.mockResolvedValueOnce(page(offer(300), url))
    await checkPriceSource(source.id, { trigger: 'manual' })
    const data = readDigestData(getLocalDb())
    expect(data.deals).toEqual([])
    expect(data.drops).toEqual([])
  })
})
