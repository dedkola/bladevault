import type { Knife } from '@/lib/data'
import { getLocalDb } from '@/lib/local-db'
import { aiConfigured } from '@/lib/price-monitor/ai'
import {
  AiClientError,
  aiBudgetRefusal,
  type AiEndpoint,
} from '@/lib/price-monitor/ai-client'
import {
  loadBrowserState,
  saveBrowserState,
} from '@/lib/price-monitor/browser-state'
import {
  buildSearchQueries,
  knifeIdentity,
  matchSearchResults,
  pageShowsModelNumber,
  verifyProductPage,
} from '@/lib/price-monitor/discovery-ai'
import {
  DISCOVERY_STORES,
  type DiscoveryCandidate,
  type DiscoveryStore,
} from '@/lib/price-monitor/discovery-stores'
import {
  readDiscoveryQueue,
  recordDiscovery,
  type DiscoveryStatus,
} from '@/lib/price-monitor/discovery-store'
import { retryAfterMs, type LaneOutcomeKind } from '@/lib/price-monitor/engine'
import {
  checkViaBrowser,
  fetchStoreJson,
  upstreamStatus,
} from '@/lib/price-monitor/fetch'
import {
  productPageAcceptor,
  productPageUrl,
  relinkSearch,
} from '@/lib/price-monitor/recovery'
import { withRegionCookies } from '@/lib/price-monitor/region'
import { readPriceAiKey } from '@/lib/price-monitor/secrets'
import { laneKeyForUrl } from '@/lib/price-monitor/shared'
import {
  solveOnPage,
  solverLimits,
  type SolverResult,
} from '@/lib/price-monitor/solver'
import { isNetworkBlockError } from '@/lib/scrape'
import { toScrapeError } from '@/lib/scrape-errors'
import { getShopifyProductJsUrl } from '@/lib/scrape-offer'
import { createScrapeOperation, runWithSignal } from '@/lib/scrape-operation'
import type { BrowserStorageState } from '@/lib/scrape-playwright'
import { getSettings } from '@/lib/settings'
import {
  OTHER_STORE_IDS,
  type OtherStoreId,
  type PriceAiSettings,
  type PriceMonitoringSettings,
} from '@/lib/settings-shared'
import { readAmazonPageViaHttp } from '@/lib/price-monitor/amazon-session'
import { getStorage } from '@/lib/storage'
import { getVaultAccessState } from '@/lib/vault-access'

/**
 * Other stores: AI looks for a monitored knife at the stores turned on in
 * settings (Blade HQ, SMKW, DLT Trading, KnifeJoy, Northwest Knives,
 * Amazon). It reads the store's search results (Shopify stores: their search
 * JSON; Amazon: plain HTTP with a US delivery session; both without the
 * browser) and
 * picks the knife, then reads the product page and confirms it; only then
 * does the product become a price source, checked and parsed like every
 * other source from then on. A store's searches share its lane with its
 * price checks (one request at a time, its pace and its pauses).
 */
export const DISCOVERY_STORE: OtherStoreId = 'bladehq'
/** Two searches, a product page and three AI answers fit in this. */
const DISCOVERY_BUDGET_MS = 240_000
/** AI browsing the store: the solver's own time plus its page checks. */
const BROWSE_MARGIN_MS = 60_000

export type DiscoveryPage = { html: string; finalUrl: string }

export type DiscoveryDeps = {
  /** Renders a store page with the lane's cookies (Playwright by default). */
  fetchPage: (
    url: string,
    signal: AbortSignal,
    laneKey: string,
  ) => Promise<DiscoveryPage>
  match: typeof matchSearchResults
  verify: typeof verifyProductPage
  readKey: () => Promise<string | null>
  getKnife: (id: string) => Promise<Knife | null | undefined>
  /**
   * When the store's search turned up nothing usable: AI browses the store
   * in the monitoring browser (its search box, menus, categories) and
   * returns the product page it confirmed, or why it found none.
   */
  browse: (input: BrowseInput) => Promise<BrowseResult>
}

