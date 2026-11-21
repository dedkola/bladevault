import { describe, expect, it } from 'vitest'
import {
  groupByKnife,
  isBelowPaid,
  matchesQuery,
  nextSort,
  parseSection,
  SECTION_FILTER,
  sortRows,
  storeOptions,
  vsPaid,
} from '@/components/price-drops/price-table-model'
import type { MonitoredSource } from '@/lib/price-monitor/insights'

let nextId = 1
function source(overrides: Partial<MonitoredSource> = {}): MonitoredSource {
  const id = nextId++
  return {
    sourceId: id,
    knife: {
      id: `k${id}`,
      name: 'Drop Bear',
      brand: 'Kizer',
      image: null,
      subtitle: null,
    },
    storeName: 'vosteed.com',
    laneKey: 'vosteed.com',
    url: 'https://vosteed.com/p',
    status: 'ok',
    priceMinor: 10000,
    currency: 'USD',
    availability: 'in_stock',
    lastCheckedAt: '2026-11-19T10:00:00.000Z',
    lastError: null,
    since: null,
    official: false,
    stockIgnored: false,
    result: 'same',
    previousPriceMinor: null,
    deltaMinor: null,
    deltaPct: null,
    changedAt: null,
    paidMinor: null,
    nextCheckAt: null,
    restockedAt: null,
    priceSeenAt: null,
    driftPct: null,
    fluctuating: false,
    paidCurrency: null,
    retireHint: null,
    ...overrides,
  }
}

describe('price table model', () => {
  it('parses sections and filters below-paid and restocked rows', () => {
    expect(parseSection('below_paid')).toBe('drops')
    expect(parseSection('nope')).toBeNull()
    const cheaper = source({ paidMinor: 12000 })
    const gone = source({ paidMinor: 12000, result: 'out_of_stock' })
    const pricier = source({ paidMinor: 9000 })
    expect([cheaper, gone, pricier].filter(isBelowPaid)).toEqual([cheaper])
    const back = source({ result: 'restocked' })
    expect(SECTION_FILTER.restocked(back)).toBe(true)
    expect(SECTION_FILTER.changes(back)).toBe(true)
  })

  it('lists anything cheaper than its regular price as a drop', () => {
    // A store found today already selling under the regular price.
    const newStore = source({
      result: 'restocked',
      priceMinor: 8385,
      paidMinor: 12900,
    })
    const cut = source({ result: 'drop', deltaPct: -10, paidMinor: null })
    const full = source({ priceMinor: 12900, paidMinor: 12900 })
    const gone = source({
      result: 'out_of_stock',
      priceMinor: 8000,
      paidMinor: 12900,
    })
    const drops = [full, cut, gone, newStore].filter(SECTION_FILTER.drops)
    expect(drops).toEqual([cut, newStore])
    expect(sortRows('drops', drops, null)).toEqual([newStore, cut])
  })

  it('compares with the regular price in money and percent', () => {
    expect(vsPaid({ priceMinor: 9000, paidMinor: 12000 })).toEqual({
      deltaMinor: -3000,
      pct: -25,
    })
    expect(vsPaid({ priceMinor: 9000, paidMinor: null })).toBeNull()
  })

  it('searches brand, name, model and store', () => {
    const row = source({
      knife: {
        id: 'a',
        name: 'Drop Bear',
        brand: 'Kizer',
        image: null,
        subtitle: '1094A3 · M390',
      },
      storeName: 'kizerknives.com',
    })
    expect(matchesQuery(row, 'kizer 1094a3')).toBe(true)
    expect(matchesQuery(row, 'm390 kizerknives')).toBe(true)
    expect(matchesQuery(row, 'bugout')).toBe(false)
    expect(matchesQuery(row, '  ')).toBe(true)
  })

  it('lists stores by number of listings', () => {
    const rows = [
      source({ laneKey: 'a.com', storeName: 'a.com' }),
      source({ laneKey: 'b.com', storeName: 'b.com' }),
      source({ laneKey: 'b.com', storeName: 'b.com' }),
    ]
    expect(storeOptions(rows)).toEqual([
      { laneKey: 'b.com', label: 'b.com', count: 2 },
      { laneKey: 'a.com', label: 'a.com', count: 1 },
    ])
  })

  it('cycles a column sort and keeps missing values last', () => {
    expect(nextSort(null, 'price')).toEqual({ key: 'price', dir: 'asc' })
    expect(nextSort({ key: 'price', dir: 'asc' }, 'price')).toEqual({
      key: 'price',
      dir: 'desc',
    })
    expect(nextSort({ key: 'price', dir: 'desc' }, 'price')).toBeNull()
    expect(nextSort(null, 'checked')).toEqual({ key: 'checked', dir: 'desc' })

    const cheap = source({ priceMinor: 5000 })
    const none = source({ priceMinor: null })
    const dear = source({ priceMinor: 20000 })
    const ids = (list: MonitoredSource[]) => list.map((s) => s.sourceId)
    expect(
      ids(sortRows('all', [none, dear, cheap], { key: 'price', dir: 'asc' })),
    ).toEqual(ids([cheap, dear, none]))
    expect(
      ids(sortRows('all', [none, cheap, dear], { key: 'price', dir: 'desc' })),
    ).toEqual(ids([dear, cheap, none]))

    const drop = source({ result: 'drop', deltaPct: -10 })
    const same = source()
    const back = source({ result: 'restocked' })
    expect(ids(sortRows('all', [same, back, drop], null))).toEqual(
      ids([drop, back, same]),
    )
  })

  it('groups sources by knife with the cheapest in-stock one leading', () => {
    const knife = source().knife
    const a = source({ knife, priceMinor: 9000 })
    const b = source({ knife, priceMinor: 7000 })
    const c = source({ knife, priceMinor: 5000, result: 'out_of_stock' })
    const other = source()
    const groups = groupByKnife([a, other, b, c])
    expect(groups.map((g) => g.knifeId)).toEqual([knife.id, other.knife.id])
    expect(groups[0].lead).toBe(b)
    expect(groups[0].sources).toHaveLength(3)
  })
})
