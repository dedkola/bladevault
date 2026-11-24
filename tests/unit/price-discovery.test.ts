import { describe, expect, it } from 'vitest'
import {
  buildSearchQueries,
  buildSearchQuery,
  judgeProductPage,
  modelNumberCodes,
  pageShowsModelNumber,
  parseMatchAnswer,
  parseVerifyAnswer,
  resultsShowingModelNumber,
  type MatchCandidate,
  type VerifyDecision,
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

  it('reads what the page sells and whether it is the same model', () => {
    expect(
      parseVerifyAnswer({
        same_product: false,
        same_model: true,
        kind: 'knife',
        confidence: 0.9,
      }),
    ).toMatchObject({ accepted: false, kind: 'knife', sameModel: true })
    expect(
      parseVerifyAnswer({ same_product: true, kind: 'sword', confidence: 1 }),
    ).toMatchObject({ kind: null, sameModel: false })
  })

  it('keeps only listed, distinct variants other than the match, five at most', () => {
    const many: MatchCandidate[] = Array.from({ length: 8 }, (_, index) => ({
      id: index + 1,
      title: `Vosteed Porcupine A48${index}`,
      price: null,
    }))
    const answer = parseMatchAnswer(
      { match: 1, variants: [1, 2, '3', 3, 99, 4, 5, 6, 7], confidence: 0.9 },
      many,
    )
    expect(answer.candidate?.id).toBe(1)
    expect(answer.variants.map((item) => item.id)).toEqual([2, 3, 4, 5, 6])
    expect(parseMatchAnswer({ match: null }, many).variants).toEqual([])
  })
})

describe('Other stores product page decision', () => {
  const verdict = (patch: Partial<VerifyDecision>): VerifyDecision => ({
    accepted: false,
    confidence: 0.9,
    reason: '',
    kind: 'knife',
    sameModel: false,
    ...patch,
  })
  const raccoon = { brand: 'Vosteed', name: 'Raccoon', modelNumber: 'A2918' }

  it('lets the exact model number win over AI’s doubts about specs', () => {
    expect(
      judgeProductPage(raccoon, 'Vosteed Raccoon Bowie A2918', verdict({})),
    ).toBe('match')
  })

  it('never takes an accessory or bundle, even with the model number', () => {
    for (const kind of ['accessory', 'bundle', 'other'] as const)
      expect(
        judgeProductPage(
          raccoon,
          'Sheath for Raccoon A2918',
          verdict({ kind, accepted: true }),
        ),
      ).toBe('other')
  })

  it('needs AI’s yes when an older answer does not say what the page sells', () => {
    expect(judgeProductPage(raccoon, 'A2918', verdict({ kind: null }))).toBe(
      'other',
    )
    expect(
      judgeProductPage(
        raccoon,
        'A2918',
        verdict({ kind: null, accepted: true }),
      ),
    ).toBe('match')
  })

  it('calls another code of the same model a variant', () => {
    expect(
      judgeProductPage(
        raccoon,
        'Vosteed Raccoon A2922',
        verdict({ accepted: true, sameModel: true }),
      ),
    ).toBe('variant')
    expect(
      judgeProductPage(raccoon, 'Vosteed Thunderbird A3101', verdict({})),
    ).toBe('other')
  })

  it('leaves knives without a model number to AI', () => {
    const plain = { brand: 'Spyderco', name: 'Para 3' }
    expect(judgeProductPage(plain, 'Para 3', verdict({ accepted: true }))).toBe(
      'match',
    )
    expect(judgeProductPage(plain, 'Para 3', verdict({}))).toBe('other')
    expect(
      judgeProductPage(
        plain,
        'Para 3 Lightweight',
        verdict({ sameModel: true }),
      ),
    ).toBe('variant')
  })

  it('finds results whose title shows the exact model number', () => {
    const results: MatchCandidate[] = [
      { id: 1, title: 'Vosteed Raccoon A2922', price: null },
      { id: 2, title: 'Vosteed Raccoon Bowie A2918', price: null },
    ]
    expect(resultsShowingModelNumber(raccoon, results)).toEqual([results[1]])
    expect(
      resultsShowingModelNumber({ brand: 'Spyderco', name: 'Para 3' }, results),
    ).toEqual([])
  })
})

describe('Other stores scheduling and settings', () => {
  const now = Date.parse('2026-11-18T12:00:00Z')
  const hoursLater = (iso: string | null) =>
    iso === null ? null : (Date.parse(iso) - now) / 3_600_000

  it('never searches again for found knives, retries misses daily and backs off failures', () => {
    expect(nextDiscoveryAttempt('found', 1, now)).toBeNull()
    expect(hoursLater(nextDiscoveryAttempt('not_found', 1, now))).toBe(24)
    expect(hoursLater(nextDiscoveryAttempt('rejected', 1, now))).toBe(24)
    expect(hoursLater(nextDiscoveryAttempt('variant', 1, now))).toBe(24)
    expect(hoursLater(nextDiscoveryAttempt('skipped', 1, now))).toBe(720)
    expect(hoursLater(nextDiscoveryAttempt('blocked', 1, now))).toBe(12)
    expect(hoursLater(nextDiscoveryAttempt('failed', 1, now))).toBe(6)
    expect(hoursLater(nextDiscoveryAttempt('failed', 3, now))).toBe(24)
    expect(hoursLater(nextDiscoveryAttempt('failed', 9, now))).toBe(168)
  })

  it('is off by default; Blade HQ is on and SMKW off until chosen', () => {
    expect(DEFAULT_PRICE_MONITORING.otherStores).toEqual({
      enabled: false,
      stores: {
        bladehq: true,
        smkw: false,
        dlttrading: false,
        knifejoy: false,
        northwestknives: false,
        amazon: false,
      },
    })
    const next = normalizePriceMonitoring({
      otherStores: { enabled: true, stores: { ebay: true } },
    })
    expect(next.otherStores).toEqual({
      enabled: true,
      stores: {
        bladehq: true,
        smkw: false,
        dlttrading: false,
        knifejoy: false,
        northwestknives: false,
        amazon: false,
      },
    })
  })

  it('loads settings saved by an older Amazon search, keeping its switch', () => {
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
      stores: {
        bladehq: false,
        smkw: false,
        dlttrading: false,
        knifejoy: false,
        northwestknives: false,
        amazon: true,
      },
    })
  })
})
