import * as cheerio from 'cheerio'
import type { Knife } from '@/lib/data'
import { getLocalDb } from '@/lib/local-db'
import { aiConfigured } from '@/lib/price-monitor/ai'
import { AiClientError, type AiEndpoint } from '@/lib/price-monitor/ai-client'
import {
  loadBrowserState,
  saveBrowserState,
} from '@/lib/price-monitor/browser-state'
import {
  amazonProductUrl,
  amazonSearchUrl,
  buildSearchQuery,
  knifeIdentity,
  matchSearchResults,
  parseAmazonSearchResults,
  verifyProductPage,
  type ProductPageDetails,
} from '@/lib/price-monitor/discovery-ai'
import {
  readDiscoveryQueue,
  recordDiscovery,
  type DiscoveryStatus,
} from '@/lib/price-monitor/discovery-store'
import type { LaneOutcomeKind } from '@/lib/price-monitor/engine'
import { upstreamStatus } from '@/lib/price-monitor/fetch'
import { readPriceAiKey } from '@/lib/price-monitor/secrets'
import { extractAmazonProduct } from '@/lib/scrape-amazon'
import { toScrapeError } from '@/lib/scrape-errors'
import { createScrapeOperation } from '@/lib/scrape-operation'
import type { BrowserStorageState } from '@/lib/scrape-playwright'
import { getSettings } from '@/lib/settings'
import type {
  AmazonMarketplace,
  PriceMonitoringSettings,
} from '@/lib/settings-shared'
import { getStorage } from '@/lib/storage'
import { getVaultAccessState } from '@/lib/vault-access'

/**
 * Other stores: AI looks for a monitored knife on Amazon. It reads the
 * search results and picks the knife, then reads the product page and
 * confirms it; only then does the product become a price source, checked
 * and parsed like every other source from then on. All Amazon traffic
 * shares the Amazon lane (one request at a time, its pace and its pauses).
 */
export const DISCOVERY_STORE = 'amazon' as const
export const DISCOVERY_LANE = 'amazon'
const DISCOVERY_BUDGET_MS = 120_000

export type DiscoveryPage = { html: string; finalUrl: string }

export type DiscoveryDeps = {
  /** Renders a store page with the lane's cookies (Playwright by default). */
  fetchPage: (url: string, signal: AbortSignal) => Promise<DiscoveryPage>
  match: typeof matchSearchResults
  verify: typeof verifyProductPage
  readKey: () => Promise<string | null>
  getKnife: (id: string) => Promise<Knife | null | undefined>
}

async function renderWithLaneCookies(
  url: string,
  signal: AbortSignal,
): Promise<DiscoveryPage> {
  const { fetchRenderedHtml } = await import('@/lib/scrape-playwright')
  const operation = createScrapeOperation({ signal, timeoutMs: 60_000 })
  try {
    const storageState: BrowserStorageState | undefined =
      await loadBrowserState(DISCOVERY_LANE)
    const page = await fetchRenderedHtml(url, operation, {
      screenshot: false,
      light: true,
      captureStorageState: true,
      storageState,
    })
    if (page.storageState)
      await saveBrowserState(DISCOVERY_LANE, page.storageState).catch(() => {})
    return { html: page.html, finalUrl: page.finalUrl }
  } finally {
    operation.dispose()
  }
}

const realDeps: DiscoveryDeps = {
  fetchPage: renderWithLaneCookies,
  match: matchSearchResults,
  verify: verifyProductPage,
  readKey: readPriceAiKey,
  getKnife: (id) => getStorage().getKnifeById(id),
}

export type DiscoverySummary =
  | { status: 'skipped'; reason: 'disabled' | 'missing' | 'read_only' }
  | {
      status: 'done'
      result: DiscoveryStatus
      /** For the Amazon lane's pacing and circuit breaker. */
      laneOutcome: LaneOutcomeKind
      /** The AI endpoint itself failed: pause discovery for a while. */
      aiProblem: boolean
      durationMs: number
      retryAfterMs: number | null
      sourceId: number | null
    }

export function discoveryActive(settings: PriceMonitoringSettings): boolean {
  return (
    settings.otherStores.enabled &&
    settings.otherStores.stores.amazon &&
    aiConfigured(settings.ai)
  )
}

/** The next knife to look for, or null when none is due. */
export function nextDiscoveryKnife(
  settings: PriceMonitoringSettings,
  now = Date.now(),
): string | null {
  if (!discoveryActive(settings)) return null
  return (
    readDiscoveryQueue(getLocalDb(), {
      settings,
      store: DISCOVERY_STORE,
      marketplace: settings.otherStores.amazonMarketplace,
      now,
    })[0] ?? null
  )
}

function productDetails(html: string, url: string): ProductPageDetails | null {
  const product = extractAmazonProduct(cheerio.load(html), url)
  if (!product?.title) return null
  const attributes = [...product.attributes]
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n')
  return {
    title: product.title,
    details: [attributes, product.description].filter(Boolean).join('\n\n'),
  }
}

function pageFailure(error: unknown): {
  result: DiscoveryStatus
  laneOutcome: LaneOutcomeKind
  detail: string
  retryAfterMs: number | null
} {
  const failure = toScrapeError(error)
  const status = upstreamStatus(error)
  if (failure.code === 'challenge' || status === 403)
    return {
      result: 'blocked',
      laneOutcome: 'blocked',
      detail: 'Amazon showed a bot check. BladeVault will try again later.',
      retryAfterMs: null,
    }
  if (status === 429 || status === 503)
    return {
      result: 'failed',
      laneOutcome: 'throttled',
      detail: 'Amazon asked BladeVault to slow down.',
      retryAfterMs: null,
    }
  const neutral = ['browser', 'cancelled', 'invalid_url', 'blocked_url']
  return {
    result: 'failed',
    laneOutcome: neutral.includes(failure.code) ? 'neutral' : 'failed',
    detail:
      failure.code === 'browser'
        ? 'The monitoring browser could not start.'
        : 'Amazon could not be loaded.',
    retryAfterMs: null,
  }
}

