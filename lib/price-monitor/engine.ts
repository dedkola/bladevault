import { getLocalDb } from '@/lib/local-db'
import {
  aiFallbackAllowed,
  extractOfferWithAi,
  type AiAnswerRejection,
} from '@/lib/price-monitor/ai'
import {
  loadBrowserState,
  saveBrowserState,
} from '@/lib/price-monitor/browser-state'
import {
  isPlausiblePrice,
  MAX_PRICE_MAJOR,
  type DetectResult,
} from '@/lib/price-monitor/detect'
import {
  checkViaBrowser,
  checkViaHttp,
  headedRetryAvailable,
  offersMatch,
  upstreamStatus,
  type PageCheck,
} from '@/lib/price-monitor/fetch'
import {
  normalizeCurrencyCode,
  parseStoredPrice,
  toMinorUnits,
} from '@/lib/price-monitor/money'
import { readPriceAiKey } from '@/lib/price-monitor/secrets'
import type { PriceProvider } from '@/lib/price-monitor/shared'
import {
  markSourceChecking,
  readHostState,
  readRecentPrices,
  readSource,
  recordCheck,
  type CheckOutcomeKind,
  type CheckRecord,
  type HostPatch,
  type HostState,
  type RecordedObservation,
  type SourceRow,
} from '@/lib/price-monitor/store'
import type { ExtractedOffer } from '@/lib/scrape-offer'
import { ScrapeError, toScrapeError } from '@/lib/scrape-errors'
import { createScrapeOperation } from '@/lib/scrape-operation'
import { getSettings } from '@/lib/settings'
import type { PriceAiSettings } from '@/lib/settings-shared'
import { getStorage } from '@/lib/storage'
import { validateExternalUrl } from '@/lib/url-validation'
import { getVaultAccessState } from '@/lib/vault-access'

export type CheckTrigger = CheckRecord['trigger']

/** Whole-check budget, including fallbacks and a confirmation re-read. */
export const CHECK_BUDGET_MS = 60_000
/** Raw HTML must match the rendered page this many times before HTTP-first. */
export const HTTP_LEARN_STREAK = 3
const BROWSER_PIN_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_BACKOFF_MS = 7 * DAY_MS
/** Default frequency when the caller does not pass one. */
const DEFAULT_INTERVAL_MS = DAY_MS

const MESSAGES: Record<string, string> = {
  challenge:
    'The store showed a bot check (CAPTCHA). BladeVault will try again later.',
  network: 'Could not reach the store.',
  timeout: 'The page took too long to load.',
  redirect: 'The store redirected somewhere BladeVault cannot follow.',
  browser:
    'The monitoring browser could not start. Check that Chromium, Chrome or Edge is installed.',
  invalid_url: 'This URL cannot be checked. Use a public product page.',
  blocked_url: 'Private or internal addresses cannot be checked.',
  invalid_response: 'The store sent a response BladeVault could not read.',
  not_found: 'No price or stock status found on the page.',
  no_currency: 'A price was found, but not its currency.',
  invalid_price: 'The price on the page is not a valid amount.',
  implausible:
    'The price changed too much to trust from one reading; it was not stored.',
  cancelled: 'The check was cancelled.',
}

const AI_REJECTIONS: Record<AiAnswerRejection | 'empty_page', string> = {
  not_found: 'AI found no price either.',
  low_confidence: 'AI was not sure enough about the price.',
  not_in_page:
    'AI suggested a price that is not on the page, so it was ignored.',
  invalid_price: 'AI suggested a price that is not a valid amount.',
  empty_page: 'The page had nothing for AI to read.',
}

function messageFor(code: string, error?: unknown): string {
  if (code === 'http' && error instanceof Error) return error.message
  return MESSAGES[code] ?? 'The check failed.'
}

type Strategy = 'http' | 'browser'

