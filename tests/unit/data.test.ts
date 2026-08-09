import { describe, expect, it } from 'vitest'
import {
  getImageUrl,
  getKnifeSearchableText,
  matchesKnifeSearch,
  prioritizePinnedKnives,
} from '@/lib/data'
import { createKnife } from '@/tests/fixtures/knife'

describe('collection data helpers', () => {
  it('searches across name, brand, specs, description and custom fields', () => {
    const porcupine = createKnife({
      name: 'Porcupine',
      brand: 'Raccoon Knives',
      description: 'Raccoon-inspired design',
      specs: {
        ...createKnife().specs,
        modelNumber: 'RP-01',
      },
      customFields: { nickname: 'Spiky' },
    })
    const raccoon = createKnife({ name: 'Raccoon' })

    expect(matchesKnifeSearch(porcupine, 'porcupine')).toBe(true)
    expect(matchesKnifeSearch(porcupine, '  PORC  ')).toBe(true)
    expect(matchesKnifeSearch(porcupine, 'raccoon knives')).toBe(true)
    expect(matchesKnifeSearch(porcupine, 'rp-01')).toBe(true)
    expect(matchesKnifeSearch(porcupine, 'spiky')).toBe(true)
    expect(matchesKnifeSearch(porcupine, 'inspired')).toBe(true)
    expect(matchesKnifeSearch(porcupine, 'nonexistent')).toBe(false)
    expect(matchesKnifeSearch(raccoon, 'raccoon')).toBe(true)
    expect(matchesKnifeSearch(porcupine, '   ')).toBe(true)
  })

  it('builds lowercase searchable text from multiple fields', () => {
    const knife = createKnife({
      brand: 'Benchmade',
      name: 'Bugout',
      customFields: { acquiredFrom: 'Collector Expo' },
    })

    const text = getKnifeSearchableText(knife)

    expect(text).toContain('bugout')
    expect(text).toContain('benchmade')
    expect(text).toContain('collector expo')
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
