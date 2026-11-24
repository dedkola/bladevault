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
import { money, moneyMajor, storeLabel } from './price-format'
import {
  historyEnd,
  outOfStockEverywhere,
  sourceSpans,
  storeLinesAt,
} from './price-history-model'
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

function pointCurrencies(history: KnifeHistory): Map<string, number> {
  const counts = new Map<string, number>()
  for (const source of history.sources)
    for (const point of source.points)
      if (point.currency && point.priceMinor !== null)
        counts.set(point.currency, (counts.get(point.currency) ?? 0) + 1)
  return counts
}

/**
 * The chart's currency: the knife's main currency (the one its stats use)
 * when the range has prices in it, otherwise the one most readings in the
 * range use. Lines in other currencies are hidden and noted.
 */
export function chartCurrency(history: KnifeHistory): string | null {
  const counts = pointCurrencies(history)
  const main = history.stats?.currency
  if (main && counts.has(main)) return main
  let best: string | null = null
  for (const [currency, count] of counts)
    if (!best || count > (counts.get(best) ?? 0)) best = currency
  return best ?? main ?? null
}

/** Stores whose prices in the range are in another currency, by currency. */
export function hiddenCurrencies(
  history: KnifeHistory,
  currency: string | null,
): Array<{ currency: string; stores: number }> {
  const stores = new Map<string, Set<number>>()
  for (const source of history.sources)
    for (const point of source.points)
      if (
        point.currency &&
        point.priceMinor !== null &&
        point.currency !== currency
      ) {
        const set = stores.get(point.currency) ?? new Set<number>()
        set.add(source.sourceId)
        stores.set(point.currency, set)
      }
  return [...stores].map(([code, set]) => ({
    currency: code,
    stores: set.size,
  }))
}

/** "1 store in EUR not shown" for the stores the chart leaves out. */
export function hiddenCurrencyNote(
  hidden: Array<{ currency: string; stores: number }>,
): string | null {
  if (!hidden.length) return null
  const stores = hidden.reduce((sum, entry) => sum + entry.stores, 0)
  return `${stores} ${stores === 1 ? 'store' : 'stores'} in ${hidden
    .map((entry) => entry.currency)
    .join(', ')} not shown`
}

const isNumber = (value: number | null): value is number => value !== null

/** A snug axis around the prices (and the regular price), with headroom. */
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

function cssColor(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    fallback
  )
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ]!,
  )

type MarkerKind =
  'drop' | 'increase' | 'out_of_stock' | 'back_in_stock' | 'low' | 'unconfirmed'

type Marker = { kind: MarkerKind; x: number; y: number; tip: string }

const MARKER_SYMBOL: Record<
  MarkerKind,
  { symbol: string; size: number; rotate?: number; hollow?: boolean }
> = {
  drop: { symbol: 'triangle', size: 9, rotate: 180 },
  increase: { symbol: 'triangle', size: 9 },
  out_of_stock: { symbol: 'circle', size: 8, hollow: true },
  back_in_stock: { symbol: 'circle', size: 8 },
  low: { symbol: 'diamond', size: 11 },
  unconfirmed: { symbol: 'circle', size: 8, hollow: true },
}

/** The price a source's line shows at a moment, for stock markers. */
function lineValueAt(
  source: KnifeHistory['sources'][number],
  at: number,
  currency: string | null,
): number | null {
  let value: number | null = null
  for (const point of source.points) {
    if (Date.parse(point.from) > at) break
    value =
      point.priceMinor !== null && point.currency === currency
        ? point.priceMinor
        : value
  }
  return value
}

