import { describe, expect, it } from 'vitest'
import {
  historyChartTrends,
  historyEnd,
  outOfStockEverywhere,
  readingAt,
  sourceSpans,
  storeLineData,
  storeLinesAt,
} from '@/components/price-drops/price-history-model'
import type { HistoryPoint, SourceHistory } from '@/lib/price-monitor/insights'

const t = (hour: number) => new Date(Date.UTC(2026, 10, 20, hour)).toISOString()
const ms = (hour: number) => Date.parse(t(hour))

function point(
  from: number,
  to: number,
  priceMinor: number | null,
  availability: HistoryPoint['availability'] = 'in_stock',
): HistoryPoint {
  return { from: t(from), to: t(to), priceMinor, currency: 'USD', availability }
}

function source(
  sourceId: number,
  storeName: string,
  points: HistoryPoint[],
  removed = false,
): SourceHistory {
  return { sourceId, storeName, url: '', removed, points, unconfirmed: [] }
}

// Kizer Militaw: out of stock at Kizer since 0:00, Blade HQ in stock at 6:00.
const kizer = source(1, 'kizerknives.com', [point(0, 8, 6795, 'out_of_stock')])
const bladeHq = source(2, 'bladehq.com', [point(6, 6, 6795)])
const militaw = { sources: [kizer, bladeHq] }

describe('price history model', () => {
  it('holds a reading until the next one, and a live store to the end', () => {
    const steps = source(1, 'a.example', [point(0, 1, 100), point(4, 5, 90)])
    expect(readingAt(steps, ms(2), ms(10))?.priceMinor).toBe(100)
    expect(readingAt(steps, ms(9), ms(10))?.priceMinor).toBe(90)
    expect(readingAt(steps, ms(-1), ms(10))).toBeNull()
    const removed = { ...steps, removed: true }
    expect(readingAt(removed, ms(9), ms(10))).toBeNull()
    expect(historyEnd(militaw)).toBe(ms(8))
  })

  const spanTimes = (source: SourceHistory, end: number) =>
    sourceSpans(source, end).map((span) => [span.from, span.to])

  it('spans the single snapshot of a live store to the history end', () => {
    expect(spanTimes(bladeHq, ms(10))).toEqual([[ms(6), ms(10)]])
  })

  it('stops a removed store at the last time it was seen', () => {
    expect(spanTimes({ ...bladeHq, removed: true }, ms(10))).toEqual([
      [ms(6), ms(6)],
    ])
  })

  it('steps at the next reading rather than at last seen', () => {
    const steps = source(1, 'a.example', [point(0, 1, 100), point(4, 5, 90)])
    expect(spanTimes(steps, ms(10))).toEqual([
      [ms(0), ms(4)],
      [ms(4), ms(10)],
    ])
  })

  it('draws a single reading as a line, not a dot', () => {
    const { data, dotted } = storeLineData(bladeHq, ms(10), 'USD', 60_000)
    expect(data).toEqual([
      [ms(6), 67.95],
      [ms(10), 67.95],
    ])
    expect(dotted.size).toBe(0)
  })

  it('dots the single reading of a removed store and breaks on other currencies', () => {
    const removed = { ...bladeHq, removed: true }
    expect(storeLineData(removed, ms(10), 'USD', 0)).toEqual({
      data: [
        [ms(6), 67.95],
        [ms(6), 67.95],
      ],
      dotted: new Set([0]),
    })
    expect(storeLineData(bladeHq, ms(10), 'EUR', 0).data).toEqual([
      [ms(6), null],
      [ms(10), null],
    ])
  })

  it('holds the last price over readings without one', () => {
    const steps = source(1, 'a.example', [
      point(0, 0, null, 'out_of_stock'),
      point(1, 2, 9000),
      point(3, 3, null, 'out_of_stock'),
      point(5, 6, 8500),
    ])
    expect(storeLineData(steps, ms(8), 'USD', 0)).toEqual({
      data: [
        [ms(0), null],
        [ms(1), null],
        [ms(1), 90],
        [ms(3), 90],
        [ms(3), 90],
        [ms(5), 90],
        [ms(5), 85],
        [ms(8), 85],
      ],
      dotted: new Set(),
    })
  })

  it('shades only while no store had the knife in stock', () => {
    expect(outOfStockEverywhere(militaw)).toEqual([[ms(0), ms(6)]])
    expect(outOfStockEverywhere({ sources: [kizer] })).toEqual([[ms(0), ms(8)]])
    // A store not tracked yet does not clear it; one selling it does.
    const later = source(3, 'amazon', [point(2, 8, 7000)])
    expect(outOfStockEverywhere({ sources: [kizer, later] })).toEqual([
      [ms(0), ms(2)],
    ])
  })

  it('lists every store at a moment, with stock and the cheapest', () => {
    expect(storeLinesAt(militaw, ms(7), ms(8), 'USD')).toEqual([
      {
        index: 0,
        label: 'kizerknives.com',
        price: '$67.95',
        note: 'out of stock',
        out: true,
        cheapest: false,
      },
      {
        index: 1,
        label: 'Blade HQ',
        price: '$67.95',
        note: '',
        out: false,
        cheapest: false,
      },
    ])
    // Before Blade HQ was found only Kizer is listed.
    expect(storeLinesAt(militaw, ms(3), ms(8), 'USD')).toHaveLength(1)
    const cheaper = source(3, 'amazon', [point(0, 8, 5999)])
    const lines = storeLinesAt(
      { sources: [bladeHq, cheaper] },
      ms(7),
      ms(8),
      'USD',
    )
    // The cheapest store is marked and listed first.
    expect(lines.map((line) => [line.index, line.cheapest])).toEqual([
      [1, true],
      [0, false],
    ])
  })

  it('keeps other-variant listings out of the knife’s stock and cheapest store', () => {
    const variant = {
      ...source(4, 'bladehq.com', [point(0, 8, 4999)]),
      variantTitle: 'Militaw Blue G10',
    }
    // Kizer is out of stock and only a variant sells: the knife is still
    // out of stock everywhere.
    expect(outOfStockEverywhere({ sources: [kizer, variant] })).toEqual([
      [ms(0), ms(8)],
    ])
    const lines = storeLinesAt(
      { sources: [bladeHq, variant] },
      ms(7),
      ms(8),
      'USD',
    )
    expect(lines.map((line) => [line.label, line.cheapest])).toEqual([
      ['Blade HQ', false],
      ['Blade HQ (variant: Militaw Blue G10)', false],
    ])
  })
})