export type BrowseInput = {
  store: DiscoveryStore
  knife: Knife
  settings: PriceAiSettings
  endpoint: AiEndpoint
  signal: AbortSignal
}

export type BrowseResult = {
  page: DiscoveryPage | null
  /** Why nothing was found, for the search's detail line. */
  note: string | null
}

/** The store's home page, where AI starts browsing. */
function storeHome(store: DiscoveryStore): string {
  return `${new URL(store.searchUrl('knife')).origin}/`
}

/**
 * The AI problem solver, started on the store's home page with the knife's
 * search terms. It stays on the store's site, never buys or signs in, and
 * only stops on a page that shows the knife's model number and that AI
 * confirmed (recovery, productPageAcceptor).
 */
async function browseStore(input: BrowseInput): Promise<BrowseResult> {
  const { store, knife, settings, endpoint } = input
  const limits = solverLimits(settings)
  const operation = createScrapeOperation({
    signal: input.signal,
    timeoutMs: limits.budgetMs,
  })
  let result: SolverResult | null = null
  try {
    const storageState = await loadBrowserState(store.laneKey)
    await checkViaBrowser(storeHome(store), operation, {
      storageState,
      budgetMs: limits.budgetMs,
      interact: async (page) => {
        result = await solveOnPage(page, {
          problem: {
            code: 'find_product',
            message: `The ${store.label} search results did not lead to this knife. Find its product page on this store.`,
          },
          // Other stores are read in USD from the US edition.
          currencyHint: 'USD',
          settings,
          endpoint,
          accept: (offer) =>
            offer.amount !== null || offer.availability === 'out_of_stock',
          signal: operation.signal,
          maxSteps: limits.maxSteps,
          acceptPage: productPageAcceptor({
            knife,
            endpoint,
            model: settings.model,
            signal: operation.signal,
          }),
          search: relinkSearch(knife),
        })
      },
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'VaultAccessError') throw error
    if (!result) {
      const code = toScrapeError(error).code
      return {
        page: null,
        note:
          code === 'challenge'
            ? `AI reached a bot check while browsing ${store.label}.`
            : `AI could not browse ${store.label}.`,
      }
    }
  } finally {
    operation.dispose()
  }
  const solved = result as SolverResult | null
  const url = solved?.finalUrl ? productPageUrl(solved.finalUrl) : null
  // Only a product page of this store, never a page AI wandered off to.
  if (
    solved?.offer &&
    url &&
    solved.html &&
    laneKeyForUrl(url) === store.laneKey
  )
    return { page: { html: solved.html, finalUrl: url }, note: null }
  return {
    page: null,
    note:
      solved?.status === 'challenge'
        ? `AI reached a bot check while browsing ${store.label}.`
        : `AI also browsed ${store.label} and did not find it.`,
  }
}

async function renderWithLaneCookies(
  url: string,
  signal: AbortSignal,
  laneKey: string,
): Promise<DiscoveryPage> {
  const { fetchRenderedHtml } = await import('@/lib/scrape-playwright')
  const operation = createScrapeOperation({ signal, timeoutMs: 60_000 })
  try {
    const storageState: BrowserStorageState | undefined =
      await loadBrowserState(laneKey)
    const page = await fetchRenderedHtml(url, operation, {
      screenshot: false,
      light: true,
      captureStorageState: true,
      // Found listings are checked in USD from the US edition, as price checks are.
      storageState: withRegionCookies(url, storageState),
    })
    if (page.storageState)
      await saveBrowserState(laneKey, page.storageState).catch(() => {})
    return { html: page.html, finalUrl: page.finalUrl }
  } finally {
    operation.dispose()
  }
}

/**
 * Shopify stores: one plain HTTP request for their JSON. A search URL is
 * fetched as it is (search suggestions); a product link is read through
 * `/products/<handle>.js` and keeps its storefront URL as the source.
 */
async function fetchShopifyJson(
  url: string,
  signal: AbortSignal,
): Promise<DiscoveryPage> {
  const operation = createScrapeOperation({ signal, timeoutMs: 30_000 })
  try {
    const productJs = getShopifyProductJsUrl(url)
    const { body, finalUrl } = await fetchStoreJson(productJs ?? url, operation)
    return { html: body, finalUrl: productJs ? url : finalUrl }
  } finally {
    operation.dispose()
  }
}

/**
 * Amazon over plain HTTP with the lane's US delivery session (postcode
 * 90210), the same session its price checks use.
 */
async function fetchAmazonPage(
  url: string,
  signal: AbortSignal,
  laneKey: string,
): Promise<DiscoveryPage> {
  const operation = createScrapeOperation({ signal, timeoutMs: 60_000 })
  try {
    const page = await readAmazonPageViaHttp(url, operation, laneKey)
    return { html: page.html, finalUrl: page.finalUrl }
  } finally {
    operation.dispose()
  }
}

/**
 * Shopify stores through their JSON, Amazon over HTTP, every other store in
 * the browser.
 */
function fetchDiscoveryPage(
  url: string,
  signal: AbortSignal,
  laneKey: string,
): Promise<DiscoveryPage> {
  if (laneKey === DISCOVERY_STORES.amazon.laneKey)
    return fetchAmazonPage(url, signal, laneKey)
  const shopify = Object.values(DISCOVERY_STORES).some(
    (store) => store.shopify && store.laneKey === laneKey,
  )
  return shopify
    ? fetchShopifyJson(url, signal)
    : renderWithLaneCookies(url, signal, laneKey)
}

const realDeps: DiscoveryDeps = {
  fetchPage: fetchDiscoveryPage,
  match: matchSearchResults,
  verify: verifyProductPage,
  readKey: readPriceAiKey,
  getKnife: (id) => getStorage().getKnifeById(id),
  browse: browseStore,
}

export type DiscoverySummary =
  | {
      status: 'skipped'
      reason: 'disabled' | 'missing' | 'read_only' | 'not_owner'
    }
  | {
      status: 'done'
      result: DiscoveryStatus
      /** For the store lane's pacing and circuit breaker. */
      laneOutcome: LaneOutcomeKind
      /** The AI endpoint itself failed: pause discovery for a while. */
      aiProblem: boolean
      durationMs: number
      retryAfterMs: number | null
      sourceId: number | null
    }

/** Stores turned on in Other stores, in search order. */
export function enabledDiscoveryStores(
  settings: PriceMonitoringSettings,
): OtherStoreId[] {
  if (!settings.otherStores.enabled || !aiConfigured(settings.ai)) return []
  return OTHER_STORE_IDS.filter((id) => settings.otherStores.stores[id])
}

/** Other stores runs for this store (or for any store when left out). */
export function discoveryActive(
  settings: PriceMonitoringSettings,
  store?: OtherStoreId,
): boolean {
  const stores = enabledDiscoveryStores(settings)
  return store ? stores.includes(store) : stores.length > 0
}

/** The next knife to look for at a store, or null when none is due. */
export function nextDiscoveryKnife(
  settings: PriceMonitoringSettings,
  now = Date.now(),
  store: OtherStoreId = DISCOVERY_STORE,
): string | null {
  if (!discoveryActive(settings, store)) return null
  const config = DISCOVERY_STORES[store]
  return (
    readDiscoveryQueue(getLocalDb(), {
      settings,
      store,
      marketplace: config.marketplace,
      laneKey: config.laneKey,
      now,
    })[0] ?? null
  )
}

function pageFailure(
  error: unknown,
  store: DiscoveryStore,
): {
  result: DiscoveryStatus
  laneOutcome: LaneOutcomeKind
  detail: string
  retryAfterMs: number | null
} {
  const failure = toScrapeError(error)
  const status = upstreamStatus(error)
  if (isNetworkBlockError(error))
    return {
      result: 'blocked',
      laneOutcome: 'blocked',
      detail: `${store.label} blocks visitors from this network or IP address, so it cannot be searched from here. This is not a bot check that can be solved; BladeVault will try again later, and searches may work from another network.`,
      retryAfterMs: null,
    }
  if (failure.code === 'challenge' || status === 403)
    return {
      result: 'blocked',
      laneOutcome: 'blocked',
      detail: `${store.label} showed a bot check. BladeVault will try again later.`,
      retryAfterMs: null,
    }
  if (status === 429 || status === 503)
    return {
      result: 'failed',
      laneOutcome: 'throttled',
      detail: `${store.label} asked BladeVault to slow down.`,
      // The lane waits at least as long as the store asked.
      retryAfterMs: retryAfterMs(error),
    }
  const neutral = ['browser', 'cancelled', 'invalid_url', 'blocked_url']
  return {
    result: 'failed',
    laneOutcome: neutral.includes(failure.code) ? 'neutral' : 'failed',
    detail:
      failure.code === 'browser'
        ? 'The monitoring browser could not start.'
        : `${store.label} could not be loaded.`,
    retryAfterMs: null,
  }
}

/**
 * Looks for one knife at a store and
 * records the result. AI endpoint problems are not the knife's fault:
 * nothing is recorded for it, and the caller pauses discovery instead.
 */
export async function discoverKnife(
  knifeId: string,
  options: {
    signal?: AbortSignal
    deps?: Partial<DiscoveryDeps>
    store?: OtherStoreId
    /**
     * The price worker asks whether it still holds the vault's lease before
     * the result is saved (price-monitor/store, ownsWorkerLease).
     */
    canWrite?: () => boolean
  } = {},
): Promise<DiscoverySummary> {
  const deps = { ...realDeps, ...options.deps }
  const storeId = options.store ?? DISCOVERY_STORE
  const store = DISCOVERY_STORES[storeId]
  if (!store) return { status: 'skipped', reason: 'disabled' }
  const access = getVaultAccessState()
  if (access.readOnly) return { status: 'skipped', reason: 'read_only' }
  const settings = getSettings().priceMonitoring
  if (!discoveryActive(settings, storeId))
    return { status: 'skipped', reason: 'disabled' }
  const knife = await deps.getKnife(knifeId)
  if (!knife) return { status: 'skipped', reason: 'missing' }

  const marketplace = store.marketplace
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

  type Outcome = {
    result: DiscoveryStatus
    laneOutcome: LaneOutcomeKind
    url?: string | null
    title?: string | null
    confidence?: number | null
    detail?: string | null
    retryAfterMs?: number | null
  }
  const finish = async (input: Outcome): Promise<DiscoverySummary> => {
    if (options.canWrite && !options.canWrite())
      return { status: 'skipped', reason: 'not_owner' }
    const recorded = await recordDiscovery({
      generation: access.generation,
      knifeId,
      store: storeId,
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

  /**
   * The store's search found no listing, or its listing was turned down:
   * before that is recorded, AI browses the store itself (when AI may solve
   * problems in the browser). What it finds passed the model-number check
   * and AI's confirmation on the page.
   */
  const missed = async (outcome: Outcome): Promise<DiscoverySummary> => {
    if (!settings.ai.resolveErrors || aiBudgetRefusal('solver'))
      return finish(outcome)
    const limits = solverLimits(settings.ai)
    // Its own time: the search's budget may be mostly spent.
    const browseSignal = AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(limits.budgetMs + BROWSE_MARGIN_MS),
    ])
    let browsed: BrowseResult
    try {
      browsed = await deps.browse({
        store,
        knife,
        settings: settings.ai,
        endpoint,
        signal: browseSignal,
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'VaultAccessError')
        throw error
      if (options.signal?.aborted) throw error
      browsed = { page: null, note: `AI could not browse ${store.label}.` }
    }
    if (browsed.page) {
      const details = store.productDetails(
        browsed.page.html,
        browsed.page.finalUrl,
      )
      return finish({
        result: 'found',
        laneOutcome: 'success',
        url: browsed.page.finalUrl,
        title: details?.title ?? outcome.title ?? null,
        confidence: null,
        detail: `AI found it by browsing ${store.label} after the store's search did not lead to it.`,
      })
    }
    return finish({
      ...outcome,
      detail: [outcome.detail, browsed.note].filter(Boolean).join(' '),
    })
  }

  try {
    endpoint.apiKey = await deps.readKey()
    const queries = buildSearchQueries(identity)
    if (!queries.length)
      return await finish({
        result: 'skipped',
        laneOutcome: 'neutral',
        detail: 'The knife has no name or brand to search for.',
      })

    // No store request when AI may not answer today (daily budget).
    const refusal = aiBudgetRefusal('discovery_search')
    if (refusal) throw new AiClientError('budget', refusal)

    /** A page load that always ends when the search's time budget does. */
    const load = (url: string) =>
      runWithSignal(signal, () => deps.fetchPage(url, signal, store.laneKey))
    const loadFailure = (error: unknown) =>
      controller.signal.aborted
        ? {
            result: 'failed' as const,
            laneOutcome: 'neutral' as const,
            detail: 'The search took too long.',
            retryAfterMs: null,
          }
        : pageFailure(error, store)

    // 1. Find: the search results page, read by AI. With the model number
    // first, then brand and name only when that finds nothing.
    let candidates: DiscoveryCandidate[] = []
    let match: Awaited<ReturnType<DiscoveryDeps['match']>> | null = null
    let aiNotFound = ''
    const emptyQueries: string[] = []
    for (const query of queries) {
      let searchPage: DiscoveryPage
      try {
        searchPage = await load(store.searchUrl(query))
      } catch (error) {
        if (signal.aborted && options.signal?.aborted) throw error
        return await finish(loadFailure(error))
      }
      candidates = store.parseResults(searchPage.html, searchPage.finalUrl)
      if (!candidates.length) {
        // A page that is not the store's result list says nothing about the
        // knife: try again later rather than record it as not there.
        if (store.emptySearch?.(searchPage.html) === 'unreadable')
          return await finish({
            result: 'failed',
            laneOutcome: 'neutral',
            detail: `The ${store.label} search page could not be read.`,
          })
        emptyQueries.push(query)
        continue
      }
      match = await deps.match({
        endpoint,
        model: settings.ai.model,
        knife: identity,
        candidates,
        signal,
      })
      if (match.candidate) break
      aiNotFound = match.reason || 'AI found no listing of this knife.'
    }
    if (!match?.candidate)
      return await missed({
        result: 'not_found',
        laneOutcome: 'success',
        confidence: match?.confidence ?? null,
        detail:
          aiNotFound ||
          `${store.label} had no results for ${emptyQueries
            .map((query) => `“${query}”`)
            .join(' or ')}.`,
      })

    // 2. Check: the product page, confirmed by AI.
    const chosen = match.candidate
    const url = candidates.find((item) => item.id === chosen.id)?.url
    if (!url)
      return await finish({
        result: 'failed',
        laneOutcome: 'success',
        title: chosen.title,
        detail: 'AI returned no usable product link.',
      })
    let productPage: DiscoveryPage
    try {
      productPage = await load(url)
    } catch (error) {
      if (signal.aborted && options.signal?.aborted) throw error
      return await finish({ ...loadFailure(error), url })
    }
    const details = store.productDetails(productPage.html, url)
    if (!details)
      return await finish({
        result: 'failed',
        laneOutcome: 'success',
        url,
        title: match.candidate.title,
        detail: `The ${store.label} product page could not be read.`,
      })
    const verdict = await deps.verify({
      endpoint,
      model: settings.ai.model,
      knife: identity,
      page: details,
      signal,
    })
    if (!verdict.accepted)
      return await missed({
        result: 'rejected',
        laneOutcome: 'success',
        url,
        title: details.title,
        confidence: verdict.confidence,
        detail:
          verdict.reason || 'AI decided the product page sells another item.',
      })

    // The maker's model number decides the variant (steel, handle, colour):
    // without it on the page, AI's yes is not enough.
    if (
      !pageShowsModelNumber(
        identity.modelNumber,
        `${details.title}\n${details.details}`,
      )
    )
      return await missed({
        result: 'rejected',
        laneOutcome: 'success',
        url,
        title: details.title,
        confidence: verdict.confidence,
        detail: `The ${store.label} page does not show model number ${identity.modelNumber}.`,
      })

    // 3. Parse: from now on the source is checked like any other, with the
    // page parsers first and AI reading the price when they fail.
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
