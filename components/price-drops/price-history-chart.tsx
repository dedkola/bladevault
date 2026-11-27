'use client'

import { useCallback, useEffect, useState } from 'react'
import type { EChartsOption } from 'echarts'
import {
  InsightsChart,
  type InsightsChartPalette,
} from '@/components/insights-chart'
import { toMinorUnits } from '@/lib/price-monitor/money'
import { laneKeyForUrl } from '@/lib/price-monitor/shared'
import {
  HISTORY_RANGES,
  type HistoryRange,
  type KnifeHistory,
} from '@/lib/price-monitor/insights'
import { cn } from '@/lib/utils'
import { money, storeLabel } from './price-format'
import {
  historyChartTrends,
  historyEnd,
  historyLineLabel,
  storeLinesAt,
} from './price-history-model'
import {
  priceAt,
  priceLineSeries,
  priceLineVisualMap,
  rowChartRange,
  rowChartReadings,
  shownPrices,
  storeColor,
} from './row-price-chart-model'
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

/** The regular price (your price) in the chart's currency, minor units. */
function regularMinor(
  history: KnifeHistory,
  currency: string | null,
): number | null {
  const paid = history.paid
  if (!paid || !currency || paid.currency !== currency || !(paid.amount > 0))
    return null
  return toMinorUnits(paid.amount, currency)
}

const isDarkMode = () =>
  typeof document !== 'undefined' &&
  (document.documentElement.classList.contains('dark') ||
    document.documentElement.dataset.themeMode === 'dark')