/**
 * Looks for one knife on the configured Amazon marketplace and records the
 * result. AI endpoint problems are not the knife's fault: nothing is
 * recorded for it, and the caller pauses discovery instead.
 */
export async function discoverKnife(
  knifeId: string,
  options: { signal?: AbortSignal; deps?: Partial<DiscoveryDeps> } = {},
): Promise<DiscoverySummary> {
  const deps = { ...realDeps, ...options.deps }
  const access = getVaultAccessState()
  if (access.readOnly) return { status: 'skipped', reason: 'read_only' }
  const settings = getSettings().priceMonitoring
  if (!discoveryActive(settings))
    return { status: 'skipped', reason: 'disabled' }
  const knife = await deps.getKnife(knifeId)
  if (!knife) return { status: 'skipped', reason: 'missing' }

  const marketplace: AmazonMarketplace = settings.otherStores.amazonMarketplace
  const startedAt = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_BUDGET_MS)
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal
  const identity = knifeIdentity(knife)
  const endpoint: AiEndpoint = {
    baseUrl: settings.ai.baseUrl,
    apiKey: null,
    headers: settings.ai.headers,
    maxAnswerTokens: settings.ai.maxAnswerTokens,
  }

  const finish = async (input: {
    result: DiscoveryStatus
    laneOutcome: LaneOutcomeKind
    url?: string | null
    title?: string | null
    confidence?: number | null
    detail?: string | null
    retryAfterMs?: number | null
  }): Promise<DiscoverySummary> => {
    const recorded = await recordDiscovery({
      generation: access.generation,
      knifeId,
      store: DISCOVERY_STORE,
      marketplace,
      status: input.result,
      url: input.url,
      title: input.title,
      confidence: input.confidence,
      detail: input.detail,
    })
    return {
      status: 'done',
      result: recorded.status,
      laneOutcome: input.laneOutcome,
      aiProblem: false,
      durationMs: Date.now() - startedAt,
      retryAfterMs: input.retryAfterMs ?? null,
      sourceId: recorded.sourceId,
    }
  }

  try {
    endpoint.apiKey = await deps.readKey()
    const query = buildSearchQuery(identity)
    if (!query)
      return await finish({
        result: 'skipped',
        laneOutcome: 'neutral',
        detail: 'The knife has no name or brand to search for.',
      })

    // 1. Find: the search results page, read by AI.
    let searchPage: DiscoveryPage
    try {
      searchPage = await deps.fetchPage(
        amazonSearchUrl(marketplace, query),
        signal,
      )
    } catch (error) {
      if (signal.aborted && options.signal?.aborted) throw error
      return await finish(pageFailure(error))
    }
    const candidates = parseAmazonSearchResults(searchPage.html)
    if (!candidates.length)
      return await finish({
        result: 'not_found',
        laneOutcome: 'success',
        detail: `Amazon had no results for “${query}”.`,
      })
    const match = await deps.match({
      endpoint,
      model: settings.ai.model,
      knife: identity,
      candidates,
      signal,
    })
    if (!match.candidate)
      return await finish({
        result: 'not_found',
        laneOutcome: 'success',
        confidence: match.confidence,
        detail: match.reason || 'AI found no listing of this knife.',
      })

    // 2. Check: the product page, confirmed by AI.
    const url = amazonProductUrl(marketplace, match.candidate.asin)
    let productPage: DiscoveryPage
    try {
      productPage = await deps.fetchPage(url, signal)
    } catch (error) {
      if (signal.aborted && options.signal?.aborted) throw error
      return await finish({ ...pageFailure(error), url })
    }
    const details = productDetails(productPage.html, url)
    if (!details)
      return await finish({
        result: 'failed',
        laneOutcome: 'success',
        url,
        title: match.candidate.title,
        detail: 'The Amazon product page could not be read.',
      })
    const verdict = await deps.verify({
      endpoint,
      model: settings.ai.model,
      knife: identity,
      page: details,
      signal,
    })
    if (!verdict.accepted)
      return await finish({
        result: 'rejected',
        laneOutcome: 'success',
        url,
        title: details.title,
        confidence: verdict.confidence,
        detail:
          verdict.reason || 'AI decided the product page sells another item.',
      })

    // 3. Parse: from now on the source is checked like any other, with the
    // Amazon parser first and AI reading the price when it fails.
    return await finish({
      result: 'found',
      laneOutcome: 'success',
      url,
      title: details.title,
      confidence: Math.min(match.confidence, verdict.confidence),
      detail: verdict.reason || match.reason || null,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'VaultAccessError') throw error
    if (options.signal?.aborted) throw error
    if (error instanceof AiClientError && error.code === 'cancelled')
      // Our own time budget ran out, not the caller's.
      return await finish({
        result: 'failed',
        laneOutcome: 'neutral',
        detail: 'The search took too long.',
      })
    if (
      error instanceof AiClientError ||
      (error instanceof Error && error.name === 'PriceAiKeyError')
    ) {
      return {
        status: 'done',
        result: 'failed',
        laneOutcome: 'neutral',
        aiProblem: true,
        durationMs: Date.now() - startedAt,
        retryAfterMs: null,
        sourceId: null,
      }
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
