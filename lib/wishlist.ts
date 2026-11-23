/**
 * Client-safe wishlist types, commands and price signals. The wishlist holds
 * knives from the vault that the collector plans to buy, grouped into
 * priority lanes. Each knife shows its own market price info (store price vs
 * regular price, 30-day trend, 90-day range) rather than a target.
 */
import { z } from 'zod'
import type { KnifeMarketSummary } from '@/lib/market-status'

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
