import { describe, expect, it } from 'vitest'
import {
  priceChange,
  rangePosition,
  trendChange,
  wishlistDeal,
  wishlistMoves,
  wishlistTrackedDays,
  wishlistTrendDirection,
} from '@/lib/wishlist'

describe('wishlist price info', () => {
  it('compares a price with a base price', () => {
    expect(priceChange(8000, 10000)).toBeCloseTo(-0.2)
    expect(priceChange(11000, 10000)).toBeCloseTo(0.1)
    expect(priceChange(null, 10000)).toBeNull()
    expect(priceChange(8000, null)).toBeNull()
    expect(priceChange(8000, 0)).toBeNull()
  })

  it('measures the change across the priced days of a trend', () => {
    const trend = {
      currency: 'USD',
      daily: [null, 10000, 9500, null, 9000],
      steps: [],
      since: 0,
      until: 0,
      lowMinor: 9000,
      highMinor: 10000,
    }
    expect(trendChange(trend)).toBeCloseTo(-0.1)
    expect(trendChange({ ...trend, daily: [null, 9000, null] })).toBeNull()
    expect(trendChange(undefined)).toBeNull()
  })

  it('places a price inside the 90-day range', () => {
    expect(rangePosition(9000, 9000, 11000)).toBe(0)
    expect(rangePosition(10000, 9000, 11000)).toBe(0.5)
    expect(rangePosition(12000, 9000, 11000)).toBe(1)
    expect(rangePosition(9000, 9000, 9000)).toBeNull()
    expect(rangePosition(null, 9000, 11000)).toBeNull()
  })

  it('groups knives by deal', () => {
    const live = { live: true, outOfStock: false }
    expect(wishlistDeal({ ...live, vsRegular: -0.2 })).toBe('sale')
    expect(wishlistDeal({ ...live, vsRegular: -0.004 })).toBe('regular')
    expect(wishlistDeal({ ...live, vsRegular: null })).toBe('regular')
    expect(wishlistDeal({ ...live, vsRegular: 0.05 })).toBe('above')
    expect(
      wishlistDeal({ live: false, outOfStock: true, vsRegular: null }),
    ).toBe('out')
    expect(
      wishlistDeal({ live: false, outOfStock: false, vsRegular: null }),
    ).toBe('unknown')
  })
})

describe('wishlist trend moves', () => {
  const trend = (
    steps: Array<{ at: number; price: number | null }>,
    since = 0,
    until = 0,
  ) => ({
    currency: 'USD',
    daily: [] as Array<number | null>,
    steps,
    since,
    until,
    lowMinor: null,
    highMinor: null,
  })

  it('reports only real changes, oldest first', () => {
    expect(
      wishlistMoves(
        trend([
          { at: 1, price: 13500 },
          { at: 2, price: 13500 },
          { at: 3, price: 9450 },
          { at: 4, price: 9500 },
        ]),
      ),
    ).toEqual([
      { at: 3, price: 9450, delta: -4050 },
      { at: 4, price: 9500, delta: 50 },
    ])
  })

  it('skips out-of-stock steps and does not treat a first price as a move', () => {
    expect(
      wishlistMoves(
        trend([
          { at: 1, price: null },
          { at: 2, price: 15150 },
        ]),
      ),
    ).toEqual([])
    expect(
      wishlistMoves(
        trend([
          { at: 1, price: 10000 },
          { at: 2, price: null },
          { at: 3, price: 9000 },
        ]),
      ),
    ).toEqual([{ at: 3, price: 9000, delta: -1000 }])
  })

  it('handles missing, empty and single-snapshot trends', () => {
    expect(wishlistMoves(undefined)).toEqual([])
    expect(wishlistMoves(trend([]))).toEqual([])
    expect(wishlistMoves(trend([{ at: 1, price: 6900 }]))).toEqual([])
  })

  it('takes the net direction from the first to the last observed price', () => {
    const moves = (prices: Array<number | null>) =>
      wishlistMoves(trend(prices.map((price, at) => ({ at, price }))))
    expect(wishlistTrendDirection(moves([13500, 9450, 9500]))).toBe('down')
    expect(wishlistTrendDirection(moves([9000, null, 9900]))).toBe('up')
    expect(wishlistTrendDirection(moves([9000, 9500, 9000]))).toBe('flat')
    expect(wishlistTrendDirection([])).toBe('flat')
  })

  it('measures the tracked window in whole days, never below one', () => {
    expect(wishlistTrackedDays({ since: 0, until: 5 * 86_400_000 })).toBe(5)
    expect(wishlistTrackedDays({ since: 0, until: 3_600_000 })).toBe(1)
    expect(wishlistTrackedDays({ since: 100, until: 100 })).toBe(1)
  })
})