function buildMarkers(
  history: KnifeHistory,
  currency: string | null,
  xMin: number | null,
  formatPrice: (minor: number) => string,
): Array<Omit<Marker, 'y'> & { minor: number | null }> {
  const markers: Array<Omit<Marker, 'y'> & { minor: number | null }> = []
  const inView = (x: number) => xMin === null || x >= xMin
  const sources = new Map(history.sources.map((s) => [s.sourceId, s]))
  for (const event of history.events) {
    const x = Date.parse(event.occurredAt)
    if (!inView(x)) continue
    const store = storeLabel(event.storeName)
    if (event.type === 'price') {
      if (event.currency !== currency || event.priceMinor === null) continue
      const pct =
        event.deltaPct === null ? '' : ` (${Math.abs(event.deltaPct)}%)`
      const previous = event.previousStoreName
        ? storeLabel(event.previousStoreName)
        : null
      markers.push({
        kind: event.kind,
        x,
        minor: event.priceMinor,
        tip: previous
          ? `${store} sells it for less than ${previous}: ${
              event.previousPriceMinor === null
                ? ''
                : `${formatPrice(event.previousPriceMinor)} → `
            }${formatPrice(event.priceMinor)}${pct}`
          : `${event.kind === 'drop' ? 'Price drop' : 'Price increase'} at ${store}: ${
              event.previousPriceMinor === null
                ? ''
                : `${formatPrice(event.previousPriceMinor)} → `
            }${formatPrice(event.priceMinor)}${pct}`,
      })
    } else {
      const source = sources.get(event.sourceId)
      const minor =
        event.priceMinor !== null && event.currency === currency
          ? event.priceMinor
          : source
            ? lineValueAt(source, x, currency)
            : null
      markers.push({
        kind: event.kind,
        x,
        minor,
        tip: event.previousStoreName
          ? `In stock at ${store} while ${storeLabel(event.previousStoreName)} is out`
          : `${event.kind === 'out_of_stock' ? 'Out of stock' : 'Back in stock'} at ${store}`,
      })
    }
  }
  for (const source of history.sources)
    for (const reading of source.unconfirmed ?? []) {
      if (reading.priceMinor === null || reading.currency !== currency) continue
      const x = Date.parse(reading.from)
      if (!inView(x)) continue
      markers.push({
        kind: 'unconfirmed',
        x,
        minor: reading.priceMinor,
        tip: `AI could not confirm ${formatPrice(reading.priceMinor)} at ${storeLabel(source.storeName)}; not used as the price`,
      })
    }
  const low = history.stats?.lowest
  if (low && history.stats.currency === currency) {
    const until = Date.parse(low.until)
    if (xMin === null || until >= xMin)
      markers.push({
        kind: 'low',
        x:
          xMin === null
            ? Date.parse(low.at)
            : Math.max(Date.parse(low.at), xMin),
        minor: low.priceMinor,
        tip: `Lowest price seen: ${formatPrice(low.priceMinor)} at ${storeLabel(low.storeName)}`,
      })
  }
  return markers
}

