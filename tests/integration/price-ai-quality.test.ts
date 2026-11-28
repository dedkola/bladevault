import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as knivesRoute from '@/app/api/knives/route'
import { getLocalDb } from '@/lib/local-db'
import {
  setAiBudgetGate,
  setAiCallObserver,
} from '@/lib/price-monitor/ai-client'
import { installAiCallJournal } from '@/lib/price-monitor/ai-journal'
import {
  readDigestData,
  resetPriceDigestState,
  runPriceDigest,
} from '@/lib/price-monitor/digest'
import { checkPriceSource } from '@/lib/price-monitor/engine'
import { readActiveSources } from '@/lib/price-monitor/store'
import { getPriceMonitorWorker } from '@/lib/price-monitor/worker'
import { getSettings, saveSettings } from '@/lib/settings'
import { DEFAULT_PRICE_MONITORING } from '@/lib/settings-shared'
import type { ExtractedOffer } from '@/lib/scrape-offer'
import { getSystemMessages } from '@/lib/system-message-store'
import { runAttentionSummary } from '@/lib/price-monitor/attention'
import {
  applyAttentionAction,
  readAttentionList,
} from '@/lib/price-monitor/attention-actions'
import { getVaultAccessState } from '@/lib/vault-access'
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

const BASE_URL = 'http://ai.local.test/v1'
const PRODUCT_URL = 'https://shop.example/products/raccoon'
const NOTE = 'Bought from my uncle, private note'
const pageWith = (price: string) => `<html><head><title>Raccoon</title></head>
<body><div class="product"><span class="price-now">${price}</span>
<p class="stock">In stock</p></div>
<div class="related"><span class="price">$118.50</span> Raccoon knife</div>
<div class="addon"><span class="price">$90.00</span> Raccoon sheath</div>
</body></html>`

let vault: TempVault
let aiFetch: ReturnType<typeof vi.fn<typeof fetch>>

beforeEach(async () => {
  vault = await createTempVault()
  monitorWholeCollection()
  vi.resetAllMocks()
  aiFetch = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', aiFetch)
  resetPriceDigestState()
})
afterEach(async () => {
  vi.unstubAllGlobals()
  setAiBudgetGate(null)
  setAiCallObserver(null)
  await getPriceMonitorWorker().stop()
  await vault.cleanup()
})

function chat(content: unknown) {
  return Response.json({
    choices: [{ message: { content: JSON.stringify(content) } }],
  })
}

