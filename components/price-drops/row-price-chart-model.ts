import type { EChartsOption } from 'echarts'
import { wishlistMoves, type WishlistTrend } from '@/lib/wishlist'
import { money } from './price-format'

/**
 * The row chart on Price Drops and Wishlist (mockup variant A): one filled
 * area for the best store price, a dot in the store's colour for every
 * store reading, and a thin line at the item's own price. The scale fits
 * all of them, the item's price included.
 */

/** One store's own history, drawn as dots. */
export type RowChartStore = {
  /** The store's lane key (its host): picks its colour. */
  key: string
  label: string
  trend: WishlistTrend
}

/**
 * How long before a price change the curve starts to bend, at most: the
 * price holds until the move instead of drifting across days.
 */
export const ROW_CHART_HOLD_MS = 3 * 3_600_000

/** Room above and below the prices, as a share of their range. */
const RANGE_PAD = 0.12
/** Least room, as a share of the highest price, so a flat line has some. */
const MIN_PAD = 0.02

/**
 * Store colours: each store keeps its colour on every chart, whatever its
 * rank. Blue, orange, aqua, yellow, magenta, violet (the validated
 * categorical order, without green and red, which mean down and up).
 */
const STORE_PALETTE = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#6250d6'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9'],
}
const KNOWN_STORES: Record<string, number> = {
  // Amazon's lane key is "amazon" (every Amazon domain is one store).
  amazon: 0,
  'amazon.com': 0,
  'bladehq.com': 1,
  'smkw.com': 2,
  'knifejoy.com': 3,
  'dlttrading.com': 4,
}

export function storeColor(key: string, dark = false): string {
  const palette = dark ? STORE_PALETTE.dark : STORE_PALETTE.light
  const known = KNOWN_STORES[key]
  if (known !== undefined) return palette[known]
  let hash = 0
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return palette[hash % palette.length]
}

type Priced = { at: number; price: number }

function pricedSteps(trend: WishlistTrend): Priced[] {
  return trend.steps.filter((step): step is Priced => step.price !== null)
}

/** A point of the best-price line; bend points carry no symbol. */
export type RowChartPoint = { value: [number, number]; symbol?: 'none' }

/**
 * The best price as smooth steps: each price holds until shortly before
 * the next one (at most `ROW_CHART_HOLD_MS`, at most 40% of the gap), and
 * the last one runs to `until`. Out-of-stock stretches keep the line
 * unbroken at the last price.
 */
export function rowChartLine(
  trend: Pick<WishlistTrend, 'steps' | 'until'>,
): RowChartPoint[] {
  const priced = trend.steps.filter(
    (step): step is Priced => step.price !== null,
  )
  const points: RowChartPoint[] = []
  priced.forEach((step, index) => {
    const previous = priced[index - 1]
    if (previous && previous.price !== step.price) {
      const gap = step.at - previous.at
      const bend = Math.min(ROW_CHART_HOLD_MS, gap * 0.4)
      if (gap > 0)
        points.push({ value: [step.at - bend, previous.price], symbol: 'none' })
    }
    points.push({ value: [step.at, step.price] })
  })
  const last = priced[priced.length - 1]
  if (last && last.at < trend.until)
    points.push({ value: [trend.until, last.price], symbol: 'none' })
  return points
}

/**
 * The colour of the area and line: the best price's latest move (down,
 * up), or flat when it never moved in the window.
 */
export function rowChartDirection(
  trend: WishlistTrend,
): 'down' | 'up' | 'flat' {
  const last = wishlistMoves(trend).at(-1)
  return !last ? 'flat' : last.delta < 0 ? 'down' : 'up'
}

/** The vertical range: every price shown, the item's price included. */
export function rowChartRange(prices: readonly number[]): {
  min: number
  max: number
} {
  const low = Math.min(...prices)
  const high = Math.max(...prices)
  const pad = Math.max((high - low) * RANGE_PAD, high * MIN_PAD, 1)
  return { min: Math.max(0, low - pad), max: high + pad }
}

/** A trend's price at a moment: the last step that started by then. */
export function priceAt(trend: WishlistTrend, at: number): number | null {
  let price: number | null = null
  for (const step of trend.steps) {
    if (step.at > at) break
    price = step.price
  }
  return price
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ]!,
  )

function when(at: number): string {
  const date = new Date(at)
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}

export type RowChartInput = {
  /** The line: the best price across stores (or one store's own). */
  trend: WishlistTrend
  /** Each store's own history, for the dots; other currencies are skipped. */
  stores: readonly RowChartStore[]
  /** The item's own price, in minor units of the trend's currency. */
  regularMinor: number | null
}

export type RowChartColors = {
  down: string
  up: string
  flat: string
  card: string
  foreground: string
  muted: string
  dark: boolean
}