/**
 * Step lines per source, shading while no store had the knife in stock
 * (the tooltip lists every store's price and stock), a dashed line at the
 * regular price when it is in the same currency, and markers for price
 * and stock changes, the all-time low and AI-unconfirmed readings.
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
      const toValue = (minor: number) =>
        currency ? fromMinorUnits(minor, currency) : minor
      const formatValue = (value: number) =>
        currency ? moneyMajor(value, currency) : String(value)
      const formatPrice = (minor: number) => formatValue(toValue(minor))
      const xMin = history.chartStart ? Date.parse(history.chartStart) : null
      // Readings too short to show as a line segment get a dot instead.
      const times = history.sources.flatMap((source) =>
        source.points.flatMap((point) => [
          Date.parse(point.from),
          Date.parse(point.to),
        ]),
      )
      const span = times.length
        ? Math.max(...times) - (xMin ?? Math.min(...times))
        : 0
      const minVisible = span * 0.01
      // Shaded only while no store had the knife: one store selling it
      // means the knife is in stock.
      const outOfStock = outOfStockEverywhere(history).map(
        ([from, to]): [{ xAxis: number }, { xAxis: number }] => [
          { xAxis: from },
          { xAxis: to },
        ],
      )
      const end = historyEnd(history)
      const series = history.sources.map((source, index) => {
        const data: Array<[number, number | null]> = []
        const dotted = new Set<number>()
        // A reading stays in force until the next one (and a live store's
        // latest reading to the chart end), so a store with one snapshot
        // still draws a line rather than a single dot.
        for (const span of sourceSpans(source, end)) {
          const point = span.point
          const value =
            point.priceMinor !== null &&
            point.currency &&
            point.currency === currency
              ? fromMinorUnits(point.priceMinor, point.currency)
              : null
          if (value !== null && span.to - span.from <= minVisible)
            dotted.add(data.length)
          data.push([span.from, value], [span.to, value])
        }
        return {
          type: 'line' as const,
          name: `${storeLabel(source.storeName)}${source.removed ? ' (removed)' : ''}`,
          step: 'end' as const,
          showSymbol: dotted.size > 0,
          symbol: 'circle',
          symbolSize: (_value: unknown, params: { dataIndex: number }) =>
            dotted.has(params.dataIndex) ? 5 : 0,
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
                          formatter: 'Regular price',
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
      const paidValue =
        history.paid && history.paid.currency === currency
          ? history.paid.amount
          : null
      const yRange = valueRange(
        series.flatMap((line) =>
          line.data.map(([, value]) => value).filter(isNumber),
        ),
        paidValue,
      )
      const markerColor: Record<MarkerKind, string> = {
        drop: cssColor('--price-drop', '#4f5821'),
        back_in_stock: cssColor('--price-drop', '#4f5821'),
        increase: cssColor('--price-up', '#c0392b'),
        out_of_stock: cssColor('--price-stock', '#8a5f0f'),
        low: palette.gold,
        unconfirmed: palette.muted,
      }
      const markers: Marker[] = buildMarkers(
        history,
        currency,
        xMin,
        formatPrice,
      ).map((marker) => ({
        ...marker,
        y:
          marker.minor !== null
            ? toValue(marker.minor)
            : ((yRange as { min?: number }).min ?? 0),
      }))
      const xValues = [
        ...series.flatMap((line) => line.data.map(([x]) => x)),
        ...markers.map((marker) => marker.x),
      ]
      const xLow = xMin ?? Math.min(...xValues)
      const xHigh = Math.max(...xValues)
      const tolerance = Math.max((xHigh - xLow) * 0.02, 60_000)

      const markerSeries = {
        type: 'scatter' as const,
        name: 'Changes',
        z: 5,
        data: markers.map((marker) => {
          const look = MARKER_SYMBOL[marker.kind]
          const color = markerColor[marker.kind]
          return {
            value: [marker.x, marker.y],
            symbol: look.symbol,
            symbolSize: look.size,
            symbolRotate: look.rotate ?? 0,
            itemStyle: look.hollow
              ? {
                  color: palette.card,
                  borderColor: color,
                  borderWidth: 1.5,
                  borderType:
                    marker.kind === 'unconfirmed'
                      ? ('dashed' as const)
                      : ('solid' as const),
                }
              : { color, borderColor: palette.card, borderWidth: 1 },
          }
        }),
      }

      return {
        animation: false,
        grid: { left: 8, right: 12, top: 14, bottom: 4, containLabel: true },
        tooltip: {
          trigger: 'axis',
          // Keep the tooltip inside the chart: on a narrow panel it would
          // otherwise run past the card's edge and get clipped.
          confine: true,
          extraCssText:
            'max-width:calc(100% - 16px);white-space:normal;overflow-wrap:anywhere;',
          backgroundColor: palette.card,
          borderColor: palette.line,
          textStyle: { color: palette.foreground, fontSize: 12 },
          // Every store at the hovered moment, not only the lines ECharts
          // finds nearest (it skips some stores and repeats others).
          formatter: (raw) => {
            const params = (Array.isArray(raw) ? raw : [raw]) as Array<{
              axisValue?: unknown
            }>
            const at = Number(params[0]?.axisValue)
            const lines: string[] = []
            if (Number.isFinite(at))
              lines.push(
                `<div style="opacity:.75">${escapeHtml(
                  new Date(at).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  }),
                )}</div>`,
              )
            if (Number.isFinite(at))
              for (const line of storeLinesAt(history, at, end, currency))
                lines.push(
                  `<div${line.out ? ' style="opacity:.7"' : ''}><span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:${colors[line.index % colors.length]}"></span>${escapeHtml(
                    line.label,
                  )}: <b>${escapeHtml(line.price)}</b>${line.note ? ` · ${escapeHtml(line.note)}` : ''}</div>`,
                )
            for (const marker of markers)
              if (Math.abs(marker.x - at) <= tolerance)
                lines.push(
                  `<div style="color:${markerColor[marker.kind]}">${escapeHtml(marker.tip)}</div>`,
                )
            return lines.join('')
          },
        },
        xAxis: {
          type: 'time',
          min: xMin ?? undefined,
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
          ...yRange,
          axisLabel: { color: palette.muted, fontSize: 10 },
          splitLine: { lineStyle: { color: palette.ringTrack } },
        },
        series: [...series, markerSeries],
      }
    },
    [history, currency],
  )

  const hasPoints = history.sources.some(
    (source) => source.points.length || source.unconfirmed?.length,
  )
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

function MarkerSwatch({
  kind,
  label,
}: {
  kind: 'drop' | 'increase' | 'stock' | 'low' | 'unconfirmed'
  label: string
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" data-price-marker={kind} />
      {label}
    </span>
  )
}

/**
 * Store lines and marker key, plus notes on what the chart leaves out:
 * where tracking began when the range reaches back further, and stores
 * priced in another currency.
 */
