import { describe, expect, it } from 'vitest'
import { toKnifeListItem } from '@/lib/data'
import { pickSpotlight, spotlightDateKey, spotlightPool } from '@/lib/spotlight'
import { createKnife } from '@/tests/fixtures/knife'

const photo = ['https://example.com/knife.jpg']
const knives = Array.from({ length: 20 }, (_, index) =>
  createKnife({ id: `knife-${String(index).padStart(2, '0')}`, images: photo }),
)

describe('Studio spotlight', () => {
  it('picks the same knife for the same day whatever the input order', () => {
    const pick = pickSpotlight(knives, '2026-11-17')
    expect(pick).toBeDefined()
    expect(pickSpotlight([...knives].reverse(), '2026-11-17')).toBe(pick)
    expect(pickSpotlight(knives, '2026-11-17', 0)).toBe(pick)
  })

  it('varies the pick across days and shuffle counts', () => {
    const days = Array.from({ length: 14 }, (_, index) =>
      pickSpotlight(knives, `2026-11-${String(index + 1).padStart(2, '0')}`),
    )
    expect(new Set(days.map((knife) => knife?.id)).size).toBeGreaterThan(1)
    const shuffles = Array.from({ length: 8 }, (_, nonce) =>
      pickSpotlight(knives, '2026-11-17', nonce),
    )
    expect(new Set(shuffles.map((knife) => knife?.id)).size).toBeGreaterThan(1)
  })

  it('prefers unsold knives with photos', () => {
    const mixed = [
      createKnife({ id: 'sold', sold: true, images: photo }),
      createKnife({ id: 'no-photo', images: [] }),
      createKnife({ id: 'eligible', images: photo }),
    ]
    expect(spotlightPool(mixed).map(({ id }) => id)).toEqual(['eligible'])
    for (let nonce = 0; nonce < 10; nonce += 1) {
      expect(pickSpotlight(mixed, '2026-11-17', nonce)?.id).toBe('eligible')
    }
  })

  it('counts photos from collection summaries', () => {
    const summary = toKnifeListItem(
      createKnife({ id: 'summary', images: ['a.jpg', 'b.jpg'] }),
    )
    const trimmed = { ...summary, images: [] }
    expect(spotlightPool([trimmed]).map(({ id }) => id)).toEqual(['summary'])
    expect(
      spotlightPool([trimmed, createKnife({ id: 'bare', images: [] })]).map(
        ({ id }) => id,
      ),
    ).toEqual(['summary'])
  })

  it('falls back to unsold knives without photos, then to sold ones', () => {
    const noPhotos = [
      createKnife({ id: 'b', images: [] }),
      createKnife({ id: 'a', sold: true, images: photo }),
    ]
    expect(spotlightPool(noPhotos).map(({ id }) => id)).toEqual(['b'])
    const allSold = [
      createKnife({ id: 'b', sold: true }),
      createKnife({ id: 'a', sold: true }),
    ]
    expect(spotlightPool(allSold).map(({ id }) => id)).toEqual(['a', 'b'])
    expect(pickSpotlight(allSold, '2026-11-17')).toBeDefined()
  })

  it('returns nothing for an empty collection', () => {
    expect(spotlightPool([])).toEqual([])
    expect(pickSpotlight([], '2026-11-17')).toBeUndefined()
  })

  it('keys the day by local time', () => {
    expect(spotlightDateKey(new Date(2026, 10, 17, 23, 59))).toBe('2026-11-17')
    expect(spotlightDateKey(new Date(2026, 10, 18, 0, 1))).toBe('2026-11-18')
    expect(spotlightDateKey(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})
