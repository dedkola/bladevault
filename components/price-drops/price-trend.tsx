'use client'

import { useId, useState, type PointerEvent } from 'react'
import {
  WISHLIST_REGULAR_TOLERANCE,
  rowChartBreak,
  rowChartScale,
  withRegularStart,
  wishlistMoves,
  wishlistTrackedDays,
  wishlistTrendDirection,
  type WishlistTrend,
} from '@/lib/wishlist'
import { money } from './price-format'
import './price-trend.css'

/** Smallest vertical range of a row chart, as a share of its highest price. */
const SPARK_MIN_SPREAD = 0.04

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
 * The store price over the tracked window as a step line (a price holds
 * until the next check), built from the item's regular price: when the
 * store was first seen at another price, the line starts at the regular
 * price and steps to the first reading. Like a baseline chart, the area
 * between the regular price and the line is green below it and red above
 * it. The chip is the one headline number: how far the current price is
 * below (or above) the regular price, in money and percent. Without a
 * regular price, the line is a plain "mountain" with no chip.
 *
 * Renders two siblings (chart row, caption); the parent lays them out.
 * Colours come from --trend-down, --trend-up and --trend-flat.
 */
export function PriceTrend({
  trend,
  currentMinor,
  regularMinor,
  width = 110,
  height = 36,
  label = 'Best store price',
}: {
  trend: WishlistTrend | undefined
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
  const gradientId = `price-trend-${useId().replace(/:/g, '')}`
  const [hoverAt, setHoverAt] = useState<number | null>(null)
  if (!trend) return <span data-trend-empty>Not tracked yet</span>
  const regular = regularMinor || null
  const { steps, since, lead } = withRegularStart(trend, regular)
  const priced = steps.filter(
    (step): step is { at: number; price: number } => step.price !== null,
  )
  // Tracked, but no store has had it in stock inside the window.
  if (!priced.length) return <span data-trend-empty>No in-stock price yet</span>

  const currency = trend.currency
  const gap = regularGap(currentMinor, regular)
  const days = wishlistTrackedDays(trend)
  const dayText = `${days} ${days === 1 ? 'day' : 'days'}`
  const moves = wishlistMoves(trend)
  const change = moves.at(-1)
  const current = steps[steps.length - 1].price
  const last = priced[priced.length - 1].price
  const firstReading = priced[lead ? 1 : 0].price
  const net = last - firstReading
  // The line reads against the regular price, as the chip does (by the last
  // price read when out of stock); without one, as the window moved.
  const direction =
    (gap ?? regularGap(last, regular))?.direction ??
    wishlistTrendDirection(moves)

  // Scale so every store move shows (see rowChartScale): a regular price far
  // above the readings sits at the top edge behind a break mark.
  const scale = rowChartScale({
    readings: trend.steps.flatMap((step) =>
      step.price === null ? [] : [step.price],
    ),
    regular,
    top: 3,
    bottom: height - 3,
    minSpread: SPARK_MIN_SPREAD,
  })
  const y = scale.y
  const span = Math.max(trend.until - since, 1)
  const plot = width - 8
  const x = (at: number) => ((at - since) / span) * plot + 2

  // One unbroken line from the first price: out of stock holds the last
  // price until the next one.
  let line = ''
  let from = 0
  let held: number | null = null
  steps.forEach((step, index) => {
    held = step.price ?? held
    if (held === null) return
    const next = steps[index + 1]?.at ?? trend.until
    const py = y(held).toFixed(1)
    if (!line) from = x(step.at)
    line += line
      ? ` V${py} H${x(next).toFixed(1)}`
      : `M${from.toFixed(1)},${py} H${x(next).toFixed(1)}`
  })

  // The step showing at the hovered time: the last one that started by then.
  const hovered =
    hoverAt === null
      ? null
      : (steps.findLast((step) => step.at <= hoverAt) ?? steps[0])
  const moveHover = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const px = ((event.clientX - box.left) / box.width) * width
    const share = Math.min(Math.max((px - 2) / plot, 0), 1)
    setHoverAt(since + share * span)
  }

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
  const regularY = scale.regularY === null ? 0 : scale.regularY.toFixed(1)
  // Where the line leaves a pinned regular price for the first reading.
  const firstRead = lead
    ? steps.find((step) => step !== lead && step.price !== null)
    : undefined
  const breakMark =
    scale.pinned && lead && firstRead
      ? rowChartBreak(x(firstRead.at), y(lead.price), y(firstRead.price!))
      : null
  // The area between the line and the regular price, split at it.
  const baseArea = `${line} V${regularY} H${from.toFixed(1)} Z`

  return (
    <>
      <div data-trend-row>
        <svg
          data-trend-spark={direction}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={ariaLabel}
          onPointerMove={moveHover}
          onPointerLeave={() => setHoverAt(null)}
        >
          {regular === null ? (
            <>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" data-trend-stop="top" />
                  <stop offset="1" data-trend-stop="bottom" />
                </linearGradient>
              </defs>
              <path
                d={`${line} V${height} H${from.toFixed(1)} Z`}
                fill={`url(#${gradientId})`}
              />
            </>
          ) : (
            <>
              <defs>
                <clipPath id={`${gradientId}-below`}>
                  <rect x="0" y={regularY} width={width} height={height} />
                </clipPath>
                <clipPath id={`${gradientId}-above`}>
                  <rect x="0" y="0" width={width} height={regularY} />
                </clipPath>
              </defs>
              <path
                data-trend-base="below"
                d={baseArea}
                clipPath={`url(#${gradientId}-below)`}
              />
              <path
                data-trend-base="above"
                d={baseArea}
                clipPath={`url(#${gradientId}-above)`}
              />
            </>
          )}
          <path data-trend-line d={line} fill="none" />
          {breakMark && (
            <>
              <path data-trend-break="mask" d={breakMark} fill="none" />
              <path data-trend-break="mark" d={breakMark} fill="none" />
            </>
          )}
          {hoverAt !== null && (
            <line
              data-trend-cross
              x1={x(hoverAt).toFixed(1)}
              x2={x(hoverAt).toFixed(1)}
              y1="0"
              y2={height}
            />
          )}
          {hovered && hovered.price !== null ? (
            <circle
              data-trend-dot
              cx={x(hoverAt!).toFixed(1)}
              cy={y(hovered.price).toFixed(1)}
              r="3"
            />
          ) : (
            !hovered &&
            current !== null && (
              <circle
                data-trend-dot
                cx={x(trend.until).toFixed(1)}
                cy={y(current).toFixed(1)}
                r="3"
              />
            )
          )}
        </svg>
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
        {hovered ? (
          <>
            <span>
              {hovered === lead
                ? 'Regular'
                : moveDate(Math.max(hoverAt!, trend.since))}
            </span>
            <b data-trend-hover>
              {hovered.price === null
                ? 'Out of stock'
                : money(hovered.price, currency)}
            </b>
          </>
        ) : (
          <>
            <span>{days}d tracked</span>
            {regular !== null && (
              <span data-trend-regular-note>
                regular {money(regular, currency)}
              </span>
            )}
          </>
        )}
      </span>
    </>
  )
}
