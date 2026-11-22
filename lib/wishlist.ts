/**
 * Client-safe wishlist types, commands and price signals. The wishlist holds
 * knives from the vault that the collector plans to buy, grouped into
 * priority lanes. A knife's target price is its Price Drops alert target, so
 * reaching it also notifies.
 */
import { z } from 'zod'

export const WISHLIST_REFRESH_EVENT = 'bladevault:wishlist-refresh'

export const WISHLIST_LANES = ['next', 'saving', 'someday'] as const
export type WishlistLane = (typeof WISHLIST_LANES)[number]

export const WISHLIST_LANE_LABELS: Record<
  WishlistLane,
  { title: string; hint: string }
> = {
  next: { title: 'Next up', hint: 'Buying soon' },
  saving: { title: 'Saving for', hint: 'When the price is right' },
  someday: { title: 'Someday', hint: 'Dream list' },
}

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

/** A target counts as close while the price is at most this much above it. */
export const WISHLIST_CLOSE_RATIO = 1.1

export type WishlistSignal = 'buy' | 'close' | 'wait' | 'none'

export const WISHLIST_SIGNAL_LABELS: Record<WishlistSignal, string> = {
  buy: 'Buy now',
  close: 'Close',
  wait: 'Wait',
  none: 'No target',
}

/** How the current price compares with the target, in the same currency. */
export function wishlistSignal(
  priceMinor: number | null,
  priceCurrency: string | null,
  targetMinor: number | null,
  targetCurrency: string | null,
): WishlistSignal {
  if (
    priceMinor === null ||
    targetMinor === null ||
    !targetMinor ||
    priceCurrency !== targetCurrency
  )
    return 'none'
  if (priceMinor <= targetMinor) return 'buy'
  if (priceMinor <= targetMinor * WISHLIST_CLOSE_RATIO) return 'close'
  return 'wait'
}

/** Price relative to target: -0.05 is 5% under, 0.1 is 10% over. */
export function wishlistTargetGap(
  priceMinor: number | null,
  priceCurrency: string | null,
  targetMinor: number | null,
  targetCurrency: string | null,
): number | null {
  if (priceMinor === null || !targetMinor || priceCurrency !== targetCurrency)
    return null
  return priceMinor / targetMinor - 1
}
