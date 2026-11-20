import { describe, expect, it } from 'vitest'
import { buildChipFilterFields } from '@/lib/chip-filter-fields'
import {
  getCollectionColumns,
  sortKnivesByColumn,
} from '@/lib/collection-columns'
import {
  countMarketConditions,
  marketLabel,
  marketTone,
  matchesMarketFilter,
  toMarketSummaryMap,
  type KnifeMarketSummary,
} from '@/lib/market-status'
import { getVisibleCardFields } from '@/lib/card-fields'
import { normalizeCardFields } from '@/lib/settings-shared'
import { collectionQuery, matchesCollection } from '@/lib/smart-collections'
import { createKnife } from '@/tests/fixtures/knife'

function summary(
  overrides: Partial<KnifeMarketSummary> = {},
): KnifeMarketSummary {
  return {
    monitored: true,
    sources: 1,
    bestPriceMinor: 9900,
    currency: 'USD',
    paidMinor: 12900,
    outOfStock: false,
    outOfStockSince: null,
    droppedAt: null,
    dropPct: null,
    restockedAt: null,
    lastCheckedAt: '2026-11-18T10:00:00.000Z',
    ...overrides,
  }
}

const dropped = summary({
  bestPriceMinor: 8900,
  droppedAt: '2026-11-17T10:00:00.000Z',
  dropPct: -12.4,
})
const restocked = summary({
  bestPriceMinor: 15000,
  restockedAt: '2026-11-18T10:00:00.000Z',
})
const soldOut = summary({
  bestPriceMinor: null,
  currency: null,
  paidMinor: null,
  outOfStock: true,
  outOfStockSince: '2026-11-01T10:00:00.000Z',
})
const paused = summary({ monitored: false, paidMinor: null })

describe('market conditions', () => {
  it('matches each condition and treats several as any-of', () => {
    expect(matchesMarketFilter(dropped, ['dropped'])).toBe(true)
    expect(matchesMarketFilter(dropped, ['below_paid'])).toBe(true)
    expect(matchesMarketFilter(restocked, ['below_paid'])).toBe(false)
    expect(matchesMarketFilter(restocked, ['restocked'])).toBe(true)
    expect(matchesMarketFilter(soldOut, ['out_of_stock'])).toBe(true)
    // Out of stock is never "below regular price", even with an old price.
    expect(
      matchesMarketFilter({ ...soldOut, bestPriceMinor: 100, paidMinor: 900 }, [
        'below_paid',
      ]),
    ).toBe(false)
    expect(matchesMarketFilter(paused, ['monitored'])).toBe(false)
    expect(matchesMarketFilter(paused, ['not_monitored'])).toBe(true)
    // A knife without store links is simply not monitored.
    expect(matchesMarketFilter(undefined, ['not_monitored'])).toBe(true)
    expect(matchesMarketFilter(undefined, ['dropped'])).toBe(false)
    expect(matchesMarketFilter(restocked, ['dropped', 'restocked'])).toBe(true)
    expect(matchesMarketFilter(undefined, [])).toBe(true)
  })

  it('labels the leading state for cards and cells', () => {
    expect(marketLabel(dropped)).toBe('$89.00 · ↓ 12% · Below regular')
    expect(marketTone(dropped)).toBe('dropped')
    expect(marketLabel(restocked)).toBe('$150.00 · Back in stock')
    expect(marketTone(restocked)).toBe('restocked')
    expect(marketLabel(soldOut)).toBe('Out of stock')
    expect(marketTone(soldOut)).toBe('out_of_stock')
    expect(marketLabel(summary())).toBe('$99.00 · Below regular')
    expect(marketTone(summary())).toBe('below_paid')
    expect(marketLabel(paused)).toBe('$99.00')
    expect(marketTone(paused)).toBe('steady')
    expect(marketLabel(summary({ dropPct: -5.25, droppedAt: 'x' }))).toBe(
      '$99.00 · ↓ 5.3% · Below regular',
    )
    expect(marketLabel(undefined)).toBe('')
    expect(marketTone(summary({ bestPriceMinor: null }))).toBe('none')
  })

  it('counts conditions and ignores malformed API entries', () => {
    const map = toMarketSummaryMap({ a: dropped, b: soldOut, c: null })
    expect([...map.keys()]).toEqual(['a', 'b'])
    expect(toMarketSummaryMap([dropped]).size).toBe(0)
    expect(countMarketConditions(['a', 'b', 'z'], map)).toEqual({
      dropped: 1,
      restocked: 0,
      out_of_stock: 1,
      below_paid: 1,
      monitored: 2,
      not_monitored: 1,
    })
  })
})

describe('market filters in collections', () => {
  const knifeA = createKnife({ id: 'a', name: 'A', brand: 'Spyderco' })
  const knifeB = createKnife({ id: 'b', name: 'B', brand: 'Spyderco' })
  const knifeC = createKnife({ id: 'c', name: 'C', brand: 'Benchmade' })
  const map = toMarketSummaryMap({ a: dropped, b: soldOut })

  it('saves market conditions with a smart collection query', () => {
    expect(
      collectionQuery(
        new URLSearchParams('market=dropped&smart=1&brand=Spyderco&view=x'),
      ),
    ).toBe('brand=Spyderco&market=dropped')
  })

  it('combines the market condition with other filters', () => {
    const params = new URLSearchParams('brand=Spyderco&market=out_of_stock')
    expect(
      [knifeA, knifeB, knifeC]
        .filter((knife) => matchesCollection(knife, params, undefined, map))
        .map((knife) => knife.id),
    ).toEqual(['b'])
    // Saved collections without market rules behave as before.
    expect(
      [knifeA, knifeB, knifeC].filter((knife) =>
        matchesCollection(
          knife,
          new URLSearchParams('brand=Spyderco'),
          undefined,
          map,
        ),
      ),
    ).toHaveLength(2)
    // Unknown values are ignored rather than matching nothing.
    expect(
      matchesCollection(
        knifeC,
        new URLSearchParams('market=never'),
        undefined,
        map,
      ),
    ).toBe(true)
  })

  it('offers a Market chip field only with market data', () => {
    const knives = [knifeA, knifeB, knifeC]
    expect(
      buildChipFilterFields(knives, []).some((field) => field.key === 'market'),
    ).toBe(false)
    const market = buildChipFilterFields(knives, [], undefined, map).find(
      (field) => field.key === 'market',
    )
    expect(
      market?.options.map((option) => [option.value, option.count]),
    ).toEqual([
      ['dropped', 1],
      ['restocked', 0],
      ['out_of_stock', 1],
      ['below_paid', 1],
      ['monitored', 2],
      ['not_monitored', 1],
    ])
  })

  it('offers a sortable Market column only with market data', () => {
    expect(getCollectionColumns([]).some((c) => c.key === 'market')).toBe(false)
    const columns = getCollectionColumns([], 'in', undefined, map)
    const column = columns.find((item) => item.key === 'market')
    expect(column?.getValue(knifeA)).toBe('$89.00 · ↓ 12% · Below regular')
    expect(column?.getValue(knifeC)).toBe('')
    expect(
      sortKnivesByColumn(
        [knifeC, knifeB, knifeA],
        { key: 'market', direction: 'asc' },
        columns,
      ).map((knife) => knife.id),
    ).toEqual(['a', 'b', 'c'])
  })

  it('keeps the Market price card field and never prints it as text', () => {
    expect(normalizeCardFields(['market', 'bladeStyle'])).toEqual([
      'market',
      'bladeStyle',
    ])
    expect(
      getVisibleCardFields(knifeA, ['market'], []).map((field) => field.key),
    ).toEqual([])
  })
})
