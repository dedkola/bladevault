'use client'

import { useCallback, useEffect, useState } from 'react'
import type { EChartsOption } from 'echarts'
import {
  InsightsChart,
  type InsightsChartPalette,
} from '@/components/insights-chart'
import { fromMinorUnits } from '@/lib/price-monitor/money'
import {
  HISTORY_RANGES,
  type HistoryRange,
  type KnifeHistory,
} from '@/lib/price-monitor/insights'
import { cn } from '@/lib/utils'
import { moneyMajor, storeLabel } from './price-format'
import './price-drops.css'

const RANGE_LABEL: Record<HistoryRange, string> = {
  '7d': '7D',
  '1m': '1M',
  '3m': '3M',
  '6m': '6M',
  '1y': '1Y',
  all: 'All',
}

export function RangeButtons({
  value,
  onChange,
}: {
  value: HistoryRange
  onChange: (range: HistoryRange) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Price history range"
      data-price-ranges
      className="inline-flex flex-wrap gap-0.5"
    >
      {HISTORY_RANGES.map((range) => (
        <button
          key={range}
          type="button"
          role="radio"
          aria-checked={value === range}
          onClick={() => onChange(range)}
          className={cn(
            'rounded-md border border-transparent px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground',
            value === range &&
              'border-[var(--bladevault-line)] bg-[var(--bladevault-surface-soft)] font-semibold text-foreground',
          )}
        >
          {RANGE_LABEL[range]}
        </button>
      ))}
    </div>
  )
}

type HistoryState =
  | { status: 'loading' }
  | { status: 'ready'; history: KnifeHistory }
  | { status: 'error'; message: string }

/** Loads a knife's history for a range; `version` forces a reload. */
export function usePriceHistory(
  knifeId: string | null,
  range: HistoryRange,
  version = 0,
): HistoryState {
  const [state, setState] = useState<HistoryState>({ status: 'loading' })
  useEffect(() => {
    if (!knifeId) return
    const controller = new AbortController()
    async function load() {
      try {
        const response = await fetch(
          `/api/prices/history?knifeId=${encodeURIComponent(knifeId!)}&range=${range}`,
          { cache: 'no-store', signal: controller.signal },
        )
        const data = (await response.json()) as {
          history?: KnifeHistory
          error?: string
        }
        if (controller.signal.aborted) return
        if (!response.ok || !data.history)
          setState({
            status: 'error',
            message: data.error ?? 'Could not load the price history.',
          })
        else setState({ status: 'ready', history: data.history })
      } catch {
        if (!controller.signal.aborted)
          setState({
            status: 'error',
            message: 'Could not load the price history.',
          })
      }
    }
    void load()
    return () => controller.abort()
  }, [knifeId, range, version])
  return state
}

/** The currency most sources report; lines in other currencies are hidden. */
export function chartCurrency(history: KnifeHistory): string | null {
  const counts = new Map<string, number>()
  for (const source of history.sources)
    for (const point of source.points)
      if (point.currency)
        counts.set(point.currency, (counts.get(point.currency) ?? 0) + 1)
  let best: string | null = null
  for (const [currency, count] of counts)
    if (!best || count > (counts.get(best) ?? 0)) best = currency
  return best
}

const isNumber = (value: number | null): value is number => value !== null

/** A snug axis around the prices (and the purchase price), with headroom. */
function valueRange(values: number[], paid: number | null) {
  const all = paid === null ? values : [...values, paid]
  if (!all.length) return {}
  const low = Math.min(...all)
  const high = Math.max(...all)
  const pad = Math.max((high - low) * 0.15, high * 0.04, 1)
  return {
    min: Math.max(0, Math.floor(low - pad)),
    max: Math.ceil(high + pad),
  }
}

function seriesColors(palette: InsightsChartPalette): string[] {
  // Distinct pairs in every theme: olive/gold, orange/grey, violet/teal…
  return [
    palette.chartPrimary,
    palette.chartTertiary,
    palette.chartSecondary,
    palette.chartOther,
    palette.chartQuaternary,
  ]
}

export function sourceColor(index: number): string {
  return [
    'var(--bv-chart-1)',
    'var(--bv-chart-3)',
    'var(--bv-chart-2)',
    'var(--bv-chart-6)',
    'var(--bv-chart-4)',
  ][index % 5]
}

/**
 * Step lines per source, out-of-stock periods shaded, and a dashed line at
 * the purchase price when it is in the same currency.
 */
