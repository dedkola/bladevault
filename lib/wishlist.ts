/**
 * Client-safe wishlist types, commands and price signals. The wishlist holds
 * knives from the vault that the collector plans to buy, grouped into
 * priority lanes. Each knife shows its own market price info (store price vs
 * regular price, 30-day trend, 90-day range) rather than a target.
 */
import { z } from 'zod'
import type { KnifeMarketSummary } from '@/lib/market-status'
import type { KnifeStoreEntry } from '@/lib/price-monitor/shared'

export const WISHLIST_REFRESH_EVENT = 'bladevault:wishlist-refresh'

export const WISHLIST_LANES = ['next', 'saving', 'someday'] as const
export type WishlistLane = (typeof WISHLIST_LANES)[number]

export type WishlistItem = {
  knifeId: string
  lane: WishlistLane
  /** Order within the lane, lowest first. */
  position: number
  /** The knife's price alert target, in minor units of `targetCurrency`. */
  targetMinor: number | null
  targetCurrency: string | null
  addedAt: string
}

/** Best in-stock store price per day, for the card sparkline. */
export type WishlistTrend = {
  currency: string | null
  /** Oldest first, one value per day; null where nothing was in stock. */
  daily: Array<number | null>
  /**
   * Best in-stock price at each change from `since`, oldest first: `at` is
   * epoch ms, `price` null while nothing was in stock. Drawn as steps.
   */
  steps: Array<{ at: number; price: number | null }>
  /** Chart start (epoch ms): when tracking began, at most 30 days ago. */
  since: number
  /** Chart end (epoch ms): when the trend was built. */
  until: number
  /** Lowest in-stock price over the last 90 days. */
  lowMinor: number | null
  /** Highest in-stock price over the last 90 days. */
  highMinor: number | null
}

export type WishlistBudget = {
  amountMinor: number | null
  currency: string | null
}

export type WishlistResponse = {
  items: WishlistItem[]
  trends: Record<string, WishlistTrend>
  budget: WishlistBudget
  /**
   * Where each knife is sold, store by store (price sources and Other
   * stores searches). Missing where the server does not monitor prices.
   */
  stores?: Record<string, KnifeStoreEntry[]>
  undo?: WishlistCommand
}

const knifeId = z.string().trim().min(1)
const lane = z.enum(WISHLIST_LANES)
const currency = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, 'Use a three-letter currency code.')
const minor = z.number().int().nonnegative().max(1_000_000_000)

export const wishlistItemSchema = z.object({
  knifeId,
  lane,
  position: z.number().int(),
  targetMinor: minor.nullable(),
  targetCurrency: currency.nullable(),
  addedAt: z.string(),
})

export const wishlistCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add'),
    knifeIds: z.array(knifeId).min(1).max(500),
    lane: lane.default('saving'),
  }),
  z.object({
    action: z.literal('remove'),
    knifeIds: z.array(knifeId).min(1).max(500),
  }),
  z.object({
    action: z.literal('move'),
    knifeId,
    lane,
    /** Drop before this knife in the lane; null or missing puts it last. */
    beforeKnifeId: knifeId.nullish(),
  }),
  z.object({
    action: z.literal('budget'),
    amountMinor: minor.nullable(),
    currency: currency.nullable(),
  }),
  z.object({
    action: z.literal('restore'),
    items: z.array(wishlistItemSchema).max(500),
  }),
])
export type WishlistCommand = z.infer<typeof wishlistCommandSchema>

/** Prices within half a percent of the regular price count as regular. */
export const WISHLIST_REGULAR_TOLERANCE = 0.005

export type WishlistDeal = 'sale' | 'regular' | 'above' | 'out' | 'unknown'

export const WISHLIST_DEALS: readonly WishlistDeal[] = [
  'sale',
  'regular',
  'above',
  'out',
  'unknown',
]

export const WISHLIST_DEAL_LABELS: Record<
  WishlistDeal,
  { title: string; hint: string }
> = {
  sale: { title: 'On sale now', hint: 'Below regular price' },
  regular: { title: 'Regular price', hint: 'No discount right now' },
  above: { title: 'Above regular', hint: 'Better to wait' },
  out: { title: 'Out of stock', hint: 'Watching for a restock' },
  unknown: { title: 'No store price yet', hint: 'Add a store link to compare' },
}

/** Relative change from `base` to `price`: -0.2 is 20% lower. */
export function priceChange(
  priceMinor: number | null,
  baseMinor: number | null,
): number | null {
  if (priceMinor === null || !baseMinor) return null
  return priceMinor / baseMinor - 1
}

