import { describe, expect, it } from 'vitest'
import { withRegularStart, type WishlistTrend } from '@/lib/wishlist'

const DAY = 86_400_000
const trend = (prices: Array<number | null>): WishlistTrend => ({
  currency: 'USD',
  daily: [],
  steps: prices.map((price, index) => ({ at: index * DAY, price })),
  since: 0,
  until: 2 * DAY,
  lowMinor: null,
  highMinor: null,
})

describe('withRegularStart', () => {
  it('leads with the regular price when the store was first seen on sale', () => {
    const sale = trend([9804])
    const { steps, since, lead } = withRegularStart(sale, 12900)
    expect(lead).toEqual({ at: since, price: 12900 })
    expect(steps).toEqual([lead, ...sale.steps])
    // The lead holds 15% of the whole chart width.
    expect((sale.since - since) / (sale.until - since)).toBeCloseTo(0.15)
  })

  it('leads past out-of-stock readings to the first price', () => {
    const { lead } = withRegularStart(trend([null, 9804]), 12900)
    expect(lead?.price).toBe(12900)
  })

  it('adds nothing when the first reading is the regular price', () => {
    const giantMouse = trend([16500, 13200])
    expect(withRegularStart(giantMouse, 16500)).toEqual({
      steps: giantMouse.steps,
      since: giantMouse.since,
      lead: null,
    })
  })

  it('adds nothing within half a percent of the regular price', () => {
    expect(withRegularStart(trend([12850]), 12900).lead).toBeNull()
  })

  it('adds nothing without a regular price or an in-stock reading', () => {
    expect(withRegularStart(trend([9804]), null).lead).toBeNull()
    expect(withRegularStart(trend([9804]), 0).lead).toBeNull()
    expect(withRegularStart(trend([null]), 12900).lead).toBeNull()
  })
})