function chooseStrategy(source: SourceRow, host: HostState, now: number) {
  if (source.fetch_override === 'http') return 'http'
  if (source.fetch_override === 'browser') return 'browser'
  const pinnedToBrowser =
    host.strategy === 'browser_first' &&
    host.strategyUntil !== null &&
    Date.parse(host.strategyUntil) > now
  return host.strategy === 'http_first' && !pinnedToBrowser ? 'http' : 'browser'
}

type Reading = {
  check: PageCheck
  method: 'http' | 'browser' | 'headed'
}

function isBlockingFailure(error: unknown): boolean {
  const failure = toScrapeError(error)
  if (failure.code === 'challenge') return true
  const status = upstreamStatus(error)
  return status === 403 || status === 429
}

class CheckFlow {
  host: HostPatch = {}
  shopify: boolean

  constructor(
    readonly source: SourceRow,
    readonly hostState: HostState,
    readonly currencyHint: string,
    readonly operation: ReturnType<typeof createScrapeOperation>,
  ) {
    this.shopify = source.provider === 'shopify'
  }

  async browser(): Promise<Reading> {
    const lane = this.source.lane_key
    const storageState = await loadBrowserState(lane)
    let method: Reading['method'] = 'browser'
    let page
    try {
      page = await checkViaBrowser(this.source.url, this.operation, {
        storageState,
      })
    } catch (error) {
      if (toScrapeError(error).code !== 'challenge' || !headedRetryAvailable())
        throw error
      // Docker's Xvfb lets a headed browser try once; no windows on desktop.
      method = 'headed'
      page = await checkViaBrowser(this.source.url, this.operation, {
        storageState,
        headless: false,
      })
    }
    if (page.isShopify) this.shopify = true
    if (page.offer && page.storageState)
      await saveBrowserState(lane, page.storageState).catch(() => {})

    if (this.source.fetch_override === 'auto') {
      const streak = offersMatch(page.offer, page.serverOffer)
        ? (this.host.httpMatchStreak ?? this.hostState.httpMatchStreak) + 1
        : 0
      const pinned =
        this.hostState.strategy === 'browser_first' &&
        this.hostState.strategyUntil !== null &&
        Date.parse(this.hostState.strategyUntil) > Date.now()
      if (streak >= HTTP_LEARN_STREAK && !pinned) {
        this.host = {
          ...this.host,
          strategy: 'http_first',
          strategyUntil: null,
          httpMatchStreak: 0,
        }
      } else {
        this.host = { ...this.host, httpMatchStreak: streak }
      }
    }
    return { check: page, method }
  }

  async http(): Promise<Reading> {
    const check = await checkViaHttp(this.source.url, this.operation, {
      shopify: this.shopify,
      currencyHint: this.currencyHint,
    })
    if (check.isShopify) this.shopify = true
    return { check, method: 'http' }
  }

  /** HTTP first when learned; any HTTP problem falls back to the browser. */
  async read(strategy: Strategy): Promise<Reading> {
    if (strategy === 'http') {
      try {
        const reading = await this.http()
        if (reading.check.offer) return reading
      } catch (error) {
        const code = toScrapeError(error).code
        if (
          ['invalid_url', 'blocked_url', 'cancelled', 'timeout'].includes(code)
        )
          throw error
      }
      if (this.source.fetch_override === 'auto') {
        this.host = {
          ...this.host,
          strategy: 'browser_first',
          strategyUntil: new Date(Date.now() + BROWSER_PIN_MS).toISOString(),
          httpMatchStreak: 0,
        }
      }
    }
    return this.browser()
  }
}

function resolveCurrency(
  offer: ExtractedOffer,
  source: SourceRow,
  storedPrice: string | undefined,
): string {
  return (
    normalizeCurrencyCode(offer.currency) ||
    normalizeCurrencyCode(source.last_currency) ||
    parseStoredPrice(storedPrice)?.currency ||
    ''
  )
}

type Evaluated =
  | { kind: 'observation'; observation: RecordedObservation }
  | { kind: 'rejected'; outcome: CheckOutcomeKind; errorCode: string }

