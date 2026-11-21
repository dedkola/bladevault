import { describe, expect, it } from 'vitest'
import {
  historyEnd,
  outOfStockEverywhere,
  readingAt,
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
      },
      { index: 1, label: 'Blade HQ', price: '$67.95', note: '', out: false },
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
    expect(lines.map((line) => line.note)).toEqual(['', 'cheapest'])
  })
})