function enableAi(
  patch: Partial<typeof DEFAULT_PRICE_MONITORING.ai> = {},
  monitoring: Partial<typeof DEFAULT_PRICE_MONITORING> = {},
) {
  saveSettings({
    priceMonitoring: {
      ...getSettings().priceMonitoring,
      ...monitoring,
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

function unlimited() {
  return { ...DEFAULT_PRICE_MONITORING.ai.usage, mode: 'unlimited' as const }
}

function rows(sql: string, ...args: unknown[]) {
  return getLocalDb()
    .prepare(sql)
    .all(...args) as Array<Record<string, unknown>>
}

async function createKnife(
  extra: { specs?: Record<string, string>; handleMaterial?: string } = {},
) {
  const response = await knivesRoute.POST(
    new Request('http://localhost/api/knives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Raccoon',
        brand: 'Vosteed',
        description: NOTE,
        ...(extra.handleMaterial
          ? { handleMaterial: extra.handleMaterial }
          : {}),
        specs: {
          price: '129.00 USD',
          bladeLength: '3.3 in',
          bladeMaterial: 'Nitro-V',
          ...extra.specs,
        },
        sourceUrl: PRODUCT_URL,
      }),
    }),
  )
  const id = ((await response.json()) as { knife: { id: string } }).knife.id
  const { syncAutoSource } = await import('@/lib/price-monitor/store')
  const { getStorage } = await import('@/lib/storage')
  await syncAutoSource((await getStorage().getKnifeById(id))!)
  return { id, source: readActiveSources(getLocalDb(), id)[0] }
}

function offer(amount: number): ExtractedOffer {
  return { amount, currency: 'USD', availability: 'in_stock', method: 'jsonld' }
}

function browserReads(
  amount: number,
  html = pageWith(`$${amount.toFixed(2)}`),
) {
  mocks.browser.mockResolvedValueOnce({
    offer: offer(amount),
    serverOffer: null,
    finalUrl: PRODUCT_URL,
    isShopify: false,
    html,
  })
}

const sourceRow = (id: number) =>
  rows(
    `SELECT status, last_price_minor, last_error_code, last_error
     FROM price_sources WHERE id = ?`,
    id,
  )[0]

const lastLog = () =>
  rows(
    `SELECT outcome, error_code, error_message FROM price_check_log
     ORDER BY id DESC LIMIT 1`,
  )[0]

const requestBody = (index: number) =>
  String((aiFetch.mock.calls[index]?.[1] as RequestInit | undefined)?.body)

const reject = {
  verdict: 'rejected',
  issue: 'accessory',
  pagePrice: '$118.50',
  confidence: 0.95,
  reason: '$90.00 is the price of the sheath.',
}
const confirm = {
  verdict: 'confirmed',
  issue: 'none',
  pagePrice: '$90.00',
  confidence: 0.9,
  reason: 'The product price is $90.00.',
}

describe('Confirm price changes before notifying', () => {
  it('keeps a rejected change as unconfirmed, without event or notification', async () => {
    installAiCallJournal()
    enableAi()
    const { source } = await createKnife()
    browserReads(118.5)
    await checkPriceSource(source.id, { trigger: 'manual' })
    // Limited mode: a first reading is not checked by AI.
    expect(aiFetch).not.toHaveBeenCalled()

    browserReads(90)
    aiFetch.mockResolvedValueOnce(chat(reject))
    const summary = await checkPriceSource(source.id, { trigger: 'manual' })
    expect(summary).toMatchObject({ status: 'done', outcome: 'ok' })
    expect(aiFetch).toHaveBeenCalledTimes(1)

    const body = requestBody(0)
    expect(body).toContain('Vosteed')
    expect(body).toContain('Raccoon')
    expect(body).toContain('Nitro-V')
    expect(body).toContain('shop.example')
    // Never the regular price or notes.
    expect(body).not.toContain('129')
    expect(body).not.toContain(NOTE)

    expect(rows('SELECT * FROM price_change_events')).toEqual([])
    expect(rows('SELECT * FROM price_notifications')).toEqual([])
    expect(
      rows('SELECT price_minor, ai_review FROM price_snapshots ORDER BY id'),
    ).toEqual([
      { price_minor: 11850, ai_review: null },
      { price_minor: 9000, ai_review: 'unconfirmed' },
    ])
    // The source keeps its last trusted price.
    expect(sourceRow(source.id)).toMatchObject({
      status: 'ok',
      last_price_minor: 11850,
      last_error_code: 'ai_unconfirmed',
    })
    expect(lastLog()).toMatchObject({
      outcome: 'ok',
      error_code: 'ai_unconfirmed',
    })
    expect(lastLog().error_message).toContain(
      'AI could not confirm this price: the price is for an accessory',
    )
    expect(lastLog().error_message).toContain('the page shows $118.50')
    expect(rows('SELECT purpose, ok FROM price_ai_calls')).toEqual([
      { purpose: 'verify', ok: 1 },
    ])

    // The same doubtful price is checked again and extends its snapshot.
    browserReads(90)
    aiFetch.mockResolvedValueOnce(chat(reject))
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(aiFetch).toHaveBeenCalledTimes(2)
    expect(
      rows(
        `SELECT observations FROM price_snapshots
         WHERE ai_review = 'unconfirmed'`,
      ),
    ).toEqual([{ observations: 2 }])

    // The true price coming back is no change and needs no AI.
    browserReads(118.5)
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(aiFetch).toHaveBeenCalledTimes(2)
    expect(rows('SELECT * FROM price_change_events')).toEqual([])
    expect(sourceRow(source.id)).toMatchObject({
      status: 'ok',
      last_price_minor: 11850,
      last_error_code: null,
    })
  })

  it('notifies a confirmed change and marks its snapshot', async () => {
    enableAi()
    const { source } = await createKnife()
    browserReads(118.5)
    await checkPriceSource(source.id, { trigger: 'manual' })
    browserReads(90)
    aiFetch.mockResolvedValueOnce(chat(confirm))
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(rows('SELECT kind FROM price_notifications')).toEqual([
      { kind: 'drop' },
    ])
    expect(
      rows('SELECT ai_review FROM price_snapshots ORDER BY id DESC LIMIT 1'),
    ).toEqual([{ ai_review: 'confirmed' }])
    expect(sourceRow(source.id)).toMatchObject({
      last_price_minor: 9000,
      last_error_code: null,
    })
  })

  it('does not ask AI about a change below the notification threshold', async () => {
    enableAi()
    const { source } = await createKnife()
    browserReads(118.5)
    await checkPriceSource(source.id, { trigger: 'manual' })
    browserReads(117)
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(aiFetch).not.toHaveBeenCalled()
    expect(rows('SELECT direction FROM price_change_events')).toEqual([
      { direction: 'drop' },
    ])
  })

  it('notifies as before when AI fails or the budget refuses', async () => {
    enableAi()
    const { source } = await createKnife()
    browserReads(118.5)
    await checkPriceSource(source.id, { trigger: 'manual' })

    browserReads(90)
    aiFetch.mockRejectedValueOnce(new TypeError('connect ECONNREFUSED'))
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(rows('SELECT kind FROM price_notifications')).toEqual([
      { kind: 'drop' },
    ])

    setAiBudgetGate(() => 'The daily AI budget is used up (200 requests).')
    browserReads(70)
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(aiFetch).toHaveBeenCalledTimes(1)
    expect(
      rows(
        'SELECT occurrences FROM price_notifications WHERE kind = ?',
        'drop',
      ),
    ).toEqual([{ occurrences: 2 }])
    expect(lastLog()).toMatchObject({ outcome: 'ok', error_code: null })
  })

  it('ignores a "different price" AI cannot quote from the page', async () => {
    enableAi()
    const { source } = await createKnife()
    browserReads(118.5)
    await checkPriceSource(source.id, { trigger: 'manual' })
    browserReads(90)
    aiFetch.mockResolvedValueOnce(
      chat({
        verdict: 'rejected',
        issue: 'different_price',
        pagePrice: '$99.99',
        confidence: 0.99,
        reason: 'The price is $99.99.',
      }),
    )
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(rows('SELECT kind FROM price_notifications')).toEqual([
      { kind: 'drop' },
    ])
  })

  it('checks an implausible jump even when that change would not notify', async () => {
    enableAi(
      {},
      {
        notify: { ...DEFAULT_PRICE_MONITORING.notify, drop: false },
      },
    )
    const { source } = await createKnife()
    browserReads(118.5)
    await checkPriceSource(source.id, { trigger: 'manual' })
    // Below half the usual price: read twice, then AI.
    browserReads(40)
    browserReads(40)
    aiFetch.mockResolvedValueOnce(chat(reject))
    await checkPriceSource(source.id, { trigger: 'manual' })
    // The third browser opening is the solver looking for the right price
    // after the rejection; it finds none here, so the reading stays out.
    expect(mocks.browser).toHaveBeenCalledTimes(4)
    expect(aiFetch).toHaveBeenCalledTimes(1)
    expect(requestBody(0)).toContain('far more than usual')
    expect(rows('SELECT * FROM price_change_events')).toEqual([])
    expect(sourceRow(source.id)).toMatchObject({ last_price_minor: 11850 })
  })

  it('does nothing with the switch off', async () => {
    enableAi({ confirmChanges: false })
    const { source } = await createKnife()
    browserReads(118.5)
    await checkPriceSource(source.id, { trigger: 'manual' })
    browserReads(90)
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(aiFetch).not.toHaveBeenCalled()
    expect(rows('SELECT kind FROM price_notifications')).toEqual([
      { kind: 'drop' },
    ])
  })
})

describe('Spot-check page readings (Unlimited)', () => {
  it('marks a doubted first reading for review and keeps the parser price', async () => {
    enableAi({ usage: unlimited() })
    const { source } = await createKnife()
    browserReads(90, pageWith('$90.00'))
    aiFetch.mockResolvedValueOnce(chat(reject))
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(aiFetch).toHaveBeenCalledTimes(1)
    expect(requestBody(0)).toContain('spot check')
    expect(sourceRow(source.id)).toMatchObject({
      status: 'needs_review',
      last_price_minor: 9000,
      last_error_code: 'ai_review',
    })
    expect(String(sourceRow(source.id).last_error)).toContain(
      "The parser's price was kept",
    )
    expect(rows('SELECT ai_review FROM price_snapshots')).toEqual([
      { ai_review: null },
    ])
    // A doubted price that is the knife's best offer needs the user; the
    // morning summary raises it.
    const morning = new Date()
    morning.setHours(10, 0, 0, 0)
    await runAttentionSummary({
      generation: getVaultAccessState().generation,
      now: morning.getTime(),
    })
    const attention = (await getSystemMessages()).find(
      (message) => message.kind === 'price-attention',
    )
    expect(attention?.detail).toContain('AI doubts the price')

    // Under review, the next reading is checked again until AI is sure.
    browserReads(90, pageWith('$90.00'))
    aiFetch.mockResolvedValueOnce(chat(confirm))
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(aiFetch).toHaveBeenCalledTimes(2)
    expect(sourceRow(source.id)).toMatchObject({
      status: 'ok',
      last_error_code: null,
    })
    // An unchanged price is not checked again.
    browserReads(90, pageWith('$90.00'))
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(aiFetch).toHaveBeenCalledTimes(2)
  })

  it('keeps what AI saw for the comparison until the user answers Same knife', async () => {
    enableAi({ usage: unlimited() })
    const { source } = await createKnife({
      specs: { modelNumber: 'A4516', lockingMechanism: 'Top Liner Lock' },
      handleMaterial: 'Titanium',
    })
    const otherVersion = {
      verdict: 'rejected',
      issue: 'wrong_variant',
      pagePrice: null,
      confidence: 0.9,
      reason: 'The page is for the crossbar-lock version.',
      page: {
        title: 'Raccoon Crossbar A4516',
        modelNumber: { value: 'A4516', match: 'same' },
        lockingMechanism: { value: 'Crossbar lock', match: 'different' },
        bladeCoating: { value: null, match: 'unknown' },
        handleMaterial: { value: 'Blue titanium', match: 'same' },
      },
    }
    browserReads(90, pageWith('$90.00'))
    aiFetch.mockResolvedValueOnce(chat(otherVersion))
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(requestBody(0)).toContain('lockingMechanism')

    const reviewOf = () =>
      readAttentionList().items.find((item) => item.sourceId === source.id)
        ?.review
    expect(reviewOf()).toMatchObject({
      issue: 'wrong_variant',
      version: true,
      title: 'Raccoon Crossbar A4516',
      rows: [
        { field: 'modelNumber', yours: 'A4516', page: 'A4516', match: 'same' },
        {
          field: 'lockingMechanism',
          yours: 'Top Liner Lock',
          page: 'Crossbar lock',
          match: 'different',
        },
        {
          field: 'handleMaterial',
          yours: 'Titanium',
          page: 'Blue titanium',
          match: 'same',
        },
      ],
    })

    // AI unavailable on the next check: the comparison stays.
    browserReads(90, pageWith('$90.00'))
    aiFetch.mockRejectedValueOnce(new TypeError('connect ECONNREFUSED'))
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(reviewOf()?.title).toBe('Raccoon Crossbar A4516')

    await applyAttentionAction({
      action: 'same_product',
      sourceIds: [source.id],
    })
    expect(
      rows(
        `SELECT status, review_detail, product_confirmed_at IS NOT NULL AS confirmed
         FROM price_sources WHERE id = ?`,
        source.id,
      )[0],
    ).toEqual({ status: 'ok', review_detail: null, confirmed: 1 })

    // A new price is still checked, but another version is no doubt now.
    browserReads(88, pageWith('$88.00'))
    aiFetch.mockResolvedValueOnce(chat(otherVersion))
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(aiFetch).toHaveBeenCalledTimes(3)
    expect(sourceRow(source.id)).toMatchObject({
      status: 'ok',
      last_price_minor: 8800,
      last_error_code: null,
    })
  })

  it('keeps the review when AI is unavailable', async () => {
    enableAi({ usage: unlimited() })
    const { source } = await createKnife()
    browserReads(90, pageWith('$90.00'))
    aiFetch.mockResolvedValueOnce(chat(reject))
    await checkPriceSource(source.id, { trigger: 'manual' })
    browserReads(90, pageWith('$90.00'))
    aiFetch.mockRejectedValueOnce(new TypeError('connect ECONNREFUSED'))
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(sourceRow(source.id)).toMatchObject({
      status: 'needs_review',
      last_error_code: 'ai_review',
    })
  })

  it('does not spot-check in Limited mode or with the switch off', async () => {
    enableAi()
    const { source } = await createKnife()
    browserReads(90)
    await checkPriceSource(source.id, { trigger: 'manual' })
    enableAi({ usage: unlimited(), spotCheck: false })
    browserReads(89)
    await checkPriceSource(source.id, { trigger: 'manual' })
    expect(aiFetch).not.toHaveBeenCalled()
  })
})

describe('Daily Inbox digest', () => {
  /** A drop; without its own Inbox card unless `keepCard`. */
  async function knifeWithHistory({ keepCard = false } = {}) {
    enableAi({ confirmChanges: false })
    const { source } = await createKnife()
    browserReads(118.5)
    await checkPriceSource(source.id, { trigger: 'manual' })
    browserReads(100)
    await checkPriceSource(source.id, { trigger: 'manual' })
    if (!keepCard) getLocalDb().prepare('DELETE FROM price_notifications').run()
    return source
  }

  it('leaves out drops that already have their own Inbox card', async () => {
    await knifeWithHistory({ keepCard: true })
    expect(rows('SELECT kind FROM price_notifications')).toContainEqual({
      kind: 'drop',
    })
    const data = readDigestData(getLocalDb())
    expect(data.deals).toEqual([])
    expect(data.drops).toEqual([])
  })

  it('reads aggregated data: deals against the regular price and drops', async () => {
    await knifeWithHistory()
    const data = readDigestData(getLocalDb())
    expect(data.monitoredSources).toBe(1)
    expect(data.deals).toEqual([
      {
        knife: 'Vosteed Raccoon',
        store: expect.any(String),
        price: '$100.00',
        regularPrice: '$129.00',
        belowRegularPct: 22.5,
      },
    ])
    expect(data.drops).toMatchObject([
      { knife: 'Vosteed Raccoon', from: '$118.50', to: '$100.00' },
    ])
  })

  it('writes one Inbox item a day from aggregated data only', async () => {
    installAiCallJournal()
    await knifeWithHistory()
    aiFetch.mockResolvedValueOnce(
      chat({
        title: 'Raccoon dropped to $100.00',
        summary:
          'Vosteed Raccoon is $100.00 at shop.example, 22.5% below regular price ($129.00).',
      }),
    )
    const morning = new Date()
    morning.setHours(9, 0, 0, 0)
    const result = await runPriceDigest({ now: morning.getTime() })
    expect(result).toEqual({
      status: 'written',
      title: 'Raccoon dropped to $100.00',
    })
    const body = requestBody(0)
    expect(body).toContain('Vosteed Raccoon')
    expect(body).not.toContain(NOTE)
    expect(body).not.toContain(PRODUCT_URL)
    expect(rows('SELECT purpose FROM price_ai_calls')).toEqual([
      { purpose: 'digest' },
    ])
    const digests = (await getSystemMessages()).filter(
      (message) => message.kind === 'price-digest',
    )
    expect(digests).toHaveLength(1)
    expect(digests[0]).toMatchObject({
      title: 'Raccoon dropped to $100.00',
      resolvedAt: null,
      readAt: null,
    })

    // Not again the same day.
    expect(
      await runPriceDigest({ now: morning.getTime() + 60 * 60 * 1000 }),
    ).toEqual({ status: 'skipped', reason: 'not_due' })

    // The next day's digest replaces it.
    aiFetch.mockResolvedValueOnce(
      chat({ title: 'Quiet day', summary: 'Nothing changed.' }),
    )
    const tomorrow = morning.getTime() + 24 * 60 * 60 * 1000
    expect(await runPriceDigest({ now: tomorrow })).toMatchObject({
      status: 'written',
    })
    const after = (await getSystemMessages()).filter(
      (message) => message.kind === 'price-digest',
    )
    expect(after.map((message) => Boolean(message.resolvedAt))).toEqual([
      true,
      false,
    ])
  })

  it('rejects a summary with prices that are not in the data', async () => {
    await knifeWithHistory()
    aiFetch.mockResolvedValueOnce(
      chat({ title: 'Deal', summary: 'Raccoon is $55.00 today.' }),
    )
    const result = await runPriceDigest({ force: true })
    expect(result).toMatchObject({ status: 'failed', reason: 'unusable' })
    expect(
      (await getSystemMessages()).filter(
        (message) => message.kind === 'price-digest',
      ),
    ).toEqual([])
  })

  it('skips without AI, with the switch off, and on a refused budget', async () => {
    await knifeWithHistory()
    enableAi({ dailyDigest: false })
    expect(await runPriceDigest({ force: true })).toEqual({
      status: 'skipped',
      reason: 'disabled',
    })
    enableAi()
    setAiBudgetGate(() => 'The daily AI budget is used up (200 requests).')
    expect(await runPriceDigest({ force: true })).toMatchObject({
      status: 'failed',
      reason: 'budget',
    })
    expect(aiFetch).not.toHaveBeenCalled()
  })
})