function evaluate(
  offer: ExtractedOffer | null,
  source: SourceRow,
  storedPrice: string | undefined,
): Evaluated {
  if (!offer)
    return { kind: 'rejected', outcome: 'no_price', errorCode: 'not_found' }
  if (offer.amount === null) {
    return {
      kind: 'observation',
      observation: {
        priceMinor: null,
        currency: null,
        availability: offer.availability,
        extractionStatus: 'no_price',
        extractionMethod: offer.method,
      },
    }
  }
  if (
    !Number.isFinite(offer.amount) ||
    offer.amount <= 0 ||
    offer.amount >= MAX_PRICE_MAJOR
  )
    return { kind: 'rejected', outcome: 'no_price', errorCode: 'invalid_price' }
  const currency = resolveCurrency(offer, source, storedPrice)
  if (!currency)
    return { kind: 'rejected', outcome: 'no_price', errorCode: 'no_currency' }
  return {
    kind: 'observation',
    observation: {
      priceMinor: toMinorUnits(offer.amount, currency),
      currency,
      availability: offer.availability,
      extractionStatus: offer.method === 'ai' ? 'ai' : 'ok',
      extractionMethod: offer.method,
    },
  }
}

type AiReading = {
  /** The model was asked; starts the source's 24 h AI pause. */
  attempted: boolean
  offer: ExtractedOffer | null
  /** Why AI did not help, for the check log. */
  note: string | null
}

/**
 * The optional AI fallback for a page the parsers could not read: only with
 * AI enabled and at most once per source per 24 hours. The key is optional
 * for local servers such as Ollama; the endpoint decides.
 */
async function readWithAi(input: {
  html: string | undefined
  source: SourceRow
  settings: PriceAiSettings
  currencyHint: string
  signal: AbortSignal
}): Promise<AiReading> {
  const none: AiReading = { attempted: false, offer: null, note: null }
  if (
    !input.html ||
    !aiFallbackAllowed({
      settings: input.settings,
      lastAiAt: input.source.last_ai_at,
      now: Date.now(),
    })
  )
    return none
  try {
    const apiKey = await readPriceAiKey()
    const result = await extractOfferWithAi({
      html: input.html,
      endpoint: { baseUrl: input.settings.baseUrl, apiKey },
      model: input.settings.model,
      currencyHint: input.currencyHint,
      signal: input.signal,
    })
    if (result.status === 'ok')
      return { attempted: true, offer: result.offer, note: null }
    return { attempted: true, offer: null, note: AI_REJECTIONS[result.reason] }
  } catch (error) {
    if (error instanceof Error && error.name === 'VaultAccessError') throw error
    const reason =
      error instanceof Error && error.name === 'AiClientError'
        ? error.message
        : 'The AI request failed.'
    return { attempted: true, offer: null, note: `AI fallback: ${reason}` }
  }
}

const RETRY_DELAYS_MS = [10 * 60 * 1000, 60 * 60 * 1000] as const
const RETRYABLE_CODES = new Set(['network', 'timeout'])
/** A page missing this many checks in a row pauses its source. */
export const MISSING_PAGE_PAUSE_AFTER = 3

function isRetryable(code: string, status: number | null): boolean {
  return (
    RETRYABLE_CODES.has(code) ||
    status === 429 ||
    (status !== null && status >= 500)
  )
}

/**
 * When to check a source again after a failure: network trouble and 5xx
 * retry after 10 minutes, then an hour; anything else (and further
 * failures) backs off exponentially from the frequency, up to 7 days.
 */
export function nextCheckAfterFailure(input: {
  failures: number
  retryable: boolean
  intervalMs: number
  now: number
}): string {
  const { failures, retryable, intervalMs, now } = input
  const delay =
    retryable && failures <= RETRY_DELAYS_MS.length
      ? RETRY_DELAYS_MS[failures - 1]
      : Math.min(
          intervalMs *
            2 **
              Math.max(
                0,
                failures - 1 - (retryable ? RETRY_DELAYS_MS.length : 0),
              ),
          MAX_BACKOFF_MS,
        )
  return new Date(now + delay).toISOString()
}

