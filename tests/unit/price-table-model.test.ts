import { describe, expect, it } from 'vitest'
import {
  groupByKnife,
  isAbovePaid,
  isBelowPaid,
  latestCheckedAt,
  matchesQuery,
  nextSort,
  parseSection,
  RECENT_KNIVES,
  SECTION_FILTER,
  sectionRows,
  soldOutKnives,
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
    stockAlertsOff: false,
    result: 'same',
    previousPriceMinor: null,
    deltaMinor: null,
    deltaPct: null,
    changedAt: null,
    paidMinor: null,
    nextCheckAt: null,
    queued: false,
    restockedAt: null,
    priceSeenAt: null,
    driftPct: null,
    fluctuating: false,
    paidCurrency: null,
    retireHint: null,
    attention: null,
    ...overrides,
  }
}

describe('price table model', () => {
  it('parses sections and filters below-paid rows', () => {
    expect(parseSection('below_paid')).toBe('drops')
    // The removed Changed and Restocked tabs open All.
    expect(parseSection('changes')).toBe('all')
    expect(parseSection('restocked')).toBe('all')
    expect(parseSection('nope')).toBeNull()
    const cheaper = source({ paidMinor: 12000 })
    const gone = source({ paidMinor: 12000, result: 'out_of_stock' })
    const pricier = source({ paidMinor: 9000 })
    expect([cheaper, gone, pricier].filter(isBelowPaid)).toEqual([cheaper])
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

  it('lists a knife as out of stock only when no store sells it', () => {
    const knife = (id: string) => ({
      id,
      name: 'Begleiter 2.9',
      brand: 'Kizer',
      image: null,
      subtitle: null,
    })
    const out = {
      availability: 'out_of_stock',
      result: 'out_of_stock',
    } as const
    // One store still sells it: the sold-out stores do not make it sold out.
    const bladeHq = source({ knife: knife('mixed'), ...out })
    const amazon = source({ knife: knife('mixed'), availability: 'limited' })
    // Every store read is sold out; one not read yet counts neither way.
    const smkw = source({ knife: knife('gone'), ...out })
    const official = source({ knife: knife('gone'), ...out })
    const unread = source({
      knife: knife('gone'),
      availability: null,
      result: 'pending',
    })
    // Nothing read yet is not out of stock.
    const fresh = source({
      knife: knife('fresh'),
      availability: null,
      result: 'pending',
    })
    const all = [bladeHq, amazon, smkw, official, unread, fresh]

    expect(soldOutKnives(all)).toEqual(new Set(['gone']))
    expect(sectionRows('oos', all, all)).toEqual([smkw, official, unread])
    // A store filter shows fewer rows but judges the knife on every store.
    expect(sectionRows('oos', [bladeHq, smkw], all)).toEqual([smkw])
    // Another variant in stock (an Amazon listing under Other variants)
    // means the knife can still be bought.
    expect(soldOutKnives(all, ['gone'])).toEqual(new Set())
    expect(sectionRows('oos', all, all, ['gone'])).toEqual([])
  })

  it('lists anything dearer than its regular price as up', () => {
    // A store back in stock at a price far over the regular price.
    const restocked = source({
      result: 'restocked',
      priceMinor: 19995,
      paidMinor: 12855,
    })
    const raised = source({ result: 'increase', deltaPct: 10, paidMinor: null })
    const full = source({ priceMinor: 12900, paidMinor: 12900 })
    const gone = source({
      result: 'out_of_stock',
      priceMinor: 20000,
      paidMinor: 12900,
    })
    const broken = source({
      result: 'attention',
      priceMinor: 20000,
      paidMinor: 12900,
    })
    const rows = [full, raised, gone, broken, restocked]
    expect(rows.filter(isAbovePaid)).toEqual([restocked])
    expect(rows.filter(SECTION_FILTER.increases)).toEqual([raised, restocked])
  })

  it('leaves out of up a knife another store sells at its regular price', () => {
    const knife = (id: string) => ({
      id,
      name: 'Abrams',
      brand: 'Kizer',
      image: null,
      subtitle: null,
    })
    // Amazon sells it at the regular price, so dearer stores do not count.
    const official = source({
      knife: knife('abrams'),
      priceMinor: 6000,
      paidMinor: 6000,
    })
    const amazon = source({
      knife: knife('abrams'),
      priceMinor: 6000,
      paidMinor: 6000,
    })
    const smkw = source({
      knife: knife('abrams'),
      priceMinor: 6595,
      paidMinor: 6000,
    })
    const bladeHq = source({
      knife: knife('abrams'),
      result: 'increase',
      priceMinor: 6595,
      paidMinor: 6000,
    })
    // The only store at the regular price is sold out: the knife is up.
    const soldOut = source({
      knife: knife('finch'),
      result: 'out_of_stock',
      priceMinor: 6000,
      paidMinor: 6000,
    })
    const dearer = source({
      knife: knife('finch'),
      priceMinor: 6995,
      paidMinor: 6000,
    })
    // No regular price to compare with: a raise still counts.
    const raised = source({
      knife: knife('smolt'),
      result: 'increase',
      paidMinor: null,
    })
    const all = [official, amazon, smkw, bladeHq, soldOut, dearer, raised]

    expect(sectionRows('increases', all, all)).toEqual([dearer, raised])
    // A store filter shows fewer rows but judges the knife on every store.
    expect(sectionRows('increases', [smkw, dearer], all)).toEqual([dearer])
  })

  it('compares with the regular price in money and percent', () => {
    expect(vsPaid({ priceMinor: 9000, paidMinor: 12000 })).toEqual({
      deltaMinor: -3000,
      pct: -25,
    })
    expect(vsPaid({ priceMinor: 9000, paidMinor: null })).toBeNull()
  })

  it('sorts by the regular price only with a price one can buy', () => {
    // An out-of-stock listing far under regular is not a sale: it sorts
    // last, as the row chip leaves it out.
    const gone = source({
      result: 'out_of_stock',
      priceMinor: 14000,
      paidMinor: 26900,
    })
    const sale = source({ priceMinor: 12200, paidMinor: 21500 })
    const regular = source({ priceMinor: 26900, paidMinor: 26900 })
    expect(
      sortRows('all', [gone, regular, sale], { key: 'paid', dir: 'asc' }),
    ).toEqual([sale, regular, gone])
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

  it('sorts the Trend column by the 30-day move, else the latest change', () => {
    const steady = source({ deltaPct: null })
    const slid = source({ deltaPct: -2 })
    const fresh = source({ deltaPct: -5 })
    const trend = new Map([
      [steady.sourceId, -30],
      [slid.sourceId, -12],
    ])
    const ids = (list: MonitoredSource[]) => list.map((s) => s.sourceId)
    expect(
      ids(
        sortRows(
          'all',
          [fresh, slid, steady],
          { key: 'change', dir: 'asc' },
          (row) => trend.get(row.sourceId) ?? null,
        ),
      ),
    ).toEqual(ids([steady, slid, fresh]))
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

  it('leads with the knife’s best in-stock store when the tab lists only another', () => {
    const knife = source().knife
    const soldOut = source({ knife, priceMinor: 5520, result: 'out_of_stock' })
    const amazon = source({ knife, priceMinor: 4899 })
    const official = source({ knife, priceMinor: 6900 })
    const other = source()
    const pool = [official, other, amazon, soldOut]
    // A tab lists the sold-out listing alone; Out of stock skips the
    // knife, since other stores sell it.
    const tab = [soldOut]
    expect(sectionRows('oos', pool, pool)).toEqual([])
    const groups = groupByKnife(tab, pool)
    expect(groups.map((g) => g.knifeId)).toEqual([knife.id])
    expect(groups[0].lead).toBe(amazon)
    expect(groups[0].sources).toEqual([soldOut, official, amazon])
  })

  it('leads with an out-of-stock store only when no store has it', () => {
    const knife = source().knife
    const a = source({ knife, priceMinor: 5520, result: 'out_of_stock' })
    const b = source({ knife, priceMinor: 6900, result: 'out_of_stock' })
    const groups = groupByKnife([a], [a, b])
    expect(groups[0].lead.result).toBe('out_of_stock')
    expect(groups[0].sources).toEqual([a, b])
  })

  it('lists every store of the knives checked last on Recently checked', () => {
    const at = (minute: number) =>
      new Date(Date.UTC(2026, 10, 27, 20, minute)).toISOString()
    // One knife checked at five stores in a row, then one store per knife.
    const busy = source().knife
    const busyRows = [1, 2, 3, 4, 5].map((minute) =>
      source({ knife: busy, lastCheckedAt: at(59 - minute) }),
    )
    const singles = Array.from({ length: RECENT_KNIVES + 5 }, (_, index) =>
      source({ lastCheckedAt: at(50 - index) }),
    )
    const rows = sortRows('recent', [...singles, ...busyRows], null)
    const knives = groupByKnife(rows).map((group) => group.knifeId)
    expect(knives).toHaveLength(RECENT_KNIVES)
    expect(knives[0]).toBe(busy.id)
    expect(rows.slice(0, 5)).toEqual(busyRows)
    expect(knives.slice(1)).toEqual(
      singles.slice(0, RECENT_KNIVES - 1).map((row) => row.knife.id),
    )
  })

  it('takes a knife’s newest check across its stores', () => {
    const knife = source().knife
    const old = source({ knife, lastCheckedAt: '2026-11-27T10:00:00.000Z' })
    const fresh = source({ knife, lastCheckedAt: '2026-11-27T21:51:00.000Z' })
    const never = source({ knife, lastCheckedAt: null })
    expect(latestCheckedAt([old, never, fresh])).toBe(fresh.lastCheckedAt)
    expect(latestCheckedAt([never])).toBeNull()
  })
})
