import { describe, expect, it } from 'vitest'
import type { Knife } from '@/lib/data'
import {
  countAddedByMonth,
  countAddedThisMonth,
  countFacet,
  filterLumenKnives,
  formatMoney,
  matchesLumenSearch,
  parsePrice,
  sortLumenKnives,
  summarizeCollectionValue,
} from '@/lib/lumen-collection'

function knife(overrides: Partial<Knife> & { id: string }): Knife {
  return {
    name: 'Knife',
    brand: 'Maker',
    bladeStyle: '',
    handleMaterial: '',
    images: [],
    specs: { weight: '', overallLength: '', bladeLength: '', country: '' },
    customFields: {},
    addedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    description: '',
    sourceUrl: '',
    pinned: false,
    sold: false,
    ...overrides,
  }
}

describe('parsePrice', () => {
  it('reads common price formats', () => {
    expect(parsePrice('$189')).toEqual({ amount: 189, currency: 'USD' })
    expect(parsePrice('$1,299.99')).toEqual({
      amount: 1299.99,
      currency: 'USD',
    })
    expect(parsePrice('1.299,00 €')).toEqual({ amount: 1299, currency: 'EUR' })
    expect(parsePrice('189,95 EUR')).toEqual({
      amount: 189.95,
      currency: 'EUR',
    })
    expect(parsePrice('£2.500')).toEqual({ amount: 2500, currency: 'GBP' })
    expect(parsePrice('240')).toEqual({ amount: 240, currency: '' })
  })

  it('returns null without an amount', () => {
    expect(parsePrice('')).toBeNull()
    expect(parsePrice(undefined)).toBeNull()
    expect(parsePrice('gift')).toBeNull()
  })
})

describe('summarizeCollectionValue', () => {
  it('sums the most common currency and skips the rest', () => {
    const value = summarizeCollectionValue([
      knife({ id: 'a', specs: { ...knife({ id: 'x' }).specs, price: '$100' } }),
      knife({
        id: 'b',
        specs: { ...knife({ id: 'x' }).specs, price: '$50.50' },
      }),
      knife({ id: 'c', specs: { ...knife({ id: 'x' }).specs, price: '€80' } }),
      knife({ id: 'd', specs: { ...knife({ id: 'x' }).specs, price: '70' } }),
    ])
    expect(value).toEqual({ total: 150.5, currency: 'USD', pricedCount: 2 })
    expect(formatMoney(150.5, 'USD')).toBe('$151')
  })

  it('returns null when nothing is priced', () => {
    expect(summarizeCollectionValue([knife({ id: 'a' })])).toBeNull()
  })
})

describe('filterLumenKnives', () => {
  const knives = [
    knife({ id: 'a', brand: 'Spyderco', pinned: true }),
    knife({ id: 'b', brand: 'Benchmade', sold: true }),
    knife({ id: 'c', brand: 'Spyderco' }),
  ]
  const ids = (query: string) =>
    filterLumenKnives(knives, new URLSearchParams(query)).map((k) => k.id)

  it('applies shared filters, the pinned view and the sold status', () => {
    expect(ids('brand=Spyderco')).toEqual(['a', 'c'])
    expect(ids('view=pinned')).toEqual(['a'])
    expect(ids('status=sold')).toEqual(['b'])
    expect(ids('status=owned&brand=Spyderco')).toEqual(['a', 'c'])
    expect(ids('smart=abc')).toEqual(['a', 'b', 'c'])
    expect(ids('q=bench')).toEqual(['b'])
  })
})

describe('matchesLumenSearch', () => {
  it('matches every word across name, brand, steel and lock', () => {
    const item = knife({
      id: 'a',
      name: 'Para 3',
      brand: 'Spyderco',
      specs: { ...knife({ id: 'x' }).specs, bladeMaterial: 'CPM S45VN' },
    })
    expect(matchesLumenSearch(item, 'spyderco s45vn')).toBe(true)
    expect(matchesLumenSearch(item, '  ')).toBe(true)
    expect(matchesLumenSearch(item, 'spyderco magnacut')).toBe(false)
  })

  it('limits field:value words to that field', () => {
    const item = knife({
      id: 'a',
      name: 'Bugout',
      brand: 'Benchmade',
      specs: {
        ...knife({ id: 'x' }).specs,
        bladeMaterial: 'CPM S30V',
        lockingMechanism: 'AXIS',
      },
    })
    expect(matchesLumenSearch(item, 'steel:s30v lock:axis')).toBe(true)
    expect(matchesLumenSearch(item, 'brand:bugout')).toBe(false)
    expect(matchesLumenSearch(item, 'steel:')).toBe(true)
    expect(matchesLumenSearch(item, 'note:axis')).toBe(false)
  })
})

describe('sortLumenKnives', () => {
  it('sorts newest first and can lift pinned knives', () => {
    const knives = [
      knife({ id: 'old', addedAt: '2026-01-01T00:00:00Z', pinned: true }),
      knife({ id: 'new', addedAt: '2026-03-01T00:00:00Z' }),
    ]
    expect(sortLumenKnives(knives, 'newest', false).map((k) => k.id)).toEqual([
      'new',
      'old',
    ])
    expect(sortLumenKnives(knives, 'newest', true).map((k) => k.id)).toEqual([
      'old',
      'new',
    ])
  })
})

describe('counts', () => {
  it('counts facets and monthly additions', () => {
    const knives = [
      knife({
        id: 'a',
        bladeStyle: 'Drop point',
        addedAt: '2026-11-02T10:00:00',
      }),
      knife({
        id: 'b',
        bladeStyle: 'Drop point',
        addedAt: '2026-10-02T10:00:00',
      }),
      knife({ id: 'c', bladeStyle: 'Tanto', addedAt: '2026-11-05T10:00:00' }),
      knife({ id: 'd', bladeStyle: ' ', addedAt: '2025-11-05T10:00:00' }),
    ]
    expect(countFacet(knives, (k) => k.bladeStyle)).toEqual([
      { value: 'Drop point', count: 2 },
      { value: 'Tanto', count: 1 },
    ])
    const now = new Date('2026-11-12T12:00:00')
    expect(countAddedThisMonth(knives, now)).toBe(2)
    expect(countAddedByMonth(knives, 2, now)).toEqual([
      { label: 'Oct', count: 1 },
      { label: 'Nov', count: 2 },
    ])
  })
})
