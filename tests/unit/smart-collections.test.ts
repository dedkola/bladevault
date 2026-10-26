import { describe, expect, it } from 'vitest'
import {
  collectionQuery,
  matchesCollection,
  rangeError,
} from '@/lib/smart-collections'
import { createKnife } from '@/tests/fixtures/knife'

const base = createKnife()
const knife = (bladeLength: string, weight = '99 g') =>
  createKnife({ specs: { ...base.specs, bladeLength, weight } })
describe('smart collection rules', () => {
  it('combines categorical OR choices with search, custom fields, and ranges using AND', () => {
    const params = new URLSearchParams(
      'brand=Benchmade&brand=Spyderco&q=bug&custom:usage=EDC&bladeLengthMax=90&weightMax=100',
    )
    expect(
      matchesCollection(
        createKnife({ customFields: { usage: 'EDC' } }),
        params,
      ),
    ).toBe(true)
    expect(
      matchesCollection(
        createKnife({ brand: 'Other', customFields: { usage: 'EDC' } }),
        params,
      ),
    ).toBe(false)
    expect(matchesCollection(createKnife(), params)).toBe(false)
  })
  it('keeps type scopes explicit even when no matching lock values exist', () => {
    const fixed = new URLSearchParams('knifeType=fixed')
    const folding = new URLSearchParams('knifeType=folding')
    for (const lock of ['Fix', 'Fixed Blade', 'fixed']) {
      const record = createKnife({
        specs: { ...base.specs, lockingMechanism: lock },
      })
      expect(matchesCollection(record, fixed)).toBe(true)
      expect(matchesCollection(record, folding)).toBe(false)
    }
    for (const lock of ['Crossbar Lock', 'Slip Joint', 'Frame Lock']) {
      const record = createKnife({
        specs: { ...base.specs, lockingMechanism: lock },
      })
      expect(matchesCollection(record, fixed)).toBe(false)
      expect(matchesCollection(record, folding)).toBe(true)
    }
    for (const lock of ['', 'Unknown']) {
      const record = createKnife({
        specs: { ...base.specs, lockingMechanism: lock },
      })
      expect(matchesCollection(record, fixed)).toBe(false)
      expect(matchesCollection(record, folding)).toBe(false)
    }
    expect(
      collectionQuery(new URLSearchParams('knifeType=fixed&view=knives')),
    ).toBe('knifeType=fixed')
    expect(
      matchesCollection(
        base,
        new URLSearchParams('knifeType=folding&brand=Other'),
      ),
    ).toBe(false)
  })
  it('uses inclusive minima and exclusive maxima across units', () => {
    const params = new URLSearchParams(
      'bladeLengthMin=70&bladeLengthMax=80&weightMax=100',
    )
    for (const value of ['70 mm', '7.5 cm', '3 in', '3″ / 76.2 mm', '7,5 cm'])
      expect(matchesCollection(knife(value), params)).toBe(true)
    for (const value of ['80 mm', '69 mm', '', 'unknown', '75'])
      expect(matchesCollection(knife(value), params)).toBe(false)
    expect(matchesCollection(knife('75 mm', '100 g'), params)).toBe(false)
    expect(matchesCollection(knife('75 mm', '3.53 oz / 100 g'), params)).toBe(
      false,
    )
    expect(matchesCollection(knife('75 mm', '3 oz'), params)).toBe(true)
    expect(matchesCollection(knife('75 mm', ''), params)).toBe(false)
  })
  it('matches any blank specification and explicit not-set choices', () => {
    expect(matchesCollection(base, new URLSearchParams('missingSpecs=1'))).toBe(
      true,
    )
    expect(
      matchesCollection(base, new URLSearchParams('designer=__not_set__')),
    ).toBe(true)
    const complete = createKnife({
      specs: Object.fromEntries(
        Object.keys(base.specs).map((key) => [key, 'recorded']),
      ) as typeof base.specs,
    })
    expect(
      matchesCollection(complete, new URLSearchParams('missingSpecs=1')),
    ).toBe(false)
  })
  it('rejects invalid bounds and removes navigation state from saved criteria', () => {
    for (const query of [
      'weightMin=-1',
      'weightMax=NaN',
      'bladeLengthMin=80&bladeLengthMax=80',
      'weightMax=',
    ])
      expect(rangeError(new URLSearchParams(query))).toBeTruthy()
    expect(
      collectionQuery(
        new URLSearchParams(
          'view=families&smart=abc&brand=A&sort=name&weightMax=100',
        ),
      ),
    ).toBe('brand=A&weightMax=100')
  })
})