/** Store-level result, for the queue's pacing (see lanes.ts). */
export type LaneOutcomeKind =
  'success' | 'throttled' | 'blocked' | 'failed' | 'neutral'

export type CheckSummary =
  | { status: 'skipped'; reason: 'missing' | 'read_only' }
  | {
      status: 'done'
      outcome: CheckOutcomeKind
      detection: DetectResult | null
      errorCode: string | null
      laneOutcome: LaneOutcomeKind
      durationMs: number
      retryAfterMs: number | null
    }

const NEUTRAL_CODES = new Set([
  'invalid_url',
  'blocked_url',
  'browser',
  'cancelled',
  'implausible',
])

function laneOutcomeFor(
  outcome: CheckOutcomeKind,
  code: string | null,
  status: number | null,
): LaneOutcomeKind {
  if (outcome === 'ok' || outcome === 'no_price') return 'success'
  if (outcome === 'blocked') return status === 429 ? 'throttled' : 'blocked'
  if (status === 429 || status === 503) return 'throttled'
  if (code && NEUTRAL_CODES.has(code)) return 'neutral'
  return 'failed'
}

/** Retry-After from a fetch error (seconds or an HTTP date). */
export function retryAfterMs(error: unknown, now = Date.now()): number | null {
  const value = (error as { retryAfter?: unknown } | null)?.retryAfter
  if (typeof value !== 'string' || !value.trim()) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : null
}

/**
 * Checks one source: fetch (learned HTTP or Playwright, headed retry in
 * Docker), extract, validate, confirm implausible jumps with a second
 * browser reading, then store everything in one transaction. The next
 * scheduled check is `intervalMs` later, or a retry/backoff after failures.
 */
