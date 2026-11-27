import type { EChartsOption } from 'echarts'
import { wishlistMoves, type WishlistTrend } from '@/lib/wishlist'
import { money } from './price-format'

/**
 * The price chart on Price Drops, Wishlist and the open item: a plain line
 * through every store reading in time order (a higher price takes it up, a
 * lower one down), coloured by price from green (cheapest) to red (dearest),
 * with a dot in the store's colour for every reading. The scale starts at
 * zero, so a line's height is in proportion to its price.
 */

/** One store's own history, drawn as dots. */
export type RowChartStore = {
  /** The store's lane key (its host): picks its colour. */
  key: string
  label: string
  trend: WishlistTrend
}

/** Room above the highest price, as a share of it. */
const TOP_PAD = 0.08

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

/**
 * Every price a store showed, in stock or not (`readings`); a trend without
 * them falls back to its in-stock steps. The chart is price history: stock
 * shows elsewhere.
 */
export function shownPrices(
  trend: Pick<WishlistTrend, 'steps' | 'readings'>,
): Priced[] {
  return (
    trend.readings ??
    trend.steps.filter((step): step is Priced => step.price !== null)
  )
}

function pricedSteps(trend: WishlistTrend): Priced[] {
  return trend.steps.filter((step): step is Priced => step.price !== null)
}

/**
 * Every price from every store in the trend's currency (`shownPrices`, in
 * stock or not), merged in time order: the points of the price line. A
 * store's price in force when the window opens counts as a reading at its
 * start; readings at the same moment keep the stores' order. The latest
 * reading holds to the window's end so the line reaches the right edge.
 * Without stores, the trend's own prices are used.
 */
export function rowChartReadings(
  trend: Pick<
    WishlistTrend,
    'steps' | 'readings' | 'since' | 'until' | 'currency'
  >,
  stores: readonly RowChartStore[],
): Array<[number, number]> {
  const own = stores.filter((store) => store.trend.currency === trend.currency)
  const sources = own.length ? own.map((store) => store.trend) : [trend]
  const readings: Array<{ at: number; price: number; order: number }> = []
  sources.forEach((source, order) => {
    const shown = shownPrices(source)
    const opening = shown.filter((step) => step.at < trend.since).at(-1)
    if (opening) readings.push({ at: trend.since, price: opening.price, order })
    for (const step of shown)
      if (step.at >= trend.since && step.at <= trend.until)
        readings.push({ at: step.at, price: step.price, order })
  })
  readings.sort((a, b) => a.at - b.at || a.order - b.order)
  const points = readings.map(
    (reading) => [reading.at, reading.price] as [number, number],
  )
  const last = points.at(-1)
  if (last && last[0] < trend.until) points.push([trend.until, last[1]])
  return points
}

/**
 * The price line: a smooth curve through the readings over a light fill in
 * the line's colours. Monotone along time, so the curve never swings past a
 * reading.
 */
export function priceLineSeries(
  readings: Array<[number, number]>,
  flatColor: string,
  width = 2,
) {
  const prices = readings.map((point) => point[1])
  const flat = Math.min(...prices) === Math.max(...prices)
  return {
    name: 'Price',
    type: 'line' as const,
    smooth: 0.4,
    smoothMonotone: 'x' as const,
    showSymbol: false,
    symbol: 'none',
    z: 2,
    lineStyle: flat ? { width, color: flatColor } : { width },
    itemStyle: flat ? { color: flatColor } : undefined,
    // Without a colour of its own the fill takes the line's price gradient.
    areaStyle: flat ? { color: flatColor, opacity: 0.12 } : { opacity: 0.12 },
    data: readings,
  }
}

/**
 * The line's colour by price, as in the ECharts line-gradient example:
 * green at the lowest reading, red at the highest. Null when every reading
 * is the same price (the line is then grey).
 */
export function priceLineVisualMap(
  readings: Array<[number, number]>,
  colors: { down: string; up: string },
) {
  const prices = readings.map((point) => point[1])
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  if (!prices.length || min === max) return null
  return {
    show: false,
    type: 'continuous' as const,
    seriesIndex: 0,
    dimension: 1,
    min,
    max,
    inRange: { color: [colors.down, colors.up] },
  }
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

/**
 * The vertical range: from zero, so a line's height is in proportion to its
 * price (half the price sits at half the height), up to the highest price
 * shown, the item's price included, with a little room above.
 */
export function rowChartRange(prices: readonly number[]): {
  min: number
  max: number
} {
  const high = Math.max(0, ...prices)
  return { min: 0, max: high + Math.max(high * TOP_PAD, 1) }
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

/**
 * What the tooltip lists at a moment: best price, each store, your price.
 * Stores priced in another currency are not on the line but are listed
 * last, in their own currency, so every store of the knife shows.
 */
export function rowChartTooltip(
  input: RowChartInput,
  at: number,
  dark = false,
): string {
  const { trend, regularMinor } = input
  const currency = trend.currency
  const best = priceAt(trend, at)
  const tracked = input.stores
    .map((store) => ({ store, price: priceAt(store.trend, at) }))
    .filter(
      (row) => row.store.trend.steps[0] && row.store.trend.steps[0].at <= at,
    )
  const byPrice = (a: { price: number | null }, b: { price: number | null }) =>
    (a.price ?? Infinity) - (b.price ?? Infinity)
  const rows = tracked
    .filter((row) => row.store.trend.currency === currency)
    .sort(byPrice)
  const elsewhere = tracked
    .filter((row) => row.store.trend.currency !== currency)
    .sort(byPrice)
  const bestStore =
    best === null ? undefined : rows.find((row) => row.price === best)?.store
  const lines = [`<div data-row-chart-tip-time>${escapeHtml(when(at))}</div>`]
  lines.push(
    best === null
      ? '<div>Out of stock</div>'
      : `<div>Best <b>${escapeHtml(money(best, currency))}</b>${bestStore ? ` · ${escapeHtml(bestStore.label)}` : ''}</div>`,
  )
  if (rows.length + elsewhere.length > 1)
    for (const { store, price } of [...rows, ...elsewhere])
      lines.push(
        `<div data-row-chart-tip-store><span><i style="background:${storeColor(store.key, dark)}"></i>${escapeHtml(store.label)}</span><b>${price === null ? 'out of stock' : escapeHtml(money(price, store.trend.currency ?? currency))}</b></div>`,
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
  const { trend } = input
  const stores = input.stores.filter(
    (store) => store.trend.currency === trend.currency,
  )
  const readings = rowChartReadings(trend, stores)
  const visualMap = priceLineVisualMap(readings, colors)
  const dots = stores.map((store) => ({
    store,
    points: shownPrices(store.trend).filter(
      (step) => step.at >= trend.since && step.at <= trend.until,
    ),
  }))
  const range = rowChartRange(
    readings.length
      ? readings.map((point) => point[1])
      : pricedSteps(trend).map((step) => step.price),
  )
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
    ...(visualMap ? { visualMap } : {}),
    series: [
      priceLineSeries(readings, colors.flat),
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
