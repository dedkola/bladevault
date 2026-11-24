/**
 * Client-safe price monitoring types, limits and URL helpers. Server modules
 * (store, engine) and UI components both import from here.
 */
import type { OfferAvailability } from '@/lib/scrape-offer'
import { isIsoCurrencyCode } from '@/lib/price-monitor/money'
import type { PriceAlertRules } from '@/lib/price-monitor/notifications'

export type Availability = OfferAvailability

/** A source can be muted for at most this many days. */
export const MAX_SOURCE_MUTE_DAYS = 365
/** Largest target price, in major units. */
export const MAX_TARGET_PRICE = 10_000_000

/** At most this many active sources per knife. */
export const MAX_PRICE_SOURCES_PER_KNIFE = 10

export const PRICE_WATCH_MODES = ['auto', 'on', 'off'] as const
/** auto: monitored when a regular price is stored; on/off: forced. */
export type PriceWatchMode = (typeof PRICE_WATCH_MODES)[number]

export const PRICE_SOURCE_STATUSES = [
  'pending',
  'checking',
  'ok',
  'price_unavailable',
  'out_of_stock',
  'failed',
  'blocked',
  /** AI doubts the page parser's price (spot check, Unlimited AI only). */
  'needs_review',
] as const
export type PriceSourceStatus = (typeof PRICE_SOURCE_STATUSES)[number]

export const FETCH_OVERRIDES = ['auto', 'browser', 'http'] as const
/** Per-source override of the store's learned fetch strategy. */
export type FetchOverride = (typeof FETCH_OVERRIDES)[number]

export type PriceProvider = 'amazon' | 'shopify' | 'generic'
export type PriceSourceOrigin = 'auto' | 'manual'

export type PriceSourceView = {
  id: number
  url: string
  storeName: string
  laneKey: string
  provider: PriceProvider
  origin: PriceSourceOrigin
  enabled: boolean
  fetchOverride: FetchOverride
  status: PriceSourceStatus
  lastCheckedAt: string | null
  lastSuccessAt: string | null
  lastPriceMinor: number | null
  lastCurrency: string | null
  lastAvailability: Availability | null
  lastError: string | null
  consecutiveFailures: number
  createdAt: string
  /** Notifications from this source are muted until then. */
  notifyMutedUntil: string | null
  /** Added by Other stores: AI found and confirmed this product. */
  foundByAi?: boolean
  /** Out of stock on the knife's own link, ignored by the setting. */
  stockIgnored?: boolean
  /** Start of the current out-of-stock run, when out of stock. */
  outOfStockSince?: string | null
  /** The listing may be gone for good: suggest Pause or another store. */
  retireHint?: RetireHint | null
}

/**
 * Why a listing may be gone for good: out of stock for 60 days or more, or
 * its page no longer exists (HTTP 404/410).
 */
export type RetireHint = 'long_out_of_stock' | 'page_gone'

export type EligibilityReason =
  | 'monitored_auto'
  | 'monitored_forced'
  | 'off'
  | 'no_price'
  | 'sold'
  | 'no_source'
  | 'out_of_scope'

export type PriceWatchEligibility = {
  monitored: boolean
  reason: EligibilityReason
}

export type PriceWatchView = {
  knifeId: string
  mode: PriceWatchMode
  eligibility: PriceWatchEligibility
  sources: PriceSourceView[]
  maxSources: number
  /** Source ids waiting for, or running, a manual check. */
  queuedSourceIds: number[]
  /** The knife's alert rules. */
  alerts: PriceAlertRules
  /** The stored regular price, for "only below regular price". */
  paid: { amount: number; currency: string } | null
  /** The AI supervisor watches this knife closely, while it lasts. */
  focus: PriceWatchFocus | null
  /** Where the knife is sold, per store (only the knife's GET answers it). */
  stores?: KnifeStoreEntry[]
}

/**
 * One store for one knife:
 * - listed: the knife has a price source there;
 * - variant: Other stores saw only other variants of the model there;
 * - not_sold: Other stores searched and did not find it;
 * - failed: the last search failed or met a bot check;
 * - waiting: Other stores has not searched there yet;
 * - off: not searched (a listing the collector removed is never added
 *   again; a knife with nothing to search for).
 */
export const KNIFE_STORE_STATES = [
  'listed',
  'variant',
  'not_sold',
  'failed',
  'waiting',
  'off',
] as const
export type KnifeStoreState = (typeof KNIFE_STORE_STATES)[number]

/** A listing of the same model in another variant: related, not monitored. */
export type KnifeStoreVariant = {
  url: string
  title: string
  /** As the store's search result showed it. */
  price: string | null
  seenAt: string
}

export type KnifeStoreEntry = {
  /** The store's lane: one entry per store. */
  laneKey: string
  label: string
  state: KnifeStoreState
  /** listed: the store's best active source (in stock and cheapest first). */
  source: {
    id: number
    url: string
    status: PriceSourceStatus
    priceMinor: number | null
    currency: string | null
    availability: Availability | null
    enabled: boolean
  } | null
  variants: KnifeStoreVariant[]
  /** Why there is no listing: the last search's explanation. */
  detail: string | null
  /** Other stores searches this store: when it last and next searches. */
  search: { lastAt: string | null; nextAt: string | null } | null
}