export function ChartLegend({ history }: { history: KnifeHistory }) {
  const currency = chartCurrency(history)
  const hiddenNote = hiddenCurrencyNote(hiddenCurrencies(history, currency))
  const fitted =
    history.chartStart !== null && history.chartStart !== history.rangeStart
  const kinds = new Set(
    history.events
      .filter((event) => event.type === 'stock' || event.currency === currency)
      .map((event) => event.kind),
  )
  const hasUnconfirmed = history.sources.some(
    (source) => source.unconfirmed?.length,
  )
  const storeCount = history.sources.filter(
    (source) => source.points.length,
  ).length
  return (
    <div className="space-y-1">
      {fitted || hiddenNote ? (
        <div
          data-price-chart-notes
          className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground"
        >
          {fitted && history.chartStart ? (
            <span>
              Tracking since{' '}
              {new Date(history.chartStart).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                ...(new Date(history.chartStart).getFullYear() !==
                new Date().getFullYear()
                  ? { year: 'numeric' as const }
                  : {}),
              })}
            </span>
          ) : null}
          {hiddenNote ? <span>{hiddenNote}</span> : null}
        </div>
      ) : null}
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
          {storeCount > 1 ? 'Out of stock at every store' : 'Out of stock'}
        </span>
        {history.paid ? (
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block w-3.5 border-t-2 border-dashed border-muted-foreground"
            />
            Regular price
          </span>
        ) : null}
        {kinds.has('drop') ? <MarkerSwatch kind="drop" label="Drop" /> : null}
        {kinds.has('increase') ? (
          <MarkerSwatch kind="increase" label="Increase" />
        ) : null}
        {kinds.has('out_of_stock') || kinds.has('back_in_stock') ? (
          <MarkerSwatch kind="stock" label="Stock change" />
        ) : null}
        {history.stats?.lowest && history.stats.currency === currency ? (
          <MarkerSwatch
            kind="low"
            label={
              // With several stores, which one had the lowest price matters.
              storeCount > 1
                ? `Lowest seen: ${money(
                    history.stats.lowest.priceMinor,
                    currency,
                  )} at ${storeLabel(history.stats.lowest.storeName)}`
                : 'Lowest seen'
            }
          />
        ) : null}
        {hasUnconfirmed ? (
          <MarkerSwatch kind="unconfirmed" label="AI unconfirmed" />
        ) : null}
      </div>
    </div>
  )
}