/** A store's colour on the chart: the same as on the row charts. */
export function historySourceColor(
  source: KnifeHistory['sources'][number],
  dark = false,
): string {
  return storeColor(laneKeyForUrl(source.url), dark)
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

type MarkerKind = 'drop' | 'increase' | 'low'

type Marker = { kind: MarkerKind; x: number; minor: number; tip: string }

const MARKER_SYMBOL: Record<
  MarkerKind,
  { symbol: string; size: number; rotate?: number }
> = {
  drop: { symbol: 'triangle', size: 9, rotate: 180 },
  increase: { symbol: 'triangle', size: 9 },
  low: { symbol: 'diamond', size: 11 },
}

/** Price drops and increases in the chart's currency, and the lowest price. */
function buildMarkers(
  history: KnifeHistory,
  currency: string | null,
  xMin: number | null,
): Marker[] {
  const markers: Marker[] = []
  const inView = (x: number) => xMin === null || x >= xMin
  const format = (minor: number) => money(minor, currency)
  for (const event of history.events) {
    const x = Date.parse(event.occurredAt)
    if (
      event.type !== 'price' ||
      (event.kind !== 'drop' && event.kind !== 'increase') ||
      !inView(x) ||
      event.currency !== currency ||
      event.priceMinor === null
    )
      continue
    const store = storeLabel(event.storeName)
    const pct = event.deltaPct === null ? '' : ` (${Math.abs(event.deltaPct)}%)`
    const before =
      event.previousPriceMinor === null
        ? ''
        : `${format(event.previousPriceMinor)} → `
    const previous = event.previousStoreName
      ? storeLabel(event.previousStoreName)
      : null
    markers.push({
      kind: event.kind,
      x,
      minor: event.priceMinor,
      tip: previous
        ? `${store} sells it for less than ${previous}: ${before}${format(event.priceMinor)}${pct}`
        : `${event.kind === 'drop' ? 'Price drop' : 'Price increase'} at ${store}: ${before}${format(event.priceMinor)}${pct}`,
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
        tip: `Lowest price seen: ${format(low.priceMinor)} at ${storeLabel(low.storeName)}`,
      })
  }
  return markers
}

/** "$120" for a y-axis tick: whole units, no cents. */
function axisMoney(minor: number, currency: string | null): string {
  return money(Math.round(minor / 100) * 100, currency).replace(
    /[.,]00(?=\D*$)/,
    '',
  )
}

/**
 * The open knife's price history, drawn like the row charts: a plain line
 * through every store reading in time order, coloured by price from green
 * (cheapest) to red (dearest), and a dot in the store's colour for every
 * reading, on a scale from zero. Markers
 * show price drops and increases and the lowest price seen; the tooltip
 * lists every store's price and stock at the hovered moment.
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
      const dark = isDarkMode()
      // To today, like the row charts: the latest prices hold until now.
      const trends = historyChartTrends(history, currency, Date.now())
      const end = trends?.best.until ?? historyEnd(history)
      const xMin = history.chartStart ? Date.parse(history.chartStart) : null
      const regular = regularMinor(history, currency)
      const lineColor = {
        down: cssColor('--price-drop', '#2f7d46'),
        up: cssColor('--price-rise', '#b4232a'),
        flat: cssColor('--price-neutral', '#9a958b'),
      }
      const markerColor: Record<MarkerKind, string> = {
        drop: lineColor.down,
        increase: lineColor.up,
        low: palette.gold,
      }
      const markers = buildMarkers(history, currency, xMin)
      const best = trends?.best
      // Every store reading in time order: up on a higher price, down on a
      // lower one, coloured green (cheapest) to red (dearest).
      const readings = trends
        ? rowChartReadings(trends.best, trends.stores)
        : []
      const visualMap = priceLineVisualMap(readings, lineColor)
      const dots = (trends?.stores ?? []).map((store) => ({
        store,
        points: shownPrices(store.trend).filter(
          (step) => xMin === null || step.at >= xMin,
        ),
      }))
      const prices = [
        ...readings.map((point) => point[1]),
        ...markers.map((marker) => marker.minor),
      ]
      const range = prices.length ? rowChartRange(prices) : null
      const xValues = [
        ...(best ? [best.since, best.until] : []),
        ...markers.map((marker) => marker.x),
      ]
      const xLow = xMin ?? Math.min(...xValues)
      const xHigh = Math.max(...xValues)
      const tolerance = Math.max((xHigh - xLow) * 0.02, 60_000)

      return {
        animation: false,
        grid: { left: 8, right: 12, top: 14, bottom: 8, containLabel: true },
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
          axisPointer: {
            type: 'line',
            lineStyle: { color: palette.muted, type: 'dashed' },
          },
          // Every store at the hovered moment, not only the series ECharts
          // finds nearest.
          formatter: (raw) => {
            const params = (Array.isArray(raw) ? raw : [raw]) as Array<{
              axisValue?: unknown
            }>
            const at = Number(params[0]?.axisValue)
            if (!Number.isFinite(at)) return ''
            const lines: string[] = [
              `<div style="opacity:.75">${escapeHtml(
                new Date(at).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              )}</div>`,
            ]
            const bestNow = best ? priceAt(best, at) : null
            if (bestNow !== null)
              lines.push(
                `<div>Best <b>${escapeHtml(money(bestNow, currency))}</b></div>`,
              )
            for (const line of storeLinesAt(history, at, end, currency))
              lines.push(
                `<div${line.out ? ' style="opacity:.7"' : ''}><span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:${historySourceColor(history.sources[line.index], dark)}"></span>${escapeHtml(
                  line.label,
                )}: <b>${escapeHtml(line.price)}</b>${line.note ? ` · ${escapeHtml(line.note)}` : ''}</div>`,
              )
            if (regular)
              lines.push(
                `<div style="opacity:.75">Your price ${escapeHtml(money(regular, currency))}</div>`,
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
          max: best?.until,
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
          ...(range ?? {}),
          axisLabel: {
            color: palette.muted,
            fontSize: 10,
            formatter: (value: number) => axisMoney(value, currency),
          },
          splitLine: { lineStyle: { color: palette.ringTrack } },
        },
        ...(visualMap ? { visualMap } : {}),
        series: [
          priceLineSeries(readings, lineColor.flat),
          ...dots.map(({ store, points }) => ({
            type: 'scatter' as const,
            name: store.label,
            z: 3,
            symbolSize: 7,
            itemStyle: {
              color: storeColor(store.key, dark),
              borderColor: palette.card,
              borderWidth: 1.5,
            },
            data: points.map((point) => [point.at, point.price]),
          })),
          {
            type: 'scatter',
            name: 'Changes',
            z: 5,
            data: markers.map((marker) => {
              const look = MARKER_SYMBOL[marker.kind]
              return {
                value: [marker.x, marker.minor],
                symbol: look.symbol,
                symbolSize: look.size,
                symbolRotate: look.rotate ?? 0,
                itemStyle: {
                  color: markerColor[marker.kind],
                  borderColor: palette.card,
                  borderWidth: 1,
                },
              }
            }),
          },
        ],
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

function MarkerSwatch({
  kind,
  label,
}: {
  kind: 'drop' | 'increase' | 'low'
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
 * The chart's key (the price line, each store's dots, markers),
 * plus notes on what the chart leaves out: where tracking began when the
 * range reaches back further, and stores priced in another currency.
 */
export function ChartLegend({ history }: { history: KnifeHistory }) {
  const currency = chartCurrency(history)
  const hiddenNote = hiddenCurrencyNote(hiddenCurrencies(history, currency))
  const fitted =
    history.chartStart !== null && history.chartStart !== history.rangeStart
  const kinds = new Set(
    history.events
      .filter((event) => event.type === 'price' && event.currency === currency)
      .map((event) => event.kind),
  )
  const trends = historyChartTrends(history, currency)
  const stores = history.sources.filter(
    (source) => source.points.length && !source.variantTitle,
  )
  const dark = isDarkMode()
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
        {trends ? (
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              data-price-legend-best
              className="inline-block h-0.5 w-3.5 rounded-full"
              style={{
                background:
                  'linear-gradient(90deg, var(--price-drop, #2f7d46), var(--price-rise, #b4232a))',
              }}
            />
            Price
          </span>
        ) : null}
        {stores.map((source) => (
          <span
            key={source.sourceId}
            className="inline-flex items-center gap-1.5"
          >
            <span
              aria-hidden="true"
              data-price-legend-store
              className="inline-block size-2 rounded-full"
              style={{ background: historySourceColor(source, dark) }}
            />
            {historyLineLabel(source)}
          </span>
        ))}
        {kinds.has('drop') ? <MarkerSwatch kind="drop" label="Drop" /> : null}
        {kinds.has('increase') ? (
          <MarkerSwatch kind="increase" label="Increase" />
        ) : null}
        {history.stats?.lowest && history.stats.currency === currency ? (
          <MarkerSwatch
            kind="low"
            label={
              // With several stores, which one had the lowest price matters.
              stores.length > 1
                ? `Lowest seen: ${money(
                    history.stats.lowest.priceMinor,
                    currency,
                  )} at ${storeLabel(history.stats.lowest.storeName)}`
                : 'Lowest seen'
            }
          />
        ) : null}
      </div>
    </div>
  )
}