export async function checkPriceSource(
  sourceId: number,
  options: {
    trigger: CheckTrigger
    signal?: AbortSignal
    intervalMs?: number
  },
): Promise<CheckSummary> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const access = getVaultAccessState()
  if (access.readOnly) return { status: 'skipped', reason: 'read_only' }
  const generation = access.generation
  const database = getLocalDb()
  const source = readSource(database, sourceId)
  if (!source || source.removed_at)
    return { status: 'skipped', reason: 'missing' }
  const knife = await getStorage().getKnifeById(source.knife_id)
  if (!knife) return { status: 'skipped', reason: 'missing' }

  await markSourceChecking(source.id, generation)
  const hostState = readHostState(database, source.lane_key)
  const startedAt = new Date()
  const operation = createScrapeOperation({
    signal: options.signal,
    timeoutMs: CHECK_BUDGET_MS,
  })
  const flow = new CheckFlow(
    source,
    hostState,
    normalizeCurrencyCode(source.last_currency) ||
      parseStoredPrice(knife.specs.price)?.currency ||
      '',
    operation,
  )

  const { notify, thresholds, ai: aiSettings } = getSettings().priceMonitoring
  const base = {
    generation,
    sourceId: source.id,
    trigger: options.trigger,
    startedAt: startedAt.toISOString(),
    notifications: { notify, thresholds },
  }
  const done = async (
    record: Omit<CheckRecord, keyof typeof base | 'durationMs' | 'host'>,
    extra: { retryAfterMs?: number | null } = {},
  ): Promise<CheckSummary> => {
    const durationMs = Date.now() - startedAt.getTime()
    const result = await recordCheck({
      ...base,
      ...record,
      durationMs,
      provider: (flow.shopify ? 'shopify' : source.provider) as PriceProvider,
      host: flow.host,
    })
    return {
      status: 'done',
      outcome: record.outcome,
      detection: result?.detection ?? null,
      errorCode: record.errorCode ?? null,
      laneOutcome: laneOutcomeFor(
        record.outcome,
        record.errorCode ?? null,
        record.httpStatus ?? null,
      ),
      durationMs,
      retryAfterMs: extra.retryAfterMs ?? null,
    }
  }
  const nextOk = () => new Date(Date.now() + intervalMs).toISOString()

  try {
    const validation = await validateExternalUrl(source.url, {
      signal: operation.signal,
    })
    if (!validation.ok)
      throw new ScrapeError(
        validation.code ??
          (validation.reason.includes('Private')
            ? 'blocked_url'
            : 'invalid_url'),
        validation.reason,
      )

    let reading = await flow.read(chooseStrategy(source, hostState, Date.now()))
    let method: CheckRecord['method'] = reading.method
    let evaluated = evaluate(reading.check.offer, source, knife.specs.price)
    let aiUsed = false
    let aiNote: string | null = null

    if (evaluated.kind === 'rejected' && evaluated.errorCode === 'not_found') {
      const ai = await readWithAi({
        html: reading.check.html,
        source,
        settings: aiSettings,
        currencyHint: flow.currencyHint,
        signal: operation.signal,
      })
      aiUsed = ai.attempted
      aiNote = ai.note
      if (ai.offer) {
        // Same validation and plausibility checks as any other reading.
        evaluated = evaluate(ai.offer, source, knife.specs.price)
        method = 'ai'
      }
    }

    if (
      evaluated.kind === 'observation' &&
      evaluated.observation.priceMinor !== null &&
      evaluated.observation.currency &&
      !isPlausiblePrice(
        evaluated.observation.priceMinor,
        readRecentPrices(database, source.id, evaluated.observation.currency),
      )
    ) {
      const first = evaluated.observation
      reading = await flow.browser()
      method = reading.method
      evaluated = evaluate(reading.check.offer, source, knife.specs.price)
      const confirmed =
        evaluated.kind === 'observation' &&
        evaluated.observation.priceMinor === first.priceMinor &&
        evaluated.observation.currency === first.currency
      if (!confirmed) {
        return done({
          outcome: 'failed',
          method,
          attempt: 2,
          aiUsed,
          errorCode: 'implausible',
          errorMessage: messageFor('implausible'),
          nextCheckAt: nextCheckAfterFailure({
            failures: source.consecutive_failures + 1,
            retryable: true,
            intervalMs,
            now: Date.now(),
          }),
        })
      }
    }

    if (evaluated.kind === 'rejected') {
      return done({
        outcome: evaluated.outcome,
        method,
        aiUsed,
        errorCode: evaluated.errorCode,
        errorMessage: aiNote
          ? `${messageFor(evaluated.errorCode)} ${aiNote}`
          : messageFor(evaluated.errorCode),
        nextCheckAt: nextOk(),
      })
    }

    return done({
      outcome: 'ok',
      method,
      aiUsed,
      observation: evaluated.observation,
      errorCode: null,
      errorMessage: null,
      nextCheckAt: nextOk(),
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'VaultAccessError') throw error
    const failure = toScrapeError(error)
    const status = upstreamStatus(error)
    const outcome: CheckOutcomeKind = isBlockingFailure(error)
      ? 'blocked'
      : 'failed'
    const failures = source.consecutive_failures + 1
    const missing = status === 404 || status === 410
    const pause = missing && failures >= MISSING_PAGE_PAUSE_AFTER
    return done(
      {
        outcome,
        method: null,
        httpStatus: status,
        errorCode: failure.code,
        errorMessage: pause
          ? 'The page was not found three times in a row, so this source is paused. Check the URL, then resume it.'
          : messageFor(failure.code, failure),
        nextCheckAt: nextCheckAfterFailure({
          failures,
          retryable: isRetryable(failure.code, status),
          intervalMs,
          now: Date.now(),
        }),
        disable: pause,
      },
      { retryAfterMs: retryAfterMs(error) },
    )
  } finally {
    operation.dispose()
  }
}
