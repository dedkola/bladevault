import { describe, expect, it } from 'vitest'
import {
  detectChange,
  detectStockChange,
  isPlausiblePrice,
  medianPrice,
  type Observation,
  type SnapshotState,
  type StockSnapshot,
} from '@/lib/price-monitor/detect'

const snap = (
  id: number,
  priceMinor: number | null,
  availability: Observation['availability'] = 'in_stock',
  currency: string | null = priceMinor === null ? null : 'USD',
): SnapshotState => ({ id, priceMinor, currency, availability })

const obs = (
  priceMinor: number | null,
  availability: Observation['availability'] = 'in_stock',
  currency: string | null = priceMinor === null ? null : 'USD',
): Observation => ({ priceMinor, currency, availability })

describe('detectChange', () => {
  it('treats the first observation as a baseline', () => {
    expect(detectChange(null, null, obs(10000))).toEqual({
      action: 'insert',
      priceChange: null,
      currencyChanged: false,
    })
  })

  it('extends the snapshot when nothing changed', () => {
    const latest = snap(1, 10000)
    expect(detectChange(latest, latest, obs(10000)).action).toBe('touch')
  })

  it('reports drops and increases with deltas', () => {
    const latest = snap(1, 10000)
    expect(detectChange(latest, latest, obs(8999)).priceChange).toEqual({
      direction: 'drop',
      previousPriceMinor: 10000,
      priceMinor: 8999,
      currency: 'USD',
      deltaMinor: -1001,
      deltaPct: -10.01,
      fromSnapshotId: 1,
    })
    expect(detectChange(latest, latest, obs(12500)).priceChange).toMatchObject({
      direction: 'increase',
      deltaMinor: 2500,
      deltaPct: 25,
    })
  })

  it('flags a currency change instead of a price change', () => {
    const latest = snap(1, 10000)
    const result = detectChange(latest, latest, obs(9000, 'in_stock', 'EUR'))
    expect(result).toMatchObject({
      action: 'insert',
      priceChange: null,
      currencyChanged: true,
    })
  })
})

/** Snapshots oldest first, as [availability, observations]; ids from 1. */
const history = (
  ...runs: Array<[Observation['availability'], number]>
): StockSnapshot[] =>
  runs
    .map(([availability, observations], index) => ({
      id: index + 1,
      availability,
      observations,
    }))
    .reverse()

describe('detectStockChange', () => {
  it('has no change without history or on the first reading of a status', () => {
    expect(detectStockChange([], 'out_of_stock')).toBeNull()
    // In stock (seen twice), then this check reads sold out for the first time.
    expect(
      detectStockChange(history(['in_stock', 2]), 'out_of_stock'),
    ).toBeNull()
  })

  it('reports a change when a second reading agrees', () => {
    expect(
      detectStockChange(
        history(['in_stock', 3], ['out_of_stock', 1]),
        'out_of_stock',
      ),
    ).toEqual({
      kind: 'out_of_stock',
      previousAvailability: 'in_stock',
      availability: 'out_of_stock',
      fromSnapshotId: 1,
      toSnapshotId: 2,
    })
    // A restock at a new price spans two snapshots: dated at the first.
    expect(
      detectStockChange(
        history(['out_of_stock', 2], ['limited', 1]),
        'limited',
      ),
    ).toMatchObject({
      kind: 'back_in_stock',
      fromSnapshotId: 1,
      toSnapshotId: 2,
    })
  })

  it('reports a change only once', () => {
    expect(
      detectStockChange(
        history(['in_stock', 3], ['out_of_stock', 2]),
        'out_of_stock',
      ),
    ).toBeNull()
  })

  it('ignores a one-off reading and the flip back', () => {
    // Sold out, one in-stock reading, then sold out again (twice).
    const flicker = history(['out_of_stock', 4], ['in_stock', 1])
    expect(detectStockChange(flicker, 'out_of_stock')).toBeNull()
    expect(
      detectStockChange(
        history(['out_of_stock', 4], ['in_stock', 1], ['out_of_stock', 1]),
        'out_of_stock',
      ),
    ).toBeNull()
  })

  it('treats the first readings as the baseline', () => {
    // The source started sold out (one reading), then two in-stock readings.
    expect(
      detectStockChange(
        history(['out_of_stock', 1], ['in_stock', 1]),
        'in_stock',
      ),
    ).toMatchObject({
      kind: 'back_in_stock',
      previousAvailability: 'out_of_stock',
    })
    // First reading in stock, a one-off sold out, then in stock twice.
    expect(
      detectStockChange(
        history(['in_stock', 1], ['out_of_stock', 1], ['in_stock', 1]),
        'in_stock',
      ),
    ).toBeNull()
  })

  it('does not report back in stock for an unknown status', () => {
    expect(
      detectStockChange(
        history(['out_of_stock', 2], ['unknown', 1]),
        'unknown',
      ),
    ).toBeNull()
  })
})

describe('plausibility', () => {
  it('computes medians', () => {
    expect(medianPrice([])).toBeNull()
    expect(medianPrice([300, 100, 200])).toBe(200)
    expect(medianPrice([100, 200])).toBe(150)
  })

  it('accepts prices within 50–300 % of the recent median', () => {
    const history = [10000, 10000, 9900, 50000, 10000]
    expect(isPlausiblePrice(5000, history)).toBe(true)
    expect(isPlausiblePrice(30000, history)).toBe(true)
    expect(isPlausiblePrice(4999, history)).toBe(false)
    expect(isPlausiblePrice(30001, history)).toBe(false)
    expect(isPlausiblePrice(1, [])).toBe(true)
  })
})
