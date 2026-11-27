'use client'

import {
  WISHLIST_REGULAR_TOLERANCE,
  wishlistMoves,
  wishlistTrackedDays,
  type WishlistTrend,
} from '@/lib/wishlist'
import { money } from './price-format'
import { RowPriceChart } from './row-price-chart'
import { rowChartDirection, type RowChartStore } from './row-price-chart-model'
import './price-trend.css'

/** Row chart size, as in the approved mockup. */
export const ROW_CHART_WIDTH = 260
export const ROW_CHART_HEIGHT = 54
const NO_STORES: readonly RowChartStore[] = []

/** "21 Nov" for a moment on the chart. */
function moveDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  })
}

/**
 * The current price against the item's regular price: what the row chip
 * shows. `delta` is negative below regular; `share` is its size as a whole
 * percent of the regular price. Within half a percent counts as regular.
 */
export type RegularGap = {
  delta: number
  share: number
  direction: 'down' | 'up' | 'flat'
}

export function regularGap(
  currentMinor: number | null | undefined,
  regularMinor: number | null | undefined,
): RegularGap | null {
  if (currentMinor == null || !regularMinor) return null
  const delta = currentMinor - regularMinor
  const ratio = delta / regularMinor
  if (Math.abs(ratio) < WISHLIST_REGULAR_TOLERANCE)
    return { delta, share: 0, direction: 'flat' }
  return {
    delta,
    share: Math.max(1, Math.round(Math.abs(ratio) * 100)),
    direction: delta < 0 ? 'down' : 'up',
  }
}

/** "▼ $72.10 · 36%" below regular, "▲ $12.00 · 6%" above, "regular". */
export function regularChipLabel(gap: RegularGap, currency: string | null) {
  if (gap.direction === 'flat') return 'regular'
  return `${gap.direction === 'down' ? '▼' : '▲'} ${money(Math.abs(gap.delta), currency)} · ${gap.share}%`
}

/**
 * Net change of a trend over its window, as a share of its first in-stock
 * price (-0.2 is 20% down); null without a price.
 */
export function trendNetChange(
  trend: WishlistTrend | undefined,
): number | null {
  const priced = trend?.steps.filter((step) => step.price !== null) ?? []
  if (!priced.length) return null
  const first = priced[0].price!
  return first ? (priced[priced.length - 1].price! - first) / first : null
}

/**
 * The row chart (mockup variant A, see `rowChartOption`): the best store
 * price as a filled area, coloured by its latest move, a dot in the store's
 * colour for every store reading, and a thin line at the item's regular
 * price. Hovering lists every store's price at that moment. The chip is the
 * one headline number: how far the current price is below (or above) the
 * regular price, in money and percent.
 *
 * Renders two siblings (chart row, caption); the parent lays them out.
 */
export function PriceTrend({
  trend,
  stores = NO_STORES,
  currentMinor,
  regularMinor,
  width = ROW_CHART_WIDTH,
  height = ROW_CHART_HEIGHT,
  label = 'Best store price',
}: {
  trend: WishlistTrend | undefined
  /** Each store's own history, for the dots (memoize it). */
  stores?: readonly RowChartStore[]
  /**
   * The row's price now, in minor units of the trend's currency; null when
   * it is not a buyable price (out of stock, or a failed check).
   */
  currentMinor?: number | null
  /** The item's regular price, in minor units of the trend's currency. */
  regularMinor?: number | null
  width?: number
  height?: number
  /** What the line is, for the chart's accessible name. */
  label?: string
}) {
  if (!trend) return <span data-trend-empty>Not tracked yet</span>
  const priced = trend.steps.filter(
    (step): step is { at: number; price: number } => step.price !== null,
  )
  // Tracked, but no store has shown a price inside the window. Prices shown
  // while out of stock still chart: the chart is price history.
  if (!priced.length && !trend.readings?.length)
    return <span data-trend-empty>No price yet</span>

  const regular = regularMinor || null
  const currency = trend.currency
  const gap = regularGap(currentMinor, regular)
  const days = wishlistTrackedDays(trend)
  const dayText = `${days} ${days === 1 ? 'day' : 'days'}`
  const moves = wishlistMoves(trend)
  const change = moves.at(-1)
  const current = trend.steps[trend.steps.length - 1].price
  const net = priced.length
    ? priced[priced.length - 1].price - priced[0].price
    : 0

  const gapText = gap
    ? gap.direction === 'flat'
      ? `at the regular price ${money(regular, currency)}`
      : `${money(Math.abs(gap.delta), currency)} (${gap.share}%) ${gap.direction === 'down' ? 'below' : 'above'} the regular price ${money(regular, currency)}`
    : ''
  const history = moves.length
    ? `net ${net < 0 ? 'down' : 'up'} ${money(Math.abs(net), currency)}, last change ${change!.delta < 0 ? 'down' : 'up'} ${money(Math.abs(change!.delta), currency)} on ${moveDate(change!.at)}`
    : 'no price change'
  const ariaLabel = [
    `${label} over ${dayText}`,
    gap ? `now ${money(currentMinor ?? null, currency)}, ${gapText}` : '',
    history,
    current === null ? 'out of stock now' : '',
  ]
    .filter(Boolean)
    .join('; ')

  return (
    <>
      <div data-trend-row>
        <div
          data-trend-spark={rowChartDirection(trend)}
          style={{ flexBasis: width, maxWidth: width, height }}
        >
          <RowPriceChart
            trend={trend}
            stores={stores}
            regularMinor={regular}
            ariaLabel={ariaLabel}
          />
        </div>
        {gap && (
          <span
            data-trend-chip={gap.direction}
            title={`${gapText[0].toUpperCase()}${gapText.slice(1)}`}
          >
            {regularChipLabel(gap, currency)}
          </span>
        )}
      </div>
      <span data-trend-note>
        <span>{days}d tracked</span>
        {regular !== null && (
          <span data-trend-regular-note>
            regular {money(regular, currency)}
          </span>
        )}
      </span>
    </>
  )
}
