import { describe, expect, it } from 'vitest'
import {
  planNewStoreEvent,
  type OtherStoreReading,
} from '@/lib/price-monitor/new-store'

function other(
  sourceId: number,
  priceMinor: number | null,
  availability: OtherStoreReading['availability'] = 'in_stock',
  currency: string | null = 'USD',
): OtherStoreReading {
  return {
    sourceId,
    snapshotId: sourceId * 10,
    priceMinor,
    currency,
    availability,
  }
}

const reading = (
  priceMinor: number | null,
  availability: OtherStoreReading['availability'] = 'in_stock',
  currency = 'USD',
) => ({ priceMinor, currency, availability })

describe('planNewStoreEvent', () => {
  it('is a drop when the new store undercuts every store selling the knife', () => {
    // Kershaw Steppe: kaiusa.com at 61.59, Blade HQ found at 48.95.
    expect(planNewStoreEvent(reading(4895), [other(15, 6159)])).toEqual({
      kind: 'drop',
      previous: other(15, 6159),
      deltaMinor: -1264,
      deltaPct: -20.52,
    })
    // Measured against the cheapest store that sells it.
    expect(
      planNewStoreEvent(reading(5000), [
        other(1, 7000),
        other(2, 5500),
        other(3, 4000, 'out_of_stock'),
      ]),
    ).toMatchObject({
      kind: 'drop',
      previous: { sourceId: 2 },
      deltaMinor: -500,
    })
  })

  it('is no event when the new store is not cheaper or the currency differs', () => {
    expect(planNewStoreEvent(reading(6159), [other(15, 6159)])).toBeNull()
    expect(planNewStoreEvent(reading(7000), [other(15, 6159)])).toBeNull()
    expect(
      planNewStoreEvent(reading(4000, 'in_stock', 'EUR'), [other(15, 6159)]),
    ).toBeNull()
  })

  it('is back in stock when every other store is out', () => {
    // Kizer Militaw: kizerknives.com out of stock, Blade HQ found in stock.
    expect(
      planNewStoreEvent(reading(6795), [other(24, 6795, 'out_of_stock')]),
    ).toEqual({
      kind: 'back_in_stock',
      previous: other(24, 6795, 'out_of_stock'),
    })
  })

  it('is nothing without other stores, or when the new store does not sell it', () => {
    expect(planNewStoreEvent(reading(4895), [])).toBeNull()
    expect(
      planNewStoreEvent(reading(4895, 'out_of_stock'), [other(15, 6159)]),
    ).toBeNull()
    expect(planNewStoreEvent(reading(null), [other(15, 6159)])).toBeNull()
    // Other stores with no price and no stock status tell nothing.
    expect(
      planNewStoreEvent(reading(4895), [other(15, null, 'unknown')]),
    ).toBeNull()
  })
})