/** Change from the first to the last priced day of the trend. */
export function trendChange(trend: WishlistTrend | undefined): number | null {
  const priced = (trend?.daily ?? []).filter(
    (value): value is number => value !== null,
  )
  if (priced.length < 2) return null
  return priceChange(priced[priced.length - 1], priced[0])
}

const DAY_MS = 86_400_000

/** A price change between two consecutive observed prices. */
export type WishlistMove = {
  /** Epoch ms of the snapshot that introduced `price`. */
  at: number
  price: number
  /** Change from the previous observed price; negative is a drop. */
  delta: number
}

/**
 * Price changes inside the tracked window, oldest first. Out-of-stock steps
 * (null price) are skipped, and a different price seen after a gap still
 * counts as a move. A lone first price is not a change.
 */
export function wishlistMoves(
  trend: WishlistTrend | undefined,
): WishlistMove[] {
  const moves: WishlistMove[] = []
  let previous: number | null = null
  for (const step of trend?.steps ?? []) {
    if (step.price === null) continue
    if (previous !== null && step.price !== previous)
      moves.push({
        at: step.at,
        price: step.price,
        delta: step.price - previous,
      })
    previous = step.price
  }
  return moves
}

/** Net direction of the moves: the last observed price against the first. */
export function wishlistTrendDirection(
  moves: WishlistMove[],
): 'down' | 'up' | 'flat' {
  const net = moves.reduce((sum, move) => sum + move.delta, 0)
  return net === 0 ? 'flat' : net < 0 ? 'down' : 'up'
}

/** Days of history the trend covers, at least 1. */
export function wishlistTrackedDays(
  trend: Pick<WishlistTrend, 'since' | 'until'>,
): number {
  return Math.max(1, Math.round((trend.until - trend.since) / DAY_MS))
}

/** Where a price sits between the 90-day low (0) and high (1). */
export function rangePosition(
  priceMinor: number | null,
  lowMinor: number | null,
  highMinor: number | null,
): number | null {
  if (
    priceMinor === null ||
    lowMinor === null ||
    highMinor === null ||
    highMinor <= lowMinor
  )
    return null
  return Math.min(
    1,
    Math.max(0, (priceMinor - lowMinor) / (highMinor - lowMinor)),
  )
}

/** Which deal group a knife belongs to, from its live store price. */
export function wishlistDeal({
  live,
  outOfStock,
  vsRegular,
}: {
  live: boolean
  outOfStock: boolean
  vsRegular: number | null
}): WishlistDeal {
  if (outOfStock) return 'out'
  if (!live) return 'unknown'
  if (vsRegular === null || Math.abs(vsRegular) <= WISHLIST_REGULAR_TOLERANCE)
    return 'regular'
  return vsRegular < 0 ? 'sale' : 'above'
}

/** Deal group straight from a knife's market summary (nav counts). */
export function wishlistSummaryDeal(
  summary:
    | Pick<
        KnifeMarketSummary,
        'bestPriceMinor' | 'currency' | 'paidMinor' | 'outOfStock'
      >
    | undefined,
): WishlistDeal {
  const live = summary?.bestPriceMinor != null && Boolean(summary.currency)
  return wishlistDeal({
    live,
    outOfStock: Boolean(summary?.outOfStock),
    vsRegular: live
      ? priceChange(summary!.bestPriceMinor, summary!.paidMinor)
      : null,
  })
}

/** A store selling the knife now, for a row's "Best stores" list. */
export type WishlistStorePrice = {
  key: string
  label: string
  url: string
  priceMinor: number
}

/**
 * Stores selling the knife now in `currency`, cheapest first: enabled
 * listings with a price that are not out of stock (the same sources the
 * market summary's best price comes from).
 */
export function wishlistStorePrices(
  entries: readonly KnifeStoreEntry[] | undefined,
  currency: string | null,
): WishlistStorePrice[] {
  if (!entries || !currency) return []
  const prices: WishlistStorePrice[] = []
  for (const entry of entries) {
    const source = entry.source
    if (
      entry.state !== 'listed' ||
      !source?.enabled ||
      source.priceMinor === null ||
      source.currency !== currency ||
      source.availability === 'out_of_stock'
    )
      continue
    prices.push({
      key: entry.laneKey,
      label: entry.label,
      url: source.url,
      priceMinor: source.priceMinor,
    })
  }
  return prices.sort(
    (a, b) => a.priceMinor - b.priceMinor || a.label.localeCompare(b.label),
  )
}
