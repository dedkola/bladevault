import { describe, expect, it } from 'vitest'
import {
  classifyPriceMoves,
  type PriceMoveEvent,
} from '@/lib/price-monitor/price-moves'

/** Events from a price path: [start, p1, p2, ...], one per hour. */
function path(prices: number[], currency = 'USD'): PriceMoveEvent[] {
  return prices.slice(1).map((price, index) => ({
    id: index + 1,
    previousPriceMinor: prices[index],
    priceMinor: price,
    currency,
    occurredAt: new Date(Date.UTC(2026, 10, 1, index)).toISOString(),
  }))
}

function classify(prices: number[], minPercent = 5) {
  return classifyPriceMoves(
    path(prices),
    { priceMinor: prices.at(-1)!, currency: 'USD' },
    minPercent,
  )
}

describe('classifyPriceMoves', () => {
  it('reports no change without events', () => {
    expect(
      classifyPriceMoves([], { priceMinor: 100, currency: 'USD' }, 5),
    ).toMatchObject({ result: 'same', driftPct: null, fluctuating: false })
  })

  it('counts a move at or above the threshold', () => {
    expect(classify([10000, 8000])).toMatchObject({
      result: 'drop',
      previousPriceMinor: 10000,
      deltaMinor: -2000,
      deltaPct: -20,
      changedAt: '2026-11-01T00:00:00.000Z',
      significantIds: [1],
    })
    expect(classify([10000, 10500])).toMatchObject({
      result: 'increase',
      deltaPct: 5,
    })
  })

  it('treats moves under the threshold as no change with a drift hint', () => {
    expect(classify([1_000_000, 997_000])).toMatchObject({
      result: 'same',
      previousPriceMinor: null,
      deltaMinor: null,
      driftPct: -0.3,
      fluctuating: false,
      significantIds: [],
    })
  })

  it('adds up small moves until they pass the threshold', () => {
    const drift = [10000, 9900, 9800, 9700, 9600, 9490, 9480]
    expect(classify(drift.slice(0, 5))).toMatchObject({
      result: 'same',
      driftPct: -4,
    })
    expect(classify(drift)).toMatchObject({
      result: 'drop',
      previousPriceMinor: 10000,
      deltaMinor: -520,
      deltaPct: -5.2,
      // When the drift crossed the threshold, not the last small step.
      changedAt: '2026-11-01T04:00:00.000Z',
      significantIds: [5],
    })
  })

  it('measures later moves from the last counted change', () => {
    expect(classify([10000, 8000, 7900])).toMatchObject({
      result: 'drop',
      previousPriceMinor: 10000,
      deltaMinor: -2100,
    })
    expect(classify([10000, 8000, 6000])).toMatchObject({
      result: 'drop',
      previousPriceMinor: 8000,
      deltaMinor: -2000,
      deltaPct: -25,
    })
    expect(classify([10000, 7000, 8000])).toMatchObject({
      result: 'increase',
      previousPriceMinor: 7000,
    })
  })

  it('cancels a rise that falls back (flapping)', () => {
    // GMF1-Chef: up in the morning, back by the afternoon. 105 → 100 is
    // under 5% of 105, but it returns to the earlier level.
    expect(classify([10000, 10500, 10000])).toMatchObject({
      result: 'same',
      driftPct: null,
      fluctuating: true,
      significantIds: [1, 2],
    })
    expect(classify([10000, 8000, 10100])).toMatchObject({
      result: 'same',
      driftPct: 1,
      fluctuating: true,
    })
  })

  it('returns to any earlier level, not only the previous one', () => {
    expect(classify([10000, 8000, 6000, 10000])).toMatchObject({
      result: 'same',
      fluctuating: true,
    })
    // Back at the first rise: the rise still stands, marked as fluctuating.
    expect(classify([10000, 12000, 8000, 12000])).toMatchObject({
      result: 'increase',
      previousPriceMinor: 10000,
      deltaMinor: 2000,
      changedAt: '2026-11-01T00:00:00.000Z',
      fluctuating: true,
    })
  })

  it('keeps a counted change through a small retrace (hysteresis)', () => {
    // 9490 counted as a drop; 9530 is not back within 2.5% of 10000.
    expect(classify([10000, 9490, 9530])).toMatchObject({
      result: 'drop',
      previousPriceMinor: 10000,
      deltaMinor: -470,
      fluctuating: false,
    })
  })

  it('counts every move at a threshold of 0, flapping only on exact returns', () => {
    expect(classify([1_000_000, 997_000], 0)).toMatchObject({
      result: 'drop',
      deltaPct: -0.3,
    })
    expect(classify([10000, 10010, 10000], 0)).toMatchObject({
      result: 'same',
      fluctuating: true,
    })
    expect(classify([10000, 10010, 10001], 0)).toMatchObject({
      result: 'drop',
      previousPriceMinor: 10010,
    })
  })

  it('reports no change when the current price is not the latest event', () => {
    expect(
      classifyPriceMoves(
        path([10000, 8000]),
        { priceMinor: null, currency: 'USD' },
        5,
      ),
    ).toMatchObject({ result: 'same', significantIds: [1] })
    expect(
      classifyPriceMoves(
        path([10000, 8000]),
        { priceMinor: 8000, currency: 'EUR' },
        5,
      ).result,
    ).toBe('same')
  })

  it('starts over when the store switches currency', () => {
    const events = [
      ...path([10000, 8000], 'USD'),
      ...path([400_000, 399_000], 'UAH').map((event) => ({ ...event, id: 9 })),
    ]
    expect(
      classifyPriceMoves(events, { priceMinor: 399_000, currency: 'UAH' }, 5),
    ).toMatchObject({ result: 'same', driftPct: -0.25, significantIds: [1] })
  })
})
