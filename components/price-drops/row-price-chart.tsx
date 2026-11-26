'use client'

import { useCallback, useRef } from 'react'
import {
  InsightsChart,
  type InsightsChartPalette,
} from '@/components/insights-chart'
import type { WishlistTrend } from '@/lib/wishlist'
import {
  rowChartOption,
  type RowChartColors,
  type RowChartStore,
} from './row-price-chart-model'

/** Line colours from the chart's box, so a page can retint them. */
function rowChartColors(
  palette: InsightsChartPalette,
  box: HTMLElement | null,
): RowChartColors {
  const root = document.documentElement
  const style = getComputedStyle(box ?? root)
  const get = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback
  return {
    down: get('--trend-down', get('--price-drop', '#2f7d46')),
    up: get('--trend-up', get('--price-rise', '#b4232a')),
    flat: get('--trend-flat', get('--price-neutral', '#9a958b')),
    card: palette.card,
    foreground: palette.foreground,
    muted: palette.muted,
    dark: root.classList.contains('dark') || root.dataset.themeMode === 'dark',
  }
}

/**
 * The ECharts row chart (see `rowChartOption`), started when it scrolls
 * into view. `stores` should keep its identity between renders (memoize
 * it), or the chart redraws on every render.
 */
export function RowPriceChart({
  trend,
  stores,
  regularMinor,
  ariaLabel,
}: {
  trend: WishlistTrend
  stores: readonly RowChartStore[]
  regularMinor: number | null
  ariaLabel: string
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const buildOption = useCallback(
    (palette: InsightsChartPalette) =>
      rowChartOption(
        { trend, stores, regularMinor },
        rowChartColors(palette, boxRef.current),
        () => boxRef.current?.getBoundingClientRect().right ?? null,
      ),
    [trend, stores, regularMinor],
  )
  return (
    // Absolute, so the drawn chart's width never holds its box open: the
    // box can shrink and the chart follows it.
    <div ref={boxRef} className="relative h-full w-full">
      <InsightsChart
        buildOption={buildOption}
        ariaLabel={ariaLabel}
        className="absolute inset-0"
      />
    </div>
  )
}