/** What the tooltip lists at a moment: best price, each store, your price. */
export function rowChartTooltip(
  input: RowChartInput,
  at: number,
  dark = false,
): string {
  const { trend, regularMinor } = input
  const currency = trend.currency
  const stores = input.stores.filter(
    (store) => store.trend.currency === currency,
  )
  const best = priceAt(trend, at)
  const rows = stores
    .map((store) => ({ store, price: priceAt(store.trend, at) }))
    .filter(
      (row) => row.store.trend.steps[0] && row.store.trend.steps[0].at <= at,
    )
    .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
  const bestStore =
    best === null ? undefined : rows.find((row) => row.price === best)?.store
  const lines = [`<div data-row-chart-tip-time>${escapeHtml(when(at))}</div>`]
  lines.push(
    best === null
      ? '<div>Out of stock</div>'
      : `<div>Best <b>${escapeHtml(money(best, currency))}</b>${bestStore ? ` · ${escapeHtml(bestStore.label)}` : ''}</div>`,
  )
  if (rows.length > 1)
    for (const { store, price } of rows)
      lines.push(
        `<div data-row-chart-tip-store><span><i style="background:${storeColor(store.key, dark)}"></i>${escapeHtml(store.label)}</span><b>${price === null ? 'out of stock' : escapeHtml(money(price, currency))}</b></div>`,
      )
  if (regularMinor)
    lines.push(
      `<div data-row-chart-tip-regular>Your price ${escapeHtml(money(regularMinor, currency))}</div>`,
    )
  return `<div data-row-chart-tip>${lines.join('')}</div>`
}

/** Room, in px, between the chart and its tooltip. */
const TOOLTIP_GAP = 10

/**
 * Where the tooltip goes, relative to the chart: just right of it, centred
 * on it vertically, so it never covers the line; left of it when the
 * window has no room on the right. `chartRight` is the chart's right edge
 * in the window (null when unknown).
 */
export function rowChartTooltipPosition(
  size: { contentSize: number[]; viewSize: number[] },
  chartRight: number | null,
  windowWidth: number,
): [number, number] {
  const [width, height] = size.contentSize
  const [chartWidth, chartHeight] = size.viewSize
  const top = Math.round((chartHeight - height) / 2)
  const fitsRight =
    chartRight === null || chartRight + TOOLTIP_GAP + width <= windowWidth - 8
  return [fitsRight ? chartWidth + TOOLTIP_GAP : -width - TOOLTIP_GAP, top]
}

/** The ECharts option for a row chart. */
export function rowChartOption(
  input: RowChartInput,
  colors: RowChartColors,
  /** The chart's right edge in the window, read when the tooltip shows. */
  chartRight: () => number | null = () => null,
): EChartsOption {
  const { trend, regularMinor } = input
  const stores = input.stores.filter(
    (store) => store.trend.currency === trend.currency,
  )
  const direction = rowChartDirection(trend)
  const color = colors[direction]
  const dots = stores.map((store) => ({
    store,
    points: pricedSteps(store.trend).filter(
      (step) => step.at >= trend.since && step.at <= trend.until,
    ),
  }))
  const range = rowChartRange([
    ...pricedSteps(trend).map((step) => step.price),
    ...dots.flatMap((dot) => dot.points.map((point) => point.price)),
    ...(regularMinor ? [regularMinor] : []),
  ])
  return {
    animation: false,
    grid: { left: 3, right: 3, top: 4, bottom: 4 },
    tooltip: {
      trigger: 'axis',
      // Beside the chart, never over it, so the line under the pointer
      // stays visible; on the page body so the row does not clip it.
      appendTo: 'body',
      position: (_point, _params, _dom, _rect, size) =>
        rowChartTooltipPosition(
          size,
          chartRight(),
          typeof window === 'undefined' ? Infinity : window.innerWidth,
        ),
      backgroundColor: colors.card,
      borderColor: colors.muted,
      borderWidth: 0.5,
      padding: [6, 8],
      textStyle: { color: colors.foreground, fontSize: 11 },
      axisPointer: {
        type: 'line',
        lineStyle: { color: colors.muted, width: 1, type: 'dashed' },
      },
      formatter: (params) => {
        const first = Array.isArray(params) ? params[0] : params
        const at = Number((first as { axisValue?: unknown }).axisValue)
        return rowChartTooltip(
          input,
          Number.isFinite(at) ? at : trend.until,
          colors.dark,
        )
      },
    },
    xAxis: { type: 'time', min: trend.since, max: trend.until, show: false },
    yAxis: { type: 'value', min: range.min, max: range.max, show: false },
    series: [
      {
        name: 'Best price',
        type: 'line',
        smooth: 0.35,
        smoothMonotone: 'x',
        symbol: 'none',
        z: 2,
        lineStyle: { color, width: 2 },
        itemStyle: { color },
        areaStyle: { color, opacity: 0.16 },
        data: rowChartLine(trend),
        markLine: regularMinor
          ? {
              silent: true,
              symbol: 'none',
              animation: false,
              label: { show: false },
              lineStyle: {
                color: colors.muted,
                width: 1,
                type: 'solid',
                opacity: 0.7,
              },
              data: [{ yAxis: regularMinor }],
            }
          : undefined,
      },
      ...dots.map(({ store, points }) => ({
        name: store.label,
        type: 'scatter' as const,
        z: 3,
        symbolSize: 5,
        itemStyle: {
          color: storeColor(store.key, colors.dark),
          borderColor: colors.card,
          borderWidth: 1,
        },
        data: points.map((point) => [point.at, point.price]),
      })),
    ],
  }
}

const STORE_LISTS = new WeakMap<object, Map<string, RowChartStore[]>>()

/**
 * The same store list for the same row while `owner` (the loaded trends)
 * stays the same, so a page re-render or poll does not redraw the charts.
 */
export function cachedRowChartStores(
  owner: object,
  key: string,
  build: () => RowChartStore[],
): RowChartStore[] {
  let lists = STORE_LISTS.get(owner)
  if (!lists) {
    lists = new Map()
    STORE_LISTS.set(owner, lists)
  }
  let list = lists.get(key)
  if (!list) {
    list = build()
    lists.set(key, list)
  }
  return list
}
