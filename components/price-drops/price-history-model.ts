import type {
  HistoryPoint,
  KnifeHistory,
  SourceHistory,
} from '@/lib/price-monitor/insights'
import { fromMinorUnits } from '@/lib/price-monitor/money'
import { money, storeLabel } from './price-format'

/**
 * A knife's stores are one item on its chart: these read every store at a
 * moment, so the tooltip and the out-of-stock shading describe the knife
 * rather than whichever store's line is nearest. Pure, for tests.
 */

export type SourceSpan = { from: number; to: number; point: HistoryPoint }

/** The latest moment the history knows about: its newest reading. */
export function historyEnd(history: Pick<KnifeHistory, 'sources'>): number {
  let end = Number.NEGATIVE_INFINITY
  for (const source of history.sources)
    for (const point of source.points)
      end = Math.max(end, Date.parse(point.from), Date.parse(point.to))
  return end
}

/**
 * When each reading was in force: until the next reading began; the last
 * one until it was last seen, or for a store still monitored, until the
 * history's end (its newest reading is what the store shows now). The
 * chart draws these spans as its step lines, so a single snapshot still
 * gets a visible line.
 */
export function sourceSpans(source: SourceHistory, end: number): SourceSpan[] {
  return source.points.map((point, index) => {
    const from = Date.parse(point.from)
    const next = source.points[index + 1]
    const seen = Math.max(Date.parse(point.to), from)
    const to = next
      ? Math.max(Date.parse(next.from), from)
      : source.removed
        ? seen
        : Math.max(seen, end)
    return { from, to, point }
  })
}

/**
 * A store's step-line data for the chart: each reading's span as a pair of
 * [time, price] points, with a null price when the reading has no price or
 * shows another currency than the chart (so the line breaks there).
 * `dotted` holds the indexes of priced spans too short to see as a line
 * (at most `minVisible` long), which the chart draws as dots instead.
 */
export function storeLineData(
  source: SourceHistory,
  end: number,
  currency: string | null,
  minVisible: number,
): { data: Array<[number, number | null]>; dotted: Set<number> } {
  const data: Array<[number, number | null]> = []
  const dotted = new Set<number>()
  for (const { from, to, point } of sourceSpans(source, end)) {
    const value =
      point.priceMinor !== null && point.currency && point.currency === currency
        ? fromMinorUnits(point.priceMinor, point.currency)
        : null
    if (value !== null && to - from <= minVisible) dotted.add(data.length)
    data.push([from, value], [to, value])
  }
  return { data, dotted }
}

/**
 * What a store showed at a moment, or null before its first reading and
 * after a removed store's last one.
 */
export function readingAt(
  source: SourceHistory,
  at: number,
  end: number,
): HistoryPoint | null {
  let found: SourceSpan | null = null
  for (const span of sourceSpans(source, end)) {
    if (span.from > at) break
    found = span
  }
  return found && at <= found.to ? found.point : null
}

/**
 * Periods when every store the knife was tracked at showed it out of
 * stock. A store not tracked yet (or removed) does not count either way,
 * so one store still selling the knife clears the shading.
 */
export function outOfStockEverywhere(
  history: Pick<KnifeHistory, 'sources'>,
): Array<[number, number]> {
  const end = historyEnd(history)
  // The knife's stock: listings of other variants do not count.
  const spans = history.sources
    .filter((source) => !source.variantTitle)
    .map((source) => sourceSpans(source, end))
  const cuts = [
    ...new Set(spans.flat().flatMap((span) => [span.from, span.to])),
  ].sort((a, b) => a - b)
  const periods: Array<[number, number]> = []
  for (let index = 0; index < cuts.length - 1; index += 1) {
    const start = cuts[index]
    const stop = cuts[index + 1]
    const middle = (start + stop) / 2
    let tracked = false
    let available = false
    for (const list of spans)
      for (const span of list)
        if (span.from <= middle && middle < span.to) {
          tracked = true
          if (span.point.availability !== 'out_of_stock') available = true
        }
    if (!tracked || available) continue
    const last = periods[periods.length - 1]
    if (last && last[1] === start) last[1] = stop
    else periods.push([start, stop])
  }
  return periods
}

export type StoreLine = {
  /** The source's place in `history.sources`, for its line colour. */
  index: number
  label: string
  price: string
  /** "out of stock", "preorder", "limited stock", "cheapest", or empty. */
  note: string
  out: boolean
}

const STOCK_NOTE: Partial<Record<HistoryPoint['availability'], string>> = {
  out_of_stock: 'out of stock',
  preorder: 'preorder',
  limited: 'limited stock',
}

/**
 * Each store's price and stock at a moment, in legend order; stores with
 * no reading then are left out. With two or more stores selling in the
 * chart's currency, a strictly cheapest one is noted.
 */
/**
 * A store's line name: other-variant and removed listings say so. The
 * tooltip (`withTitle`) also names the variant, since a store can have two.
 */
export function historyLineLabel(
  source: Pick<SourceHistory, 'storeName' | 'removed' | 'variantTitle'>,
  withTitle = false,
): string {
  const variant = source.variantTitle
    ? withTitle
      ? ` (variant: ${source.variantTitle})`
      : ' (variant)'
    : ''
  return `${storeLabel(source.storeName)}${variant}${source.removed ? ' (removed)' : ''}`
}

export function storeLinesAt(
  history: Pick<KnifeHistory, 'sources'>,
  at: number,
  end: number,
  currency: string | null,
): StoreLine[] {
  const lines: StoreLine[] = []
  /** In-stock prices in the chart's currency, by line. */
  const selling: Array<{ line: StoreLine; minor: number }> = []
  history.sources.forEach((source, index) => {
    const reading = readingAt(source, at, end)
    if (!reading) return
    const out = reading.availability === 'out_of_stock'
    const line: StoreLine = {
      index,
      label: historyLineLabel(source, true),
      price: money(reading.priceMinor, reading.currency),
      note: STOCK_NOTE[reading.availability] ?? '',
      out,
    }
    lines.push(line)
    if (
      !out &&
      !source.variantTitle &&
      reading.priceMinor !== null &&
      reading.currency === currency
    )
      selling.push({ line, minor: reading.priceMinor })
  })
  if (selling.length >= 2) {
    selling.sort((a, b) => a.minor - b.minor)
    const [first, second] = selling
    if (first.minor < second.minor)
      first.line.note = first.line.note
        ? `${first.line.note}, cheapest`
        : 'cheapest'
  }
  return lines
}
