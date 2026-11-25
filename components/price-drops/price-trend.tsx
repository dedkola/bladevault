'use client'

import { useId, useState, type PointerEvent } from 'react'
import {
  wishlistMoves,
  wishlistTrackedDays,
  wishlistTrendDirection,
  type WishlistMove,
  type WishlistTrend,
} from '@/lib/wishlist'
import { money } from './price-format'
import './price-trend.css'

/** Smallest vertical range of a row chart, as a share of its highest price. */
const SPARK_MIN_SPREAD = 0.04

/** "21 Nov" for the snapshot that introduced a move. */
function moveDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  })
}

/** "↓ $40.50 · 21 Nov". */
function moveLabel(move: WishlistMove, currency: string | null): string {
  return `${move.delta < 0 ? '↓' : '↑'} ${money(Math.abs(move.delta), currency)} · ${moveDate(move.at)}`
}

/** "▼ 20%" for the net change over the chart window; "<1%" for tiny moves. */
function chipLabel(net: number, base: number): string {
  if (!net) return '0%'
  const share = Math.round((Math.abs(net) / base) * 100)
  return `${net < 0 ? '▼' : '▲'} ${share ? `${share}%` : '<1%'}`
}

/**
 * Net change of a trend over its window, as a share of its first in-stock
 * price (-0.2 is 20% down), or null without a price.
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
 * Best store price over the tracked window, drawn as a stock-style step
 * "mountain" (a price holds until the next check) scaled to its own history,
 * with a chip for the net change over the window. Hovering moves a crosshair
 * and swaps the caption for the price on that day. The caption otherwise
 * names the window and the last move, so a two-day chart does not read like
 * a month.
 *
 * Renders two siblings (chart row, caption); the parent lays them out.
 * Colours come from --trend-down, --trend-up and --trend-flat.
 */
export function PriceTrend({
  trend,
  width = 110,
  height = 36,
  label = 'Best store price',
}: {
  trend: WishlistTrend | undefined
  width?: number
  height?: number
  /** What the line is, for the chart's accessible name. */
  label?: string
}) {
  const gradientId = `price-trend-${useId().replace(/:/g, '')}`
  const [hoverAt, setHoverAt] = useState<number | null>(null)
  if (!trend) return <span data-trend-empty>Not tracked yet</span>
  const steps = trend.steps
  const priced = steps.filter(
    (step): step is { at: number; price: number } => step.price !== null,
  )
  // Tracked, but no store has had it in stock inside the window.
  if (!priced.length) return <span data-trend-empty>No in-stock price yet</span>

  const days = wishlistTrackedDays(trend)
  const dayText = `${days} ${days === 1 ? 'day' : 'days'}`
  const moves = wishlistMoves(trend)
  const direction = wishlistTrendDirection(moves)
  const change = moves.at(-1)
  const current = steps[steps.length - 1].price
  const stockNote = current === null ? ', out of stock now' : ''
  const first = priced[0].price
  const net = priced[priced.length - 1].price - first

  // Scale to the history, but never tighter than a few percent of the price,
  // so a $1 move on a $200 knife does not look like a crash.
  const high = Math.max(...priced.map((step) => step.price))
  const low = Math.min(...priced.map((step) => step.price))
  const spread = Math.max(high - low, high * SPARK_MIN_SPREAD, 1)
  const middle = (high + low) / 2
  const bottom = middle - spread * 0.7
  const range = spread * 1.4
  const span = Math.max(trend.until - trend.since, 1)
  const plot = width - 8
  const x = (at: number) => ((at - trend.since) / span) * plot + 2
  const y = (price: number) =>
    height - 4 - ((price - bottom) / range) * (height - 10)

  // One path per in-stock stretch; out of stock leaves a gap.
  const runs: Array<{ line: string; from: number; to: number }> = []
  let line = ''
  let from = 0
  steps.forEach((step, index) => {
    const next = steps[index + 1]?.at ?? trend.until
    if (step.price === null) {
      if (line) runs.push({ line, from, to: x(step.at) })
      line = ''
      return
    }
    const py = y(step.price).toFixed(1)
    if (!line) from = x(step.at)
    line += line
      ? ` V${py} H${x(next).toFixed(1)}`
      : `M${from.toFixed(1)},${py} H${x(next).toFixed(1)}`
  })
  if (line) runs.push({ line, from, to: x(trend.until) })

  // The step showing at the hovered time: the last one that started by then.
  const hovered =
    hoverAt === null
      ? null
      : (steps.findLast((step) => step.at <= hoverAt) ?? steps[0])
  const moveHover = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const px = ((event.clientX - box.left) / box.width) * width
    const share = Math.min(Math.max((px - 2) / plot, 0), 1)
    setHoverAt(trend.since + share * span)
  }

  const summary = moves.length
    ? `net ${net < 0 ? 'down' : 'up'} ${money(Math.abs(net), trend.currency)}, last change ${change!.delta < 0 ? 'down' : 'up'} ${money(Math.abs(change!.delta), trend.currency)} on ${moveDate(change!.at)}`
    : 'no price change'

  return (
    <>
      <div data-trend-row>
        <svg
          data-trend-spark={direction}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${label} over ${dayText}: ${summary}${stockNote}`}
          onPointerMove={moveHover}
          onPointerLeave={() => setHoverAt(null)}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" data-trend-stop="top" />
              <stop offset="1" data-trend-stop="bottom" />
            </linearGradient>
          </defs>
          {runs.map((run) => (
            <path
              key={`fill-${run.line}`}
              d={`${run.line} V${height} H${run.from.toFixed(1)} Z`}
              fill={`url(#${gradientId})`}
            />
          ))}
          {runs.map((run) => (
            <path key={run.line} data-trend-line d={run.line} fill="none" />
          ))}
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
        <span
          data-trend-chip={direction}
          title={
            net
              ? `${net < 0 ? 'Down' : 'Up'} ${money(Math.abs(net), trend.currency)} over ${dayText}`
              : `No price change over ${dayText}`
          }
        >
          {chipLabel(net, first)}
        </span>
      </div>
      <span data-trend-note>
        {hovered ? (
          <>
            <span>{moveDate(Math.max(hoverAt!, trend.since))}</span>
            <b data-trend-hover>
              {hovered.price === null
                ? 'Out of stock'
                : money(hovered.price, trend.currency)}
            </b>
          </>
        ) : (
          <>
            <span>{days}d tracked</span>
            {change && (
              <span data-trend-change={change.delta < 0 ? 'down' : 'up'}>
                {moveLabel(change, trend.currency)}
              </span>
            )}
          </>
        )}
      </span>
    </>
  )
}
