import { describe, expect, it } from 'vitest'
import {
  getImageUrl,
  getKnifeSearchableText,
  matchesKnifeSearch,
  prioritizePinnedKnives,
} from '@/lib/data'
import { createKnife } from '@/tests/fixtures/knife'

describe('collection data helpers', () => {
  it('searches only the model name', () => {
    const porcupine = createKnife({
      name: 'Porcupine',
      brand: 'Raccoon Knives',
      description: 'Raccoon-inspired design',
      specs: {
        ...createKnife().specs,
        modelNumber: 'Raccoon',
      },
      customFields: { nickname: 'Raccoon' },
    })
    const raccoon = createKnife({ name: 'Raccoon' })

    expect(matchesKnifeSearch(porcupine, 'porcupine')).toBe(true)
    expect(matchesKnifeSearch(porcupine, '  PORC  ')).toBe(true)
    expect(matchesKnifeSearch(porcupine, 'raccoon')).toBe(false)
    expect(matchesKnifeSearch(raccoon, 'raccoon')).toBe(true)
    expect(matchesKnifeSearch(porcupine, '   ')).toBe(true)
  })

  it('builds lowercase searchable text from the model name', () => {
    const knife = createKnife({
      brand: 'Benchmade',
      name: 'Bugout',
      customFields: { acquiredFrom: 'Collector Expo' },
    })

    const text = getKnifeSearchableText(knife)

    expect(text).toBe('bugout')
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
