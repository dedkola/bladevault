import { describe, expect, it } from 'vitest'
import {
  getImageUrl,
  getKnifeSearchableText,
  matchesKnifeSearch,
  prioritizePinnedKnives,
} from '@/lib/data'
import { createKnife } from '@/tests/fixtures/knife'

describe('collection data helpers', () => {
  it('searches built-in, spec, description, and custom-field values', () => {
    const knife = createKnife({
      customFields: { acquiredFrom: 'Collector Expo' },
    })

    for (const query of ['bench', 's30v', 'everyday', 'collector expo']) {
      expect(matchesKnifeSearch(knife, query)).toBe(true)
    }
    expect(matchesKnifeSearch(knife, 'fixed blade')).toBe(false)
    expect(matchesKnifeSearch(knife, '   ')).toBe(true)
  })

  it('builds a lowercased searchable text without cross-field false matches', () => {
    const knife = createKnife({
      brand: 'Benchmade',
      name: 'Bugout',
      customFields: { acquiredFrom: 'Collector Expo' },
    })

    const text = getKnifeSearchableText(knife)

    expect(text).toContain('benchmade')
    expect(text).toContain('bugout')
    expect(text).toContain('collector expo')
    expect(text).not.toContain('benchmadebugout')
  })

  it('moves pinned knives first stably without mutating the source array', () => {
    const knives = [
      createKnife({ id: 'a', pinned: false }),
      createKnife({ id: 'b', pinned: true }),
      createKnife({ id: 'c', pinned: true }),
    ]

    expect(
      prioritizePinnedKnives(knives, true).map((knife) => knife.id),
    ).toEqual(['b', 'c', 'a'])
    expect(knives.map((knife) => knife.id)).toEqual(['a', 'b', 'c'])
  })

  it('keeps external and data images intact and maps stored images to the API', () => {
    expect(getImageUrl('knife/image-01.webp')).toBe(
      '/api/images/knife/image-01.webp',
    )
    expect(getImageUrl('https://cdn.example.com/knife.webp')).toBe(
      'https://cdn.example.com/knife.webp',
    )
    expect(getImageUrl('data:image/png;base64,AA==')).toBe(
      'data:image/png;base64,AA==',
    )
  })
})
