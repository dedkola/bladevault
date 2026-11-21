import { describe, expect, it } from 'vitest'
import {
  buildSearchQueries,
  buildSearchQuery,
  modelNumberCodes,
  pageShowsModelNumber,
  parseMatchAnswer,
  parseVerifyAnswer,
  type MatchCandidate,
} from '@/lib/price-monitor/discovery-ai'
import { nextDiscoveryAttempt } from '@/lib/price-monitor/discovery-store'
import {
  DEFAULT_PRICE_MONITORING,
  normalizePriceMonitoring,
} from '@/lib/settings-shared'

describe('Other stores search', () => {
  it('tries the search with and then without the model number', () => {
    expect(
      buildSearchQueries({
        brand: 'Kizer',
        name: 'Drop Bear',
        modelNumber: 'V3619.2PR3',
      }),
    ).toEqual(['Kizer Drop Bear V3619.2PR3', 'Kizer Drop Bear'])
    expect(buildSearchQueries({ brand: 'Kizer', name: 'Drop Bear' })).toEqual([
      'Kizer Drop Bear',
    ])
  })

  it('builds a search without repeated words', () => {
    expect(
      buildSearchQuery({
        brand: 'Spyderco',
        name: 'Spyderco Para 3',
        modelNumber: 'C223GP',
      }),
    ).toBe('Spyderco Para 3 C223GP')
  })
})

describe('Other stores model number check', () => {
  it('reads one or more maker codes and ignores names', () => {
    expect(modelNumberCodes('C223GP / C223GPBK')).toEqual([
      'C223GP',
      'C223GPBK',
    ])
    expect(modelNumberCodes('A3105')).toEqual(['A3105'])
    expect(modelNumberCodes('Para')).toEqual([])
    expect(modelNumberCodes('3V')).toEqual([])
    expect(modelNumberCodes(undefined)).toEqual([])
  })

  it('needs the exact code on the page, not another variant', () => {
    const title =
      'Vosteed Porcupine ModSwap - 3.08" 154CM Blade, Micarta Handle - A3105'
    expect(pageShowsModelNumber('A3105', title)).toBe(true)
    expect(pageShowsModelNumber('A3103', title)).toBe(false)
    expect(pageShowsModelNumber('A310', title)).toBe(false)
    expect(pageShowsModelNumber('a-3105', title)).toBe(true)
    expect(pageShowsModelNumber('C223GP', 'Item model number: SP223GP')).toBe(
      false,
    )
    expect(pageShowsModelNumber('C223GP', 'Para 3 C223GPBK black')).toBe(false)
    expect(pageShowsModelNumber('V3619.2PR3', 'Drop Bear V3619.2PR3')).toBe(
      true,
    )
    // No code in the collection: nothing to compare.
    expect(pageShowsModelNumber(undefined, title)).toBe(true)
  })
})

describe('Other stores AI answers', () => {
  const candidates: MatchCandidate[] = [
    { id: 1, title: 'Knife Sharpener for Pocket Knives', price: '$19.99' },
    {
      id: 2,
      title: 'Spyderco Para 3 Lightweight Folding Knife, CTS BD1N, Black FRN',
      price: '$124.95',
    },
  ]

  it('accepts a listed result only when AI is sure', () => {
    expect(
      parseMatchAnswer(
        { match: 2, confidence: 0.9, reason: 'Same' },
        candidates,
      ).candidate?.title,
    ).toBe('Spyderco Para 3 Lightweight Folding Knife, CTS BD1N, Black FRN')
    expect(
      parseMatchAnswer({ match: '2', confidence: 0.6 }, candidates).candidate,
    ).toBeNull()
    expect(
      parseMatchAnswer({ match: 7, confidence: 1 }, candidates).candidate,
    ).toBeNull()
    expect(
      parseMatchAnswer({ match: null, confidence: 0.95 }, candidates).accepted,
    ).toBe(false)
    expect(parseMatchAnswer('nonsense', candidates).accepted).toBe(false)
  })

  it('needs an explicit, confident yes on the product page', () => {
    expect(
      parseVerifyAnswer({ same_product: true, confidence: 0.8 }).accepted,
    ).toBe(true)
    expect(
      parseVerifyAnswer({ same_product: 'true', confidence: 0.99 }).accepted,
    ).toBe(false)
    expect(
      parseVerifyAnswer({ same_product: true, confidence: 0.5 }).accepted,
    ).toBe(false)
  })
})

describe('Other stores scheduling and settings', () => {
  const now = Date.parse('2026-11-18T12:00:00Z')
  const hoursLater = (iso: string | null) =>
    iso === null ? null : (Date.parse(iso) - now) / 3_600_000

  it('never searches again for found knives and backs off failures', () => {
    expect(nextDiscoveryAttempt('found', 1, now)).toBeNull()
    expect(hoursLater(nextDiscoveryAttempt('not_found', 1, now))).toBe(720)
    expect(hoursLater(nextDiscoveryAttempt('blocked', 1, now))).toBe(12)
    expect(hoursLater(nextDiscoveryAttempt('failed', 1, now))).toBe(6)
    expect(hoursLater(nextDiscoveryAttempt('failed', 3, now))).toBe(24)
    expect(hoursLater(nextDiscoveryAttempt('failed', 9, now))).toBe(168)
  })

  it('is off by default and searches Blade HQ only', () => {
    expect(DEFAULT_PRICE_MONITORING.otherStores).toEqual({
      enabled: false,
      stores: { bladehq: true },
    })
    const next = normalizePriceMonitoring({
      otherStores: { enabled: true, stores: { ebay: true } },
    })
    expect(next.otherStores).toEqual({
      enabled: true,
      stores: { bladehq: true },
    })
  })

  it('loads settings saved while Amazon was offered, without Amazon', () => {
    const saved = normalizePriceMonitoring({
      pacing: { minGapSeconds: 90, amazonMinGapSeconds: 600 },
      otherStores: {
        enabled: true,
        stores: { amazon: true, bladehq: false },
        amazonMarketplace: 'amazon.de',
        amazonPostcode: '10115',
      },
    })
    expect(saved.pacing).toEqual({ minGapSeconds: 90 })
    expect(saved.otherStores).toEqual({
      enabled: true,
      stores: { bladehq: false },
    })
  })
})
