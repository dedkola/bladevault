import { describe, expect, it } from 'vitest'
import {
  detectChange,
  isPlausiblePrice,
  medianPrice,
  type Observation,
  type SnapshotState,
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
      stockChange: null,
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

  it('reports stock changes separately from price changes', () => {
    const inStock = snap(1, 10000)
    const soldOut = detectChange(inStock, inStock, obs(null, 'out_of_stock'))
    expect(soldOut).toMatchObject({
      action: 'insert',
      priceChange: null,
      stockChange: {
        kind: 'out_of_stock',
        previousAvailability: 'in_stock',
        fromSnapshotId: 1,
      },
    })

    // Back in stock at a lower price: both a stock and a price event, the
    // price compared with the last snapshot that had one.
    const outOfStock = snap(2, null, 'out_of_stock')
    const back = detectChange(outOfStock, inStock, obs(8000, 'limited'))
    expect(back.stockChange).toMatchObject({
      kind: 'back_in_stock',
      availability: 'limited',
      fromSnapshotId: 2,
    })
    expect(back.priceChange).toMatchObject({
      direction: 'drop',
      previousPriceMinor: 10000,
      fromSnapshotId: 1,
    })
  })

  it('does not report back in stock for an unknown status', () => {
    const outOfStock = snap(2, null, 'out_of_stock')
    expect(
      detectChange(outOfStock, null, obs(null, 'unknown')).stockChange,
    ).toBeNull()
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