describe('historyChartTrends', () => {
  it('builds the best in-stock price across stores, and each store’s own steps', () => {
    const a = source(1, 'a.example', [point(0, 1, 100), point(4, 5, 90)])
    const b = {
      ...source(2, 'b.example', [point(2, 9, 95)]),
      url: 'https://www.bladehq.com/item',
    }
    const result = historyChartTrends(
      { sources: [a, b], chartStart: null },
      'USD',
    )
    expect(result?.best.steps).toEqual([
      { at: ms(0), price: 100 },
      { at: ms(2), price: 95 },
      { at: ms(4), price: 90 },
    ])
    expect(result?.best.since).toBe(ms(0))
    expect(result?.best.until).toBe(ms(9))
    expect(result?.stores.map((store) => store.key)).toEqual([
      'invalid',
      'bladehq.com',
    ])
    expect(result?.stores[1].trend.steps).toEqual([{ at: ms(2), price: 95 }])
  })

  it('skips out-of-stock readings, other currencies and variant listings', () => {
    const a = source(1, 'a.example', [
      point(0, 1, 100),
      point(2, 3, 80, 'out_of_stock'),
      { ...point(4, 5, 70), currency: 'EUR' },
    ])
    const variant = {
      ...source(2, 'b.example', [point(0, 5, 50)]),
      variantTitle: 'Blue',
    }
    const result = historyChartTrends(
      { sources: [a, variant], chartStart: t(-2) },
      'USD',
    )
    expect(result?.best.steps).toEqual([
      { at: ms(0), price: 100 },
      { at: ms(2), price: null },
    ])
    expect(result?.best.since).toBe(ms(-2))
    expect(result?.stores).toHaveLength(1)
  })

  it('runs to now when given, the latest prices holding until then', () => {
    const a = source(1, 'a.example', [point(0, 1, 100), point(4, 5, 90)])
    const result = historyChartTrends(
      { sources: [a], chartStart: null },
      'USD',
      ms(20),
    )
    expect(result?.best.until).toBe(ms(20))
    expect(result?.best.steps.at(-1)).toEqual({ at: ms(4), price: 90 })
    // A "now" before the last reading never cuts the chart short.
    expect(
      historyChartTrends({ sources: [a], chartStart: null }, 'USD', ms(1))?.best
        .until,
    ).toBe(ms(5))
  })

  it('is null without any reading', () => {
    expect(
      historyChartTrends({ sources: [], chartStart: null }, 'USD'),
    ).toBeNull()
  })
})
