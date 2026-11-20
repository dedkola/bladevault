/**
 * Watchlist: knives the collector wants but does not own yet. They are
 * ordinary knife records flagged `wanted`, so Price Drops monitors them with
 * the same sources, schedule and pacing; the collection leaves them out.
 * Client-safe types and request parsing.
 */
import type { ChangeEvent, KnifeRef } from '@/lib/price-monitor/insights'
import { normalizeCurrencyCode, toMinorUnits } from '@/lib/price-monitor/money'
import type { TargetPrice } from '@/lib/price-monitor/notifications'
import type { PriceWatchEligibility } from '@/lib/price-monitor/shared'

export type WatchlistStock = 'in_stock' | 'out_of_stock' | 'unknown'

export type WatchlistItem = {
  knife: KnifeRef & { wanted: true }
  sourceUrl: string
  addedAt: string
  target: TargetPrice | null
  /** Scheduled monitoring covers it (it has an enabled source and is not off). */
  monitored: boolean
  reason: PriceWatchEligibility['reason']
  /** Active store listings. */
  sources: number
  /**
   * Lowest in-stock price, in the target's currency when a target is set,
   * otherwise in the most common currency among the listings.
   */
  best: {
    priceMinor: number
    currency: string
    storeName: string
    url: string
  } | null
  /** Best price minus target; negative or 0 means at or below target. */
  gapMinor: number | null
  atTarget: boolean
  stock: WatchlistStock
  lastCheckedAt: string | null
  lastChange: ChangeEvent | null
}

export type Watchlist = { items: WatchlistItem[] }

export const MAX_TARGET_AMOUNT = 10_000_000

/**
 * Reads `{ amount, currency }` (or null to clear) into a target price.
 * Throws with a message fit for the form.
 */
export function parseTargetPriceInput(value: unknown): TargetPrice | null {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Target price must be an amount and a currency.')
  const { amount, currency } = value as Record<string, unknown>
  const number =
    typeof amount === 'string' ? Number(amount.replace(',', '.')) : amount
  if (
    typeof number !== 'number' ||
    !Number.isFinite(number) ||
    number <= 0 ||
    number > MAX_TARGET_AMOUNT
  )
    throw new Error('Enter a target price above 0.')
  const code = normalizeCurrencyCode(currency)
  if (!code) throw new Error('Choose a currency such as USD or EUR.')
  return { minor: toMinorUnits(number, code), currency: code }
}
