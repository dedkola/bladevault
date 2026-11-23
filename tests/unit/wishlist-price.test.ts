import { describe, expect, it } from 'vitest'
import {
  priceChange,
  rangePosition,
  trendChange,
  wishlistDeal,
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