/** Checked at least every `intervalMs` until `until` (ISO), and why. */
export type PriceWatchFocus = {
  until: string
  intervalMs: number
  reason: string
}

/** Alert rule changes; a null target price clears it. */
export type PriceAlertRulesUpdate = {
  muted?: boolean
  belowPaid?: boolean
  targetPrice?: { amount: number; currency: string } | null
}

export type PriceWatchUpdate = {
  mode?: PriceWatchMode
  add?: Array<{ url: string; storeName?: string }>
  update?: Array<{
    id: number
    storeName?: string
    enabled?: boolean
    fetchOverride?: FetchOverride
    /** Mute the source's notifications for this many days; 0 unmutes. */
    muteDays?: number
  }>
  remove?: number[]
  alerts?: PriceAlertRulesUpdate
  /** End the AI supervisor's close watch on the knife. */
  stopWatching?: boolean
}

export type PriceCheckRequest =
  | { scope: 'knife' | 'source'; id: string }
  /** Every source scheduled monitoring covers, due now at the normal pace. */
  | { scope: 'all' }

// Two-label public suffixes common for stores; a heuristic, not the full PSL.
const TWO_LABEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'com.au',
  'net.au',
  'co.nz',
  'co.jp',
  'ne.jp',
  'or.jp',
  'com.br',
  'com.mx',
  'com.ar',
  'com.co',
  'com.tr',
  'co.za',
  'com.sg',
  'com.my',
  'com.ph',
  'com.hk',
  'com.tw',
  'com.cn',
  'co.kr',
  'co.in',
  'com.be',
])

// Cross-site trackers only: store-specific parameters can pick the variant.
const TRACKING_PARAMS =
  /^(?:utm_.+|fbclid|gclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|srsltid|_pos|_sid|_ss|_psq|ref)$/i

export function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/**
 * Amazon links of any marketplace, including amzn.to and a.co short links.
 * Their pages are checked like any store's; Price Drops' AI steps (reading
 * the price with AI, solving or troubleshooting checks) leave them alone.
 */
export function isAmazonUrl(value: string): boolean {
  const url = parseHttpUrl(value)
  return Boolean(
    url &&
    /(?:^|\.)(?:amazon\.[a-z.]+|amzn\.[a-z]+|a\.co)$/i.test(url.hostname),
  )
}

function isAmazonHost(host: string): boolean {
  return /(?:^|\.)amazon\.[a-z.]+$/i.test(host)
}

function amazonAsin(url: URL): string | null {
  return (
    url.pathname
      .match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1]
      ?.toUpperCase() ?? null
  )
}

/**
 * Identity of a source URL for de-duplication: lower-case host, no hash, no
 * tracking parameters; Amazon product links collapse to `/dp/<ASIN>`.
 */
export function normalizeSourceUrl(value: string): string | null {
  const url = parseHttpUrl(value)
  if (!url) return null
  url.hostname = url.hostname.toLowerCase()
  url.hash = ''
  if (isAmazonHost(url.hostname)) {
    const asin = amazonAsin(url)
    if (asin) return `https://${url.hostname}/dp/${asin}`
  }
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key)
  }
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '')
  return url.href
}

/** Registrable domain, e.g. "shop.vosteed.com" → "vosteed.com". */
export function registrableDomain(host: string): string {
  const clean = host
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '')
  if (/^[\d.]+$/.test(clean) || clean.includes(':')) return clean
  const labels = clean.split('.')
  if (labels.length <= 2) return clean
  const lastTwo = labels.slice(-2).join('.')
  return TWO_LABEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo
}

/**
 * Scheduling lane of a URL: one per store, so a store never sees two parallel
 * checks. All Amazon marketplaces share one lane and one bot protection.
 */
export function laneKeyForUrl(value: string): string {
  const url = parseHttpUrl(value)
  if (!url) return 'invalid'
  if (isAmazonHost(url.hostname)) return 'amazon'
  return registrableDomain(url.hostname)
}

export function storeNameForUrl(value: string): string {
  const url = parseHttpUrl(value)
  return url ? registrableDomain(url.hostname) : ''
}

/**
 * Stores known to run on Shopify (Other stores searches them through its
 * JSON): their product links are checked through `/products/<handle>.js`
 * from the first check, without loading the page.
 */
export const SHOPIFY_STORE_LANES: ReadonlySet<string> = new Set([
  'knifejoy.com',
  'northwestknives.com',
])

