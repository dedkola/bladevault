import { describe, expect, it } from 'vitest'
import type { KnifeStoreEntry } from '@/lib/price-monitor/shared'
import {
  priceChange,
  rangePosition,
  trendChange,
  wishlistDeal,
  wishlistMoves,
  wishlistDayTicks,
  wishlistStorePrices,
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

  it('marks each midnight under the chart, naming the month first', () => {
    const since = new Date(2026, 10, 23, 14).getTime()
    const until = new Date(2026, 10, 28, 9).getTime()
    const ticks = wishlistDayTicks({ since, until })
    expect(ticks.map((tick) => new Date(tick.at).getDate())).toEqual([
      24, 25, 26, 27, 28,
    ])
    expect(ticks[0].label).toMatch(/24/)
    expect(ticks[0].label).not.toBe('24')
    expect(ticks.slice(1).map((tick) => tick.label)).toEqual([
      '25',
      '26',
      '27',
      '28',
    ])
    for (const tick of ticks) {
      expect(tick.left).toBeGreaterThan(0)
      expect(tick.left).toBeLessThanOrEqual(100)
    }
  })

  it('thins long windows to eight marks and names a new month', () => {
    const since = new Date(2026, 9, 29, 12).getTime()
    const until = new Date(2026, 10, 28, 12).getTime()
    const ticks = wishlistDayTicks({ since, until })
    expect(ticks.length).toBeLessThanOrEqual(8)
    expect(wishlistDayTicks({ since: until, until })).toEqual([])
    const first = wishlistDayTicks({
      since: new Date(2026, 10, 29, 12).getTime(),
      until: new Date(2026, 11, 2, 12).getTime(),
    })
    expect(first.map((tick) => tick.label.length > 2)).toEqual([
      true,
      true,
      false,
    ])
  })
})

describe('wishlist store prices', () => {
  const entry = (
    label: string,
    source: Partial<NonNullable<KnifeStoreEntry['source']>> | null,
    state: KnifeStoreEntry['state'] = 'listed',
  ): KnifeStoreEntry => ({
    laneKey: label.toLowerCase(),
    label,
    state,
    source: source && {
      id: 1,
      url: `https://${label.toLowerCase()}.example.com/knife`,
      status: 'ok',
      priceMinor: 10000,
      currency: 'USD',
      availability: 'in_stock',
      enabled: true,
      ...source,
    },
    variants: [],
    detail: null,
    search: null,
  })

  it('lists in-stock stores in the currency, cheapest first', () => {
    const prices = wishlistStorePrices(
      [
        entry('Amazon', { priceMinor: 13999 }),
        entry('Blade HQ', { priceMinor: 12200 }),
        entry('KnifeCenter', { priceMinor: 12495 }),
        entry('Atlas', { priceMinor: 12200 }),
      ],
      'USD',
    )
    expect(prices.map((price) => [price.label, price.priceMinor])).toEqual([
      ['Atlas', 12200],
      ['Blade HQ', 12200],
      ['KnifeCenter', 12495],
      ['Amazon', 13999],
    ])
    expect(prices[0].url).toBe('https://atlas.example.com/knife')
  })

  it('leaves out stores that are not selling it now', () => {
    const prices = wishlistStorePrices(
      [
        entry('Out', { availability: 'out_of_stock' }),
        entry('Paused', { enabled: false }),
        entry('No price', { priceMinor: null }),
        entry('Euro', { currency: 'EUR' }),
        entry('Variant', null, 'variant'),
        entry('Searched', null, 'not_sold'),
        entry('Unknown stock', { availability: null }),
      ],
      'USD',
    )
    expect(prices.map((price) => price.label)).toEqual(['Unknown stock'])
    expect(wishlistStorePrices(undefined, 'USD')).toEqual([])
    expect(wishlistStorePrices([entry('Blade HQ', {})], null)).toEqual([])
  })
})
