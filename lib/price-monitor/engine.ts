import { getLocalDb } from '@/lib/local-db'
import { readPriceAlertContext } from '@/lib/price-monitor/notification-store'
import { syncPriceAttention } from '@/lib/price-monitor/attention'
import { reportServerError } from '@/lib/sentry/server'
import {
  aiConfigured,
  aiFallbackAllowed,
  aiSourceReady,
  extractOfferWithAi,
  type AiAnswerRejection,
} from '@/lib/price-monitor/ai'
import { aiBudgetRefusal, type AiEndpoint } from '@/lib/price-monitor/ai-client'
import {
  applyRelink,
  askToRelink,
  describeVariant,
  detectMovedPage,
  expectedVariantFor,
  isSoftMissingPage,
  productPageAcceptor,
  productPageUrl,
  readPageVariant,
  relinkSafeToApply,
  relinkSearch,
  variantMismatch,
} from '@/lib/price-monitor/recovery'
import {
  clearBrowserState,
  loadBrowserState,
  saveBrowserState,
} from '@/lib/price-monitor/browser-state'
import {
  detectChange,
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
import {
  shouldNotify,
  type PriceNotificationSettings,
} from '@/lib/price-monitor/notifications'
import { readOutOfStockSince } from '@/lib/price-monitor/insights'
import { MONITOR_CURRENCY } from '@/lib/price-monitor/region'
import { scheduledIntervalMs } from '@/lib/price-monitor/schedule'
import { readPriceAiKey } from '@/lib/price-monitor/secrets'
import { aiNotReached } from '@/lib/price-monitor/ai-client'
import {
  clockMark,
  noteNetworkSuccess,
  settleNetworkFailure,
  sleptSince,
} from '@/lib/price-monitor/power'
import {
  parseRecipe,
  replayRecipe,
  solveOnPage,
  solverAllowed,
  solverLimits,
  summarizeSteps,
  type SolverAction,
  type SolverLogStep,
  type SolverResult,
  type SolverSearch,
} from '@/lib/price-monitor/solver'
import {
  isAmazonUrl,
  normalizeSourceUrl,
  type PriceProvider,
} from '@/lib/price-monitor/shared'
import {
  deferSourceCheck,
  hasAnySnapshot,
  markSourceChecking,
  readHostState,
  readKnifeFocus,
  readLatestPricedSnapshot,
  readLatestSnapshot,
  readRecentPrices,
  readRecentSourceChecks,
  readSource,
  recordCheck,
  type CheckOutcomeKind,
  type CheckRecord,
  type HostPatch,
  type HostState,
  type RecordedObservation,
  type SourceRow,
} from '@/lib/price-monitor/store'
import {
  troubleshootAllowed,
  troubleshootCheck,
  type TroubleshootPlan,
} from '@/lib/price-monitor/troubleshoot'
import {
  confirmChangesActive,
  describeRejection,
  spotCheckActive,
  verifyProduct,
  verifyReadingWithAi,
} from '@/lib/price-monitor/verify'
import type { Knife } from '@/lib/data'
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
    "The store showed a bot check (CAPTCHA). Use Solve in browser to pass it once; BladeVault keeps the store's cookies for later checks.",
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
  wrong_currency: 'The store shows prices in another currency than US dollars.',
  invalid_price: 'The price on the page is not a valid amount.',
  moved:
    'The product link now leads to another page (a category, search or home page): the product moved or was renamed.',
  soft_missing: 'The store says this product page is gone or not available.',
  wrong_variant:
    'The page shows another variant than the one this source tracks, so its price was not stored.',
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

/** The AI endpoint from the settings and the stored key. */
async function endpointFor(settings: PriceAiSettings): Promise<AiEndpoint> {
  return {
    baseUrl: settings.baseUrl,
    apiKey: await readPriceAiKey(),
    headers: settings.headers,
    maxAnswerTokens: settings.maxAnswerTokens,
  }
}

type Strategy = 'http' | 'browser'

function chooseStrategy(source: SourceRow, host: HostState, now: number) {
  if (source.fetch_override === 'http') return 'http'
  if (source.fetch_override === 'browser') return 'browser'
  // A solver recipe acts on the rendered page.
  if (parseRecipe(host.solverRecipe)) return 'browser'
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
  /** The store's solver recipe, replayed on every browser reading. */
  recipe: SolverAction[] | null
  recipeUsed = false

  constructor(
    readonly source: SourceRow,
    readonly hostState: HostState,
    readonly currencyHint: string,
    readonly operation: ReturnType<typeof createScrapeOperation>,
  ) {
    this.shopify = source.provider === 'shopify'
    this.recipe = parseRecipe(hostState.solverRecipe)
  }

  async browser(): Promise<Reading> {
    const lane = this.source.lane_key
    const storageState = await loadBrowserState(lane)
    let method: Reading['method'] = 'browser'
    const recipe = this.recipe
    let recipeOffer: ExtractedOffer | null = null
    const interact = recipe
      ? async (page: Parameters<typeof replayRecipe>[0]) => {
          this.recipeUsed = true
          const replay = await replayRecipe(page, recipe, {
            currencyHint: this.currencyHint,
          })
          if (replay.challenge) throw new ScrapeError('challenge')
          recipeOffer = replay.offer
        }
      : undefined
    let page
    try {
      page = await checkViaBrowser(this.source.url, this.operation, {
        storageState,
        interact,
      })
    } catch (error) {
      if (toScrapeError(error).code !== 'challenge' || !headedRetryAvailable())
        throw error
      // Docker's Xvfb lets a headed browser try once; no windows on desktop.
      method = 'headed'
      page = await checkViaBrowser(this.source.url, this.operation, {
        storageState,
        headless: false,
        interact,
      })
    }
    // A recipe may end on the store's product data rather than a page.
    if (recipeOffer && !page.offer?.amount) page.offer = recipeOffer
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

  /**
   * The AI problem solver on a fresh browser reading with its own budget.
   * Never throws for page problems: a bot check or a failed load comes back
   * as a result. `startUrl` opens another page of the same store (a search
   * for a product that moved starts on the store's home page);
   * `freshCookies` starts without the store's saved cookies (and with a
   * visible browser where Docker has one).
   */
  async solve(input: {
    problem: { code: string; message: string }
    settings: PriceAiSettings
    accept: (offer: ExtractedOffer) => boolean
    signal?: AbortSignal
    startUrl?: string
    freshCookies?: boolean
    acceptPage?: (page: { url: string; html: string }) => Promise<boolean>
    search?: SolverSearch
  }): Promise<SolverResult> {
    const limits = solverLimits(input.settings)
    const storageState = input.freshCookies
      ? undefined
      : await loadBrowserState(this.source.lane_key)
    const endpoint = await endpointFor(input.settings)
    const operation = createScrapeOperation({
      signal: input.signal,
      timeoutMs: limits.budgetMs,
    })
    let result: SolverResult | null = null
    try {
      const page = await checkViaBrowser(
        input.startUrl ?? this.source.url,
        operation,
        {
          storageState,
          budgetMs: limits.budgetMs,
          headless:
            input.freshCookies && headedRetryAvailable() ? false : undefined,
          interact: async (page) => {
            result = await solveOnPage(page, {
              problem: input.problem,
              currencyHint: this.currencyHint,
              settings: input.settings,
              endpoint,
              accept: input.accept,
              signal: operation.signal,
              maxSteps: limits.maxSteps,
              acceptPage: input.acceptPage,
              search: input.search,
            })
          },
        },
      )
      // Fresh cookies that led to a price replace the store's saved ones.
      if (
        input.freshCookies &&
        (result as SolverResult | null)?.offer &&
        page.storageState
      )
        await saveBrowserState(this.source.lane_key, page.storageState).catch(
          () => {},
        )
    } catch (error) {
      if (error instanceof Error && error.name === 'VaultAccessError')
        throw error
      if (!result) {
        const code = toScrapeError(error).code
        const message =
          error instanceof Error && error.name === 'AiClientError'
            ? error.message
            : messageFor(code, error)
        return {
          status: code === 'challenge' ? 'challenge' : 'failed',
          offer: null,
          readByAi: false,
          recipe: null,
          steps: [],
          aiCalls:
            error instanceof Error && error.name === 'AiClientError' ? 1 : 0,
          note: code === 'challenge' ? null : `AI problem solver: ${message}`,
        }
      }
    } finally {
      operation.dispose()
    }
    return (
      result ?? {
        status: 'failed',
        offer: null,
        readByAi: false,
        recipe: null,
        steps: [],
        aiCalls: 0,
        note: null,
      }
    )
  }

  /**
   * After a bot check: the store's own product data (Shopify), then one
   * browser reading with fresh cookies. Nothing here touches the bot check.
   */
  async retryBlocked(): Promise<Reading | null> {
    if (this.shopify) {
      const reading = await this.http().catch(() => null)
      if (reading?.check.offer) return reading
    }
    const operation = createScrapeOperation({
      signal: this.operation.signal,
      timeoutMs: CHECK_BUDGET_MS,
    })
    try {
      const page = await checkViaBrowser(this.source.url, operation, {
        headless: headedRetryAvailable() ? false : undefined,
      })
      if (page.isShopify) this.shopify = true
      if (page.offer && page.storageState)
        await saveBrowserState(this.source.lane_key, page.storageState).catch(
          () => {},
        )
      return { check: page, method: 'browser' }
    } catch (error) {
      if (error instanceof Error && error.name === 'VaultAccessError')
        throw error
      return null
    } finally {
      operation.dispose()
    }
  }

  /** Shopify's product data for one variant: no page, no AI. */
  async readVariant(variantId: string): Promise<Reading | null> {
    let url: URL
    try {
      url = new URL(this.source.url)
    } catch {
      return null
    }
    url.searchParams.set('variant', variantId)
    const check = await checkViaHttp(url.href, this.operation, {
      shopify: true,
      currencyHint: this.currencyHint,
    }).catch(() => null)
    return check ? { check, method: 'http' } : null
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
      consecutiveFailures: input.source.consecutive_failures,
      now: Date.now(),
    })
  )
    return none
  try {
    const apiKey = await readPriceAiKey()
    const result = await extractOfferWithAi({
      html: input.html,
      endpoint: {
        baseUrl: input.settings.baseUrl,
        apiKey,
        headers: input.settings.headers,
        maxAnswerTokens: input.settings.maxAnswerTokens,
      },
      model: input.settings.model,
      currencyHint: input.currencyHint,
      maxFragmentBytes: input.settings.maxPageKb * 1024,
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
    return {
      // Unreachable, unconfigured, over budget or asleep: not asked.
      attempted: !aiNotReached(error),
      offer: null,
      note: `AI fallback: ${reason}`,
    }
  }
}

type AiRecovery = {
  /** The model was asked; starts the source's 24 h AI pause. */
  attempted: boolean
  plan: TroubleshootPlan | null
  /** Why AI did not help, for the check log. */
  note: string | null
}

/**
 * The optional AI troubleshooter for a check that failed before a price
 * could be read: only with AI enabled and at most once per source per 24
 * hours (shared with the extraction fallback). See troubleshoot.ts for the
 * bounds its plan is clamped to.
 */
async function recoverWithAi(input: {
  source: SourceRow
  settings: PriceAiSettings
  errorCode: string
  httpStatus: number | null
  errorMessage: string
  blocked: boolean
  failures: number
  trigger: CheckTrigger
  defaultNextCheckAt: string
  signal: AbortSignal | undefined
}): Promise<AiRecovery> {
  const none: AiRecovery = { attempted: false, plan: null, note: null }
  const now = Date.now()
  if (
    input.signal?.aborted ||
    !troubleshootAllowed({
      settings: input.settings,
      errorCode: input.errorCode,
      lastAiAt: input.source.last_ai_at,
      consecutiveFailures: input.source.consecutive_failures,
      now,
    })
  )
    return none
  try {
    const apiKey = await readPriceAiKey()
    const plan = await troubleshootCheck({
      failure: {
        store: input.source.lane_key,
        errorCode: input.errorCode,
        httpStatus: input.httpStatus,
        errorMessage: input.errorMessage,
        blocked: input.blocked,
        consecutiveFailures: input.failures,
        trigger: input.trigger,
        fetchMode: input.source.fetch_override,
        defaultRetryMinutes: Math.max(
          0,
          Math.round((Date.parse(input.defaultNextCheckAt) - now) / 60_000),
        ),
        recent: readRecentSourceChecks(getLocalDb(), input.source.id),
      },
      endpoint: {
        baseUrl: input.settings.baseUrl,
        apiKey,
        headers: input.settings.headers,
        maxAnswerTokens: input.settings.maxAnswerTokens,
      },
      model: input.settings.model,
      now,
      signal: input.signal,
    })
    return { attempted: true, plan, note: null }
  } catch (error) {
    if (error instanceof Error && error.name === 'VaultAccessError') throw error
    const reason =
      error instanceof Error && error.name === 'AiClientError'
        ? error.message
        : 'The AI request failed.'
    return {
      attempted: !aiNotReached(error),
      plan: null,
      note: `AI troubleshooting: ${reason}`,
    }
  }
}

type AiReview = {
  /** Stored on the snapshot; 'unconfirmed' keeps it out of the baseline. */
  aiReview: 'confirmed' | 'unconfirmed' | null
  /** The source needs review: AI doubts the parser's reading. */
  needsReview: boolean
  errorCode: string | null
  /** For the check log and the source. */
  message: string | null
}

const NO_REVIEW: AiReview = {
  aiReview: null,
  needsReview: false,
  errorCode: null,
  message: null,
}

/**
 * AI quality control for a successful reading (see verify.ts). With
 * Confirm price changes on, a change that would notify, or an implausible
 * jump, is checked against the page first; a confident rejection keeps the
 * reading as unconfirmed and skips the notification. In Unlimited mode
 * with Spot-check readings on, a source's first reading and every changed
 * price are checked too, and a confident mismatch marks the source as
 * needing review, keeping the parser's price. Unavailable AI or a refused
 * budget leaves the reading as it is.
 */
async function reviewWithAi(input: {
  observation: RecordedObservation
  html: string | undefined
  source: SourceRow
  knife: Knife
  settings: PriceAiSettings
  notifications: PriceNotificationSettings
  implausible: boolean
  /** Read by the page parsers (not by AI): spot checks apply. */
  parserReading: boolean
  signal: AbortSignal | undefined
}): Promise<AiReview> {
  const { observation, source, settings } = input
  const { priceMinor, currency } = observation
  if (priceMinor === null || !currency || !input.html || input.signal?.aborted)
    return NO_REVIEW
  const confirm = confirmChangesActive(settings)
  const spot = input.parserReading && spotCheckActive(settings)
  if (!confirm && !spot) return NO_REVIEW

  const database = getLocalDb()
  const latestPriced = readLatestPricedSnapshot(database, source.id)
  const change = detectChange(
    readLatestSnapshot(database, source.id),
    latestPriced,
    observation,
  ).priceChange
  const notifying = Boolean(
    change &&
    shouldNotify(
      {
        kind: change.direction,
        eventId: 0,
        knifeId: source.knife_id,
        sourceId: source.id,
        currency: change.currency,
        deltaMinor: change.deltaMinor,
        deltaPct: change.deltaPct,
        priceMinor: change.priceMinor,
      },
      input.notifications,
      readPriceAlertContext(database, {
        knifeId: source.knife_id,
        sourceId: source.id,
        currency: change.currency,
      }),
    ),
  )
  const gate = confirm && (notifying || input.implausible)
  const priceDiffers =
    !latestPriced ||
    latestPriced.priceMinor !== priceMinor ||
    latestPriced.currency !== currency
  const underReview = source.status === 'needs_review'
  const spotDue =
    spot &&
    (underReview || priceDiffers || !hasAnySnapshot(database, source.id))
  if (!gate && !spotDue) return NO_REVIEW
  // Unclear: a source already under review stays there until AI is sure.
  const keep: AiReview =
    spotDue && underReview && !priceDiffers
      ? {
          ...NO_REVIEW,
          needsReview: true,
          errorCode: 'ai_review',
          message: source.last_error,
        }
      : NO_REVIEW

  let verdict
  try {
    const apiKey = await readPriceAiKey()
    verdict = await verifyReadingWithAi({
      html: input.html,
      endpoint: {
        baseUrl: settings.baseUrl,
        apiKey,
        headers: settings.headers,
        maxAnswerTokens: settings.maxAnswerTokens,
      },
      model: settings.model,
      maxFragmentBytes: settings.maxPageKb * 1024,
      signal: input.signal,
      product: verifyProduct(input.knife),
      host: source.lane_key,
      reading: {
        priceMinor,
        currency,
        availability: observation.availability,
      },
      previous:
        latestPriced?.priceMinor != null && latestPriced.currency
          ? {
              priceMinor: latestPriced.priceMinor,
              currency: latestPriced.currency,
            }
          : null,
      reason: gate
        ? input.implausible && !notifying
          ? 'implausible'
          : 'notify'
        : 'spot_check',
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'VaultAccessError') throw error
    // Unavailable AI or a used-up budget: today's behaviour.
    return keep
  }
  if (verdict.status === 'confirmed')
    return { ...NO_REVIEW, aiReview: 'confirmed' }
  if (verdict.status !== 'rejected') return keep

  const why = describeRejection(verdict)
  if (gate)
    return {
      aiReview: 'unconfirmed',
      needsReview: spotDue,
      errorCode: 'ai_unconfirmed',
      message: `AI could not confirm this price: ${why}. The reading was kept as unconfirmed and did not notify.`,
    }
  return {
    aiReview: null,
    needsReview: true,
    errorCode: 'ai_review',
    message: `AI doubts the price the page parser read: ${why}. The parser's price was kept; check the page and the product link.`,
  }
}

/** A product page that moved or is gone: AI may search for its new link. */
const RELINK_CODES = new Set(['moved', 'soft_missing'])
/** Wrong-variant checks in a row before a learned variant is learned again. */
export const WRONG_VARIANT_RELEARN_AFTER = 3
/** Page problems that pause a source after MISSING_PAGE_PAUSE_AFTER checks. */
const PAGE_PROBLEM_CODES = new Set(['moved', 'soft_missing'])

/** The store's home page, where a search for a moved product starts. */
function storeHome(url: string): string {
  try {
    return `${new URL(url).origin}/`
  } catch {
    return url
  }
}

function urlPath(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

/** Page-read problems the AI extraction fallback may fix. */
const AI_EXTRACTION_CODES = new Set([
  'not_found',
  'no_currency',
  'invalid_price',
])

const RETRY_DELAYS_MS = [10 * 60 * 1000, 60 * 60 * 1000] as const
/** A check deferred by sleep or an outage runs again this much later. */
const DEFER_CHECK_MS = 3 * 60 * 1000
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
  /**
   * The computer slept or was offline during the check: nothing counts
   * against the store, and the source runs again after the hold.
   */
  | { status: 'deferred'; reason: 'suspended' | 'offline' }
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
  'moved',
  'soft_missing',
  'wrong_variant',
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

/** Any Amazon marketplace, including sources saved before #620. */
function isAmazonSource(source: SourceRow): boolean {
  return (
    String(source.provider) === 'amazon' ||
    source.lane_key === 'amazon' ||
    isAmazonUrl(source.url)
  )
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
  const mark = clockMark()
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

  const {
    notify,
    thresholds,
    ignoreOfficialOutOfStock,
    ai: monitoringAi,
    schedule,
  } = getSettings().priceMonitoring
  // Amazon pages are checked without AI: no AI reading, verifying, solving
  // or troubleshooting, whatever the AI settings say.
  const aiSettings: PriceAiSettings = isAmazonSource(source)
    ? { ...monitoringAi, enabled: false }
    : monitoringAi
  const base = {
    generation,
    sourceId: source.id,
    trigger: options.trigger,
    startedAt: startedAt.toISOString(),
    notifications: { notify, thresholds, ignoreOfficialOutOfStock },
  }
  const done = async (
    record: Omit<CheckRecord, keyof typeof base | 'durationMs' | 'host'>,
    extra: { retryAfterMs?: number | null } = {},
  ): Promise<CheckSummary> => {
    const durationMs = Date.now() - startedAt.getTime()
    // The store answered (a page, a status, a bot check): the network works.
    if (record.outcome !== 'failed' || record.httpStatus != null)
      noteNetworkSuccess(startedAt.getTime())
    const result = await recordCheck({
      ...base,
      ...record,
      durationMs,
      provider: (flow.shopify ? 'shopify' : source.provider) as PriceProvider,
      host: flow.host,
    })
    // The Inbox lists store pages that need attention; never fails a check.
    await syncPriceAttention({
      previousStatus: source.status,
      status: readSource(getLocalDb(), source.id)?.status ?? null,
    }).catch((error: unknown) => {
      if (error instanceof Error && error.name === 'VaultAccessError')
        throw error
      reportServerError(error, 'price-monitor/attention')
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
  // A page out of stock for two weeks is checked at most once a day.
  const nextOk = (observation?: RecordedObservation | null) => {
    const now = Date.now()
    const stillOut =
      observation?.availability === 'out_of_stock' &&
      source.last_availability === 'out_of_stock'
    const since = stillOut
      ? Date.parse(
          readOutOfStockSince(database, source.id).get(source.id) ?? '',
        )
      : NaN
    return new Date(
      now +
        scheduledIntervalMs({
          intervalMs,
          outOfStockSince: Number.isFinite(since) ? since : null,
          now,
          slowOutOfStock: schedule.slowOutOfStock,
          focusIntervalMs:
            readKnifeFocus(database, source.knife_id, now)?.intervalMs ?? null,
        }),
    ).toISOString()
  }
  let implausible = false
  let aiUsed = false
  let solverSteps: SolverLogStep[] | null = null
  let solverNote: string | null = null
  /** What AI recovery did, for the weekly numbers ("kind:result"). */
  let recovery: string | null = null
  const withSolverNote = (message: string) =>
    solverNote ? `${message} ${solverNote}` : message
  /** AI recovery is on: AI configured and Resolve check errors allowed. */
  const recoveryOn = aiConfigured(aiSettings) && aiSettings.resolveErrors
  const solverMay = (errorCode: string) =>
    solverAllowed({
      settings: aiSettings,
      errorCode,
      lastAiAt: source.last_ai_at,
      consecutiveFailures: source.consecutive_failures,
      now: Date.now(),
    })
  // Searching the store for a moved product opens a browser and asks AI.
  const relinkMay = () =>
    recoveryOn &&
    aiSettings.findMovedPages &&
    !aiBudgetRefusal('solver') &&
    aiSourceReady({
      settings: aiSettings,
      lastAiAt: source.last_ai_at,
      consecutiveFailures: source.consecutive_failures,
      now: Date.now(),
    })
  const acceptsPrice = (offer: ExtractedOffer) => {
    const result = evaluate(offer, source, knife.specs.price)
    return (
      result.kind === 'observation' && result.observation.priceMinor !== null
    )
  }
  /** Keeps a solver's steps as the store's recipe when the parsers read it. */
  const keepRecipe = (solved: SolverResult) => {
    if (solved.recipe && !solved.readByAi) {
      flow.recipe = solved.recipe
      flow.host = { ...flow.host, solverRecipe: JSON.stringify(solved.recipe) }
    }
  }

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

    // Slow, unreadable, missing or blocked pages may still be rescued below.
    let reading: Reading | null = null
    let readError: unknown = null
    try {
      reading = await flow.read(chooseStrategy(source, hostState, Date.now()))
    } catch (error) {
      const code = toScrapeError(error).code
      const status = upstreamStatus(error)
      if (code === 'challenge' && recoveryOn && aiSettings.retryBlocked) {
        // A bot check: the store's own product data, then fresh cookies.
        // Nothing here touches the bot check itself.
        const retry = await flow.retryBlocked()
        recovery = retry?.check.offer ? 'blocked:fixed' : 'blocked:asked'
        if (retry?.check.offer) reading = retry
      } else if (
        recoveryOn &&
        source.fetch_override === 'http' &&
        (code === 'network' ||
          code === 'timeout' ||
          (status !== null && status >= 500))
      ) {
        // Only plain HTTP was tried: one browser reading.
        reading = await flow.browser().catch(() => null)
      }
      if (!reading) {
        const gone = status === 404 || status === 410
        if (!(gone && relinkMay()) && !solverMay(code)) throw error
        readError = error
      }
    }
    let method: CheckRecord['method'] = reading?.method ?? null
    let evaluated: Evaluated = reading
      ? evaluate(reading.check.offer, source, knife.specs.price)
      : {
          kind: 'rejected',
          outcome: 'failed',
          errorCode: toScrapeError(readError).code,
        }
    let aiNote: string | null = null
    let relinkNote: string | null = null
    /** The page a solver ended on, when its reading is the one kept. */
    let solverPage: { url: string; html: string } | null = null

    // A redirect to a category or home page, or a "not found" page: the
    // product moved or is gone. No AI reads a price from such a page.
    if (reading && evaluated.kind === 'rejected') {
      if (
        detectMovedPage({
          sourceUrl: source.url,
          finalUrl: reading.check.finalUrl,
          html: reading.check.html,
          hasPrice: false,
        })
      )
        evaluated = { kind: 'rejected', outcome: 'failed', errorCode: 'moved' }
      else if (isSoftMissingPage(reading.check.html, false))
        evaluated = {
          kind: 'rejected',
          outcome: 'failed',
          errorCode: 'soft_missing',
        }
    }

    // Moved or gone: AI searches the same store for the product's new link.
    const readStatus = readError ? upstreamStatus(readError) : null
    const pageGone = !reading && (readStatus === 404 || readStatus === 410)
    const lookForPage =
      pageGone ||
      (evaluated.kind === 'rejected' &&
        (RELINK_CODES.has(evaluated.errorCode) ||
          (source.find_page_at !== null &&
            AI_EXTRACTION_CODES.has(evaluated.errorCode))))
    let relinkTried = false
    if (lookForPage && relinkMay()) {
      relinkTried = true
      const endpoint = await endpointFor(aiSettings)
      const moved =
        reading &&
        evaluated.kind === 'rejected' &&
        evaluated.errorCode === 'moved'
      const found = await flow.solve({
        problem: {
          code: 'find_product',
          message:
            'The saved product link no longer shows this product. Find its product page on this store.',
        },
        settings: aiSettings,
        accept: acceptsPrice,
        signal: options.signal,
        // A category page the store redirected to is a good place to start.
        startUrl: moved ? reading!.check.finalUrl : storeHome(source.url),
        search: relinkSearch(knife),
        acceptPage: productPageAcceptor({
          knife,
          endpoint,
          model: aiSettings.model,
          signal: options.signal,
        }),
      })
      aiUsed = aiUsed || found.aiCalls > 0
      if (found.steps.length) solverSteps = found.steps
      const foundUrl =
        found.offer && found.finalUrl ? productPageUrl(found.finalUrl) : null
      if (found.offer && foundUrl) {
        const path = urlPath(foundUrl)
        if (normalizeSourceUrl(foundUrl) === source.normalized_url) {
          // The product was on its own page after all.
          evaluated = evaluate(found.offer, source, knife.specs.price)
          method = 'solver'
          readError = null
          recovery = 'relink:fixed'
          solverPage = found.html ? { url: foundUrl, html: found.html } : null
        } else if (
          aiSettings.autoRelink &&
          relinkSafeToApply(knife, found.html ?? null) &&
          (await applyRelink({ sourceId: source.id, url: foundUrl }))
        ) {
          evaluated = evaluate(found.offer, source, knife.specs.price)
          method = 'solver'
          readError = null
          recovery = 'relink:fixed'
          solverPage = found.html ? { url: foundUrl, html: found.html } : null
          relinkNote = `AI found the product at its new link (${path}) and moved this source there.`
        } else {
          await askToRelink({
            knife,
            sourceId: source.id,
            store: source.store_name,
            url: foundUrl,
          })
          evaluated = {
            kind: 'rejected',
            outcome: 'failed',
            errorCode: 'moved',
          }
          readError = null
          recovery = 'relink:asked'
          relinkNote = `AI found the product at ${path}: answer the question in the Inbox to use the new link.`
        }
      } else {
        recovery = 'relink:failed'
        solverNote =
          found.status === 'challenge'
            ? 'AI reached a bot check while searching the store.'
            : [
                found.note,
                found.steps.length
                  ? `Tried: ${summarizeSteps(found.steps)}.`
                  : '',
              ]
                .filter(Boolean)
                .join(' ') || null
      }
    }

    if (
      reading &&
      evaluated.kind === 'rejected' &&
      AI_EXTRACTION_CODES.has(evaluated.errorCode)
    ) {
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

    // The AI problem solver works the page when nothing else read a price.
    if (
      evaluated.kind === 'rejected' &&
      !relinkTried &&
      solverMay(evaluated.errorCode)
    ) {
      const problemCode = evaluated.errorCode
      const problem = { code: problemCode, message: messageFor(problemCode) }
      let solved = await flow.solve({
        problem,
        settings: aiSettings,
        accept: acceptsPrice,
        signal: options.signal,
      })
      // Unlimited AI: one more run with fresh cookies when AI worked the
      // page and still found nothing (stale cookies hide prices too).
      if (
        !solved.offer &&
        solved.status !== 'challenge' &&
        solved.aiCalls > 0 &&
        aiSettings.usage.mode === 'unlimited' &&
        !aiBudgetRefusal('solver')
      ) {
        const fresh = await flow.solve({
          problem,
          settings: aiSettings,
          accept: acceptsPrice,
          signal: options.signal,
          freshCookies: true,
        })
        solved = {
          ...fresh,
          aiCalls: solved.aiCalls + fresh.aiCalls,
          steps: [...solved.steps, ...fresh.steps],
        }
      }
      aiUsed = aiUsed || solved.aiCalls > 0
      solverSteps = solved.steps.length ? solved.steps : null
      recovery = solved.offer
        ? 'unreadable:fixed'
        : solved.status === 'challenge'
          ? 'unreadable:asked'
          : 'unreadable:failed'
      if (solved.offer) {
        evaluated = evaluate(solved.offer, source, knife.specs.price)
        method = 'solver'
        readError = null
        aiNote = null
        solverPage =
          solved.html && solved.finalUrl
            ? { url: solved.finalUrl, html: solved.html }
            : null
        keepRecipe(solved)
      } else {
        solverNote =
          solved.status === 'challenge'
            ? 'AI reached a bot check: use Solve in browser to pass it once.'
            : [
                solved.note,
                solved.steps.length
                  ? `Tried: ${summarizeSteps(solved.steps)}.`
                  : '',
              ]
                .filter(Boolean)
                .join(' ') || null
      }
    }
    // Prices are tracked in US dollars: when the store still answered in
    // another currency, AI may switch the page to its US edition.
    if (
      evaluated.kind === 'observation' &&
      evaluated.observation.currency &&
      evaluated.observation.currency !== MONITOR_CURRENCY &&
      !aiUsed &&
      solverMay('wrong_currency')
    ) {
      const solved = await flow.solve({
        problem: {
          code: 'wrong_currency',
          message: `The page shows prices in ${evaluated.observation.currency}, not ${MONITOR_CURRENCY}. Switch the store to the United States or ${MONITOR_CURRENCY}.`,
        },
        settings: aiSettings,
        accept: (offer) => {
          const result = evaluate(offer, source, knife.specs.price)
          return (
            result.kind === 'observation' &&
            result.observation.priceMinor !== null &&
            result.observation.currency === MONITOR_CURRENCY
          )
        },
        signal: options.signal,
      })
      aiUsed = solved.aiCalls > 0
      if (solved.steps.length) solverSteps = solved.steps
      // Without a US price, the reading in the store's currency stands.
      if (solved.offer) {
        evaluated = evaluate(solved.offer, source, knife.specs.price)
        method = 'solver'
        solverPage =
          solved.html && solved.finalUrl
            ? { url: solved.finalUrl, html: solved.html }
            : null
        keepRecipe(solved)
      }
    }

    // The variant the source tracks: a page showing another one (often the
    // store's default after the tracked one sold out) is not its price.
    let learnedVariant: string | null = null
    const variantPage =
      method === 'solver'
        ? solverPage
        : reading?.check.html
          ? { url: reading.check.finalUrl, html: reading.check.html }
          : null
    if (
      evaluated.kind === 'observation' &&
      variantPage &&
      recoveryOn &&
      aiSettings.fixVariants
    ) {
      const expected = expectedVariantFor(source)
      const seen = readPageVariant(variantPage.html, variantPage.url)
      if (expected && variantMismatch(expected, seen)) {
        let fixed = false
        // Shopify: the tracked variant's own product data, without AI.
        if (expected.id && flow.shopify) {
          const variantReading = await flow.readVariant(expected.id)
          const result = variantReading
            ? evaluate(variantReading.check.offer, source, knife.specs.price)
            : null
          if (result?.kind === 'observation') {
            evaluated = result
            method = 'http'
            fixed = true
          }
        }
        if (!fixed && solverMay('wrong_variant')) {
          const solved = await flow.solve({
            problem: {
              code: 'wrong_variant',
              message: `The page shows ${seen ? describeVariant(seen) : 'another variant'}, but this source tracks ${describeVariant(expected)}. Choose the tracked variant, then read its price.`,
            },
            settings: aiSettings,
            accept: acceptsPrice,
            signal: options.signal,
            acceptPage: async ({ url, html }) => {
              const now = readPageVariant(html, url)
              return Boolean(now) && !variantMismatch(expected, now)
            },
          })
          aiUsed = aiUsed || solved.aiCalls > 0
          if (solved.steps.length) solverSteps = solved.steps
          if (solved.offer) {
            const result = evaluate(solved.offer, source, knife.specs.price)
            if (result.kind === 'observation') {
              evaluated = result
              method = 'solver'
              fixed = true
              solverPage =
                solved.html && solved.finalUrl
                  ? { url: solved.finalUrl, html: solved.html }
                  : null
            }
          }
        }
        recovery = fixed ? 'variant:fixed' : 'variant:failed'
        if (!fixed)
          evaluated = {
            kind: 'rejected',
            outcome: 'failed',
            errorCode: 'wrong_variant',
          }
      } else if (!source.expected_variant && seen && method !== 'solver') {
        learnedVariant = JSON.stringify(seen)
      }
    }

    // A recipe that stopped working is forgotten.
    if (
      flow.recipeUsed &&
      evaluated.kind === 'rejected' &&
      flow.host.solverRecipe === undefined
    )
      flow.host = { ...flow.host, solverRecipe: null }
    if (readError) throw readError
    // A missing page AI found elsewhere is recorded below as moved.
    if (!reading && evaluated.kind === 'rejected' && !relinkTried)
      throw new ScrapeError('unknown')

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
      implausible = confirmed
      if (!confirmed) {
        return done({
          outcome: 'failed',
          method,
          attempt: 2,
          aiUsed,
          solverSteps,
          recovery,
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
      const failures = source.consecutive_failures + 1
      // A page that stays moved or gone pauses its source, like a 404.
      const pause =
        PAGE_PROBLEM_CODES.has(evaluated.errorCode) &&
        failures >= MISSING_PAGE_PAUSE_AFTER
      // A learned variant that no page shows any more is learned again.
      const forgetVariant =
        evaluated.errorCode === 'wrong_variant' &&
        failures >= WRONG_VARIANT_RELEARN_AFTER &&
        Boolean(source.expected_variant)
      const base = aiNote
        ? `${messageFor(evaluated.errorCode)} ${aiNote}`
        : messageFor(evaluated.errorCode)
      return done({
        outcome: evaluated.outcome,
        method,
        aiUsed,
        solverSteps,
        recovery,
        errorCode: evaluated.errorCode,
        errorMessage: [
          withSolverNote(base),
          relinkNote,
          pause
            ? 'It happened three times in a row, so this source is paused until you check the link and resume it.'
            : null,
          forgetVariant
            ? 'After three tries, the next check tracks the variant the page shows; check the link if that is not the one you want.'
            : null,
        ]
          .filter(Boolean)
          .join(' '),
        disable: pause,
        forgetVariant,
        nextCheckAt:
          evaluated.outcome === 'failed'
            ? nextCheckAfterFailure({
                failures,
                retryable: false,
                intervalMs,
                now: Date.now(),
              })
            : nextOk(),
      })
    }

    // A solver reading came from its own page; the fetched one is stale.
    let review = await reviewWithAi({
      observation: evaluated.observation,
      html: method === 'solver' ? solverPage?.html : reading?.check.html,
      source,
      knife,
      settings: aiSettings,
      notifications: { notify, thresholds, ignoreOfficialOutOfStock },
      implausible,
      parserReading: method !== 'ai' && method !== 'solver',
      signal: options.signal,
    })
    // AI doubts the reading: the solver looks for the tracked product's own
    // price on the page; a different price it finds is checked again.
    if (
      (review.aiReview === 'unconfirmed' || review.needsReview) &&
      source.status !== 'needs_review' &&
      method !== 'solver' &&
      solverMay('ai_doubt')
    ) {
      const doubted = evaluated.observation
      const expected = expectedVariantFor(source)
      const solved = await flow.solve({
        problem: {
          code: 'ai_doubt',
          message:
            'AI doubts the price read from this page: it may belong to another variant, a bundle or another product. Find the tracked product’s own price.',
        },
        settings: aiSettings,
        accept: acceptsPrice,
        signal: options.signal,
        acceptPage: expected
          ? async ({ url, html }) =>
              !variantMismatch(expected, readPageVariant(html, url))
          : undefined,
      })
      aiUsed = aiUsed || solved.aiCalls > 0
      if (solved.steps.length) solverSteps = solved.steps
      recovery = 'doubt:failed'
      const next = solved.offer
        ? evaluate(solved.offer, source, knife.specs.price)
        : null
      if (
        next?.kind === 'observation' &&
        (next.observation.priceMinor !== doubted.priceMinor ||
          next.observation.currency !== doubted.currency)
      ) {
        const second = await reviewWithAi({
          observation: next.observation,
          html: solved.html ?? undefined,
          source,
          knife,
          settings: aiSettings,
          notifications: { notify, thresholds, ignoreOfficialOutOfStock },
          implausible,
          parserReading: false,
          signal: options.signal,
        })
        if (second.aiReview !== 'unconfirmed') {
          evaluated = next
          method = 'solver'
          review = second
          recovery = 'doubt:fixed'
        }
      }
    }
    return done({
      outcome: 'ok',
      method,
      aiUsed,
      solverSteps,
      recovery,
      expectedVariant: learnedVariant,
      observation: evaluated.observation,
      aiReview: review.aiReview,
      needsReview: review.needsReview,
      errorCode: review.errorCode,
      errorMessage:
        [review.message, relinkNote].filter(Boolean).join(' ') || null,
      nextCheckAt: nextOk(evaluated.observation),
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'VaultAccessError') throw error
    const failure = toScrapeError(error)
    const status = upstreamStatus(error)
    // Sleep or a local outage is not the store's fault: no failure, no
    // streak, no circuit, no AI; the source runs again after the hold.
    const deferral = sleptSince(mark)
      ? 'suspended'
      : status === null &&
          failure.code === 'network' &&
          (await settleNetworkFailure(source.lane_key, options.signal))
        ? 'offline'
        : null
    if (deferral) {
      await deferSourceCheck(source.id, generation, {
        status: source.status,
        nextCheckAt: new Date(Date.now() + DEFER_CHECK_MS).toISOString(),
      })
      return { status: 'deferred', reason: deferral }
    }
    const outcome: CheckOutcomeKind = isBlockingFailure(error)
      ? 'blocked'
      : 'failed'
    const failures = source.consecutive_failures + 1
    const missing = status === 404 || status === 410
    const pause = missing && failures >= MISSING_PAGE_PAUSE_AFTER
    // BladeVault's own text for the code: the solver note can carry page
    // text (control labels, AI reasons) and never reaches the troubleshooter.
    const ownMessage = pause
      ? 'The page was not found three times in a row, so this source is paused. Check the URL, then resume it.'
      : messageFor(failure.code, failure)
    let errorMessage = withSolverNote(ownMessage)
    let nextCheckAt = nextCheckAfterFailure({
      failures,
      retryable: isRetryable(failure.code, status),
      intervalMs,
      now: Date.now(),
    })
    let disable = pause
    const ai = pause
      ? null
      : await recoverWithAi({
          source,
          settings: aiSettings,
          errorCode: failure.code,
          httpStatus: status,
          errorMessage: ownMessage,
          blocked: outcome === 'blocked',
          failures,
          trigger: options.trigger,
          defaultNextCheckAt: nextCheckAt,
          signal: options.signal,
        })
    const plan = ai?.plan ?? null
    if (plan) {
      if (plan.useBrowser)
        flow.host = {
          ...flow.host,
          strategy: 'browser_first',
          strategyUntil: new Date(Date.now() + BROWSER_PIN_MS).toISOString(),
          httpMatchStreak: 0,
        }
      if (plan.nextCheckAt) nextCheckAt = plan.nextCheckAt
      if (plan.pauseSource) {
        disable = true
        errorMessage =
          'AI paused this source because the product page seems to be gone. Check the URL, then resume it.'
      }
      if (plan.explanation)
        errorMessage = `${errorMessage} AI: ${plan.explanation}`
    } else if (ai?.note) {
      errorMessage = `${errorMessage} ${ai.note}`
    }
    const summary = await done(
      {
        outcome,
        method: null,
        httpStatus: status,
        errorCode: failure.code,
        errorMessage,
        nextCheckAt,
        disable,
        aiUsed: aiUsed || (ai?.attempted ?? false),
        solverSteps,
        recovery,
      },
      { retryAfterMs: retryAfterMs(error) },
    )
    if (plan?.resetCookies)
      await clearBrowserState(source.lane_key).catch(() => {})
    return summary
  } finally {
    operation.dispose()
  }
}