export function providerForUrl(value: string): PriceProvider {
  const url = parseHttpUrl(value)
  if (!url) return 'generic'
  if (isAmazonHost(url.hostname)) return 'amazon'
  if (
    SHOPIFY_STORE_LANES.has(registrableDomain(url.hostname)) &&
    /\/products\/[^/]+\/?$/.test(url.pathname)
  )
    return 'shopify'
  return 'generic'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function optionalStoreName(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('storeName must be text')
  const name = value.trim().replace(/\s+/g, ' ')
  if (name.length > 80) throw new Error('Store name is too long')
  return name
}

function parseAlertRules(value: unknown): PriceAlertRulesUpdate {
  if (!isRecord(value)) throw new Error('alerts must be an object')
  const rules: PriceAlertRulesUpdate = {}
  for (const key of ['muted', 'belowPaid'] as const) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'boolean')
      throw new Error(`${key} must be true or false`)
    rules[key] = value[key]
  }
  if (value.targetPrice === null) rules.targetPrice = null
  else if (value.targetPrice !== undefined) {
    const target = value.targetPrice
    if (
      !isRecord(target) ||
      typeof target.amount !== 'number' ||
      !Number.isFinite(target.amount) ||
      target.amount <= 0 ||
      target.amount > MAX_TARGET_PRICE
    )
      throw new Error('Enter a target price above 0.')
    const currency =
      typeof target.currency === 'string' ? target.currency.toUpperCase() : ''
    if (!isIsoCurrencyCode(currency))
      throw new Error('Choose the target price currency.')
    rules.targetPrice = { amount: target.amount, currency }
  }
  return rules
}

/** Validates a PUT body for /api/knives/[id]/price-watch. */
export function parsePriceWatchUpdate(body: unknown): PriceWatchUpdate {
  if (!isRecord(body)) throw new Error('Request body must be an object')
  const result: PriceWatchUpdate = {}
  if (body.mode !== undefined) {
    if (!(PRICE_WATCH_MODES as readonly unknown[]).includes(body.mode))
      throw new Error('mode must be auto, on or off')
    result.mode = body.mode as PriceWatchMode
  }
  if (body.add !== undefined) {
    if (
      !Array.isArray(body.add) ||
      body.add.length > MAX_PRICE_SOURCES_PER_KNIFE
    )
      throw new Error('add must be a list of sources')
    result.add = body.add.map((item) => {
      if (!isRecord(item) || typeof item.url !== 'string')
        throw new Error('Each new source needs a url')
      if (!normalizeSourceUrl(item.url))
        throw new Error(
          'Enter a valid product URL starting with http:// or https://.',
        )
      const storeName = optionalStoreName(item.storeName)
      return { url: item.url.trim(), ...(storeName ? { storeName } : {}) }
    })
  }
  if (body.update !== undefined) {
    if (!Array.isArray(body.update) || body.update.length > 50)
      throw new Error('update must be a list of source changes')
    result.update = body.update.map((item) => {
      if (!isRecord(item) || !Number.isSafeInteger(item.id))
        throw new Error('Each source change needs an id')
      const change: NonNullable<PriceWatchUpdate['update']>[number] = {
        id: item.id as number,
      }
      const storeName = optionalStoreName(item.storeName)
      if (storeName !== undefined) change.storeName = storeName
      if (item.enabled !== undefined) {
        if (typeof item.enabled !== 'boolean')
          throw new Error('enabled must be true or false')
        change.enabled = item.enabled
      }
      if (item.fetchOverride !== undefined) {
        if (
          !(FETCH_OVERRIDES as readonly unknown[]).includes(item.fetchOverride)
        )
          throw new Error('fetchOverride must be auto, browser or http')
        change.fetchOverride = item.fetchOverride as FetchOverride
      }
      if (item.muteDays !== undefined) {
        if (
          !Number.isSafeInteger(item.muteDays) ||
          (item.muteDays as number) < 0 ||
          (item.muteDays as number) > MAX_SOURCE_MUTE_DAYS
        )
          throw new Error(
            `muteDays must be a whole number from 0 to ${MAX_SOURCE_MUTE_DAYS}`,
          )
        change.muteDays = item.muteDays as number
      }
      return change
    })
  }
  if (body.alerts !== undefined) result.alerts = parseAlertRules(body.alerts)
  if (body.stopWatching !== undefined) {
    if (body.stopWatching !== true)
      throw new Error('stopWatching must be true when given')
    result.stopWatching = true
  }
  if (body.remove !== undefined) {
    if (
      !Array.isArray(body.remove) ||
      body.remove.length > 50 ||
      !body.remove.every((id) => Number.isSafeInteger(id))
    )
      throw new Error('remove must be a list of source ids')
    result.remove = body.remove as number[]
  }
  return result
}

/** Validates a POST body for /api/prices/check. */
export function parsePriceCheckRequest(body: unknown): PriceCheckRequest {
  if (!isRecord(body)) throw new Error('Request body must be an object')
  if (body.scope === 'all') return { scope: 'all' }
  if (body.scope !== 'knife' && body.scope !== 'source')
    throw new Error('scope must be knife, source or all')
  const id =
    typeof body.id === 'number' && Number.isSafeInteger(body.id)
      ? String(body.id)
      : typeof body.id === 'string' && body.id.trim()
        ? body.id.trim()
        : ''
  if (!id) throw new Error('id is required')
  if (body.scope === 'source' && !/^\d+$/.test(id))
    throw new Error('Source ids are numbers')
  return { scope: body.scope, id }
}
