/**
 * Client-safe market summary for collection cards, the table column and the
 * `market=` collection filter. The server builds one summary per knife from
 * price monitoring (`lib/price-monitor/market-summary.ts`); the browser only
 * reads it.
 */
import { formatMoney } from '@/lib/price-monitor/money'

/** A price drop counts as recent while it is this many days old or newer. */
export const MARKET_DROP_WINDOW_DAYS = 30
/** A restock counts as recent while it is this many days old or newer. */
export const MARKET_RESTOCK_WINDOW_DAYS = 7

export type KnifeMarketSummary = {
  /** Scheduled monitoring covers this knife. */
  monitored: boolean
  /** Enabled store links. */
  sources: number
  /** Lowest in-stock price in the most common currency among the stores. */
  bestPriceMinor: number | null
  currency: string | null
  /** Purchase price in the same currency, when comparable. */
  paidMinor: number | null
  /** Every store that was read lists the knife as out of stock. */
  outOfStock: boolean
  /** When the last store ran out (out of stock only). */
  outOfStockSince: string | null
  /** The latest drop that still holds, within the drop window. */
  droppedAt: string | null
  dropPct: number | null
  /** The latest return to stock within the restock window. */
  restockedAt: string | null
  lastCheckedAt: string | null
}

export type MarketSummaryMap = ReadonlyMap<string, KnifeMarketSummary>

export const MARKET_FILTER_VALUES = [
  'dropped',
  'restocked',
  'out_of_stock',
  'below_paid',
  'monitored',
  'not_monitored',
] as const
export type MarketFilterValue = (typeof MARKET_FILTER_VALUES)[number]

export const MARKET_PARAM = 'market'

export const MARKET_FILTER_LABELS: Record<MarketFilterValue, string> = {
  dropped: 'Price dropped recently',
  restocked: 'Back in stock recently',
  out_of_stock: 'Out of stock',
  below_paid: 'Below what I paid',
  monitored: 'Monitored',
  not_monitored: 'Not monitored',
}

export function isMarketFilterValue(value: string): value is MarketFilterValue {
  return (MARKET_FILTER_VALUES as readonly string[]).includes(value)
}

export function isBelowPaid(summary: KnifeMarketSummary | undefined): boolean {
  return Boolean(
    summary &&
    !summary.outOfStock &&
    summary.bestPriceMinor !== null &&
    summary.paidMinor !== null &&
    summary.bestPriceMinor < summary.paidMinor,
  )
}

/** Whether one knife meets one market condition. */
export function matchesMarketCondition(
  summary: KnifeMarketSummary | undefined,
  value: MarketFilterValue,
): boolean {
  switch (value) {
    case 'monitored':
      return Boolean(summary?.monitored)
    case 'not_monitored':
      return !summary?.monitored
    case 'dropped':
      return Boolean(summary?.droppedAt)
    case 'restocked':
      return Boolean(summary?.restockedAt)
    case 'out_of_stock':
      return Boolean(summary?.outOfStock)
    case 'below_paid':
      return isBelowPaid(summary)
  }
}

/** Selected conditions combine like other filter values: any one matches. */
export function matchesMarketFilter(
  summary: KnifeMarketSummary | undefined,
  values: readonly MarketFilterValue[],
): boolean {
  return (
    values.length === 0 ||
    values.some((value) => matchesMarketCondition(summary, value))
  )
}

export function countMarketConditions(
  knifeIds: readonly string[],
  summaries: MarketSummaryMap,
): Record<MarketFilterValue, number> {
  const counts = Object.fromEntries(
    MARKET_FILTER_VALUES.map((value) => [value, 0]),
  ) as Record<MarketFilterValue, number>
  for (const id of knifeIds) {
    const summary = summaries.get(id)
    for (const value of MARKET_FILTER_VALUES)
      if (matchesMarketCondition(summary, value)) counts[value] += 1
  }
  return counts
}

/** The one state a card or cell leads with, most notable first. */
export type MarketTone =
  'dropped' | 'restocked' | 'out_of_stock' | 'below_paid' | 'steady' | 'none'

export function marketTone(
  summary: KnifeMarketSummary | undefined,
): MarketTone {
  if (!summary) return 'none'
  if (summary.outOfStock) return 'out_of_stock'
  if (summary.droppedAt) return 'dropped'
  if (summary.restockedAt) return 'restocked'
  if (isBelowPaid(summary)) return 'below_paid'
  return summary.bestPriceMinor !== null ? 'steady' : 'none'
}

function formatPct(value: number): string {
  const abs = Math.abs(value)
  return `${abs >= 10 ? Math.round(abs) : abs.toFixed(1).replace(/\.0$/, '')}%`
}

/**
 * Short text for a card pill or table cell, e.g. "$89.00 · ↓ 12%",
 * "$89.00 · Back in stock", "Out of stock", or "$89.00 · Below paid".
 * Empty when there is nothing to show.
 */
export function marketLabel(summary: KnifeMarketSummary | undefined): string {
  if (!summary) return ''
  const price =
    summary.bestPriceMinor !== null && summary.currency
      ? formatMoney(summary.bestPriceMinor, summary.currency)
      : ''
  const parts: string[] = []
  if (summary.outOfStock) parts.push('Out of stock')
  else if (price) parts.push(price)
  if (!summary.outOfStock) {
    if (summary.droppedAt)
      parts.push(
        summary.dropPct === null
          ? 'Dropped'
          : `↓ ${formatPct(summary.dropPct)}`,
      )
    else if (summary.restockedAt) parts.push('Back in stock')
    if (isBelowPaid(summary)) parts.push('Below paid')
  }
  return parts.join(' · ')
}

/** A longer description for tooltips and screen readers. */
export function marketDescription(
  summary: KnifeMarketSummary | undefined,
): string {
  if (!summary) return 'Not monitored'
  const label = marketLabel(summary)
  const notes: string[] = []
  if (label) notes.push(`Best market price: ${label}`)
  if (summary.paidMinor !== null && summary.currency)
    notes.push(`You paid ${formatMoney(summary.paidMinor, summary.currency)}`)
  if (!summary.monitored) notes.push('Not monitored')
  return notes.join('. ') || 'No market price yet'
}

const TONE_RANK: Record<MarketTone, number> = {
  dropped: 0,
  restocked: 1,
  below_paid: 2,
  steady: 3,
  out_of_stock: 4,
  none: 5,
}

/**
 * Table sort: notable states first (drops, restocks, below paid), then the
 * rest by price; knives without a market reading stay last.
 */
export function marketSortValue(
  summary: KnifeMarketSummary | undefined,
): number | undefined {
  const tone = marketTone(summary)
  if (tone === 'none') return undefined
  return (
    TONE_RANK[tone] * 1e12 + Math.min(1e12 - 1, summary?.bestPriceMinor ?? 0)
  )
}

/** Turns the API's plain object into the map the providers share. */
export function toMarketSummaryMap(
  value: unknown,
): Map<string, KnifeMarketSummary> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return new Map()
  return new Map(
    Object.entries(value as Record<string, KnifeMarketSummary>).filter(
      ([, summary]) => summary && typeof summary === 'object',
    ),
  )
}

/** Dispatched after a price check or a store-link change for a knife. */
export const PRICE_DATA_UPDATED_EVENT = 'bladevault:price-data-updated'

export function announcePriceDataUpdated(): void {
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event(PRICE_DATA_UPDATED_EVENT))
}