export function PriceHistoryChart({
  history,
  className,
}: {
  history: KnifeHistory
  className?: string
}) {
  const currency = chartCurrency(history)
  const buildOption = useCallback(
    (palette: InsightsChartPalette): EChartsOption => {
      const colors = seriesColors(palette)
      const outOfStock: Array<[{ xAxis: number }, { xAxis: number }]> = []
      const series = history.sources.map((source, index) => {
        const data: Array<[number, number | null]> = []
        for (const point of source.points) {
          const from = Date.parse(point.from)
          const to = Math.max(Date.parse(point.to), from)
          if (point.availability === 'out_of_stock')
            outOfStock.push([{ xAxis: from }, { xAxis: to }])
          const value =
            point.priceMinor !== null &&
            point.currency &&
            point.currency === currency
              ? fromMinorUnits(point.priceMinor, point.currency)
              : null
          data.push([from, value], [to, value])
        }
        return {
          type: 'line' as const,
          name: `${storeLabel(source.storeName)}${source.removed ? ' (removed)' : ''}`,
          step: 'end' as const,
          showSymbol: false,
          connectNulls: false,
          data,
          lineStyle: {
            width: 2,
            color: colors[index % colors.length],
            type: source.removed ? ('dashed' as const) : ('solid' as const),
          },
          itemStyle: { color: colors[index % colors.length] },
          ...(index === 0
            ? {
                markArea: {
                  silent: true,
                  itemStyle: { color: palette.highlightWash },
                  data: outOfStock,
                },
                ...(history.paid && history.paid.currency === currency
                  ? {
                      markLine: {
                        silent: true,
                        symbol: 'none',
                        label: {
                          formatter: 'You paid',
                          color: palette.muted,
                          fontSize: 10,
                          position: 'insideEndTop' as const,
                        },
                        lineStyle: {
                          color: palette.muted,
                          type: 'dashed' as const,
                        },
                        data: [{ yAxis: history.paid.amount }],
                      },
                    }
                  : {}),
              }
            : {}),
        }
      })
      return {
        animation: false,
        grid: { left: 8, right: 12, top: 14, bottom: 4, containLabel: true },
        tooltip: {
          trigger: 'axis',
          backgroundColor: palette.card,
          borderColor: palette.line,
          textStyle: { color: palette.foreground, fontSize: 12 },
          valueFormatter: (value) =>
            moneyMajor(typeof value === 'number' ? value : null, currency),
        },
        xAxis: {
          type: 'time',
          min: history.rangeStart ? Date.parse(history.rangeStart) : undefined,
          axisLine: { lineStyle: { color: palette.line } },
          splitNumber: 4,
          axisLabel: {
            color: palette.muted,
            fontSize: 10,
            hideOverlap: true,
            formatter: {
              year: '{yyyy}',
              month: '{MMM}',
              day: '{MMM} {d}',
              hour: '{HH}:{mm}',
              minute: '{HH}:{mm}',
            },
          },
          splitLine: { show: false },
        },
        yAxis: {
          type: 'value',
          scale: true,
          ...valueRange(
            series.flatMap((line) =>
              line.data.map(([, value]) => value).filter(isNumber),
            ),
            history.paid && history.paid.currency === currency
              ? history.paid.amount
              : null,
          ),
          axisLabel: { color: palette.muted, fontSize: 10 },
          splitLine: { lineStyle: { color: palette.ringTrack } },
        },
        series,
      }
    },
    [history, currency],
  )

  const hasPoints = history.sources.some((source) => source.points.length)
  if (!hasPoints)
    return (
      <div
        className={cn(
          'grid place-items-center rounded-lg border border-dashed border-[var(--bladevault-line)] text-xs text-muted-foreground',
          className,
        )}
      >
        No prices recorded in this range yet.
      </div>
    )
  return (
    <InsightsChart
      buildOption={buildOption}
      ariaLabel={`Price history of ${history.knife.brand} ${history.knife.name}`}
      className={className}
    />
  )
}

export function ChartLegend({ history }: { history: KnifeHistory }) {
  return (
    <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
      {history.sources.map((source, index) => (
        <span
          key={source.sourceId}
          className="inline-flex items-center gap-1.5"
        >
          <span
            aria-hidden="true"
            className="inline-block h-0.5 w-3.5"
            style={{
              background: source.removed ? 'transparent' : sourceColor(index),
              borderTop: source.removed
                ? `2px dashed ${sourceColor(index)}`
                : undefined,
            }}
          />
          {storeLabel(source.storeName)}
          {source.removed ? ' (removed)' : ''}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="inline-block h-2 w-3.5 bg-[var(--bv-chart-wash)]"
        />
        Out of stock
      </span>
      {history.paid ? (
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block w-3.5 border-t-2 border-dashed border-muted-foreground"
          />
          You paid
        </span>
      ) : null}
    </div>
  )
}
