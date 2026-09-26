import { describe, expect, it } from 'vitest'
import {
  getImageUrl,
  getKnifeImageCount,
  getKnifeSearchableText,
  hydrateKnifeListItem,
  isMaintenanceType,
  maintenanceTypeLabel,
  matchesGlobalKnifeSearch,
  matchesKnifeSearch,
  parseGlobalKnifeSearchQuery,
  prioritizePinnedKnives,
  toKnifeListItem,
} from '@/lib/data'
import { createKnife } from '@/tests/fixtures/knife'

describe('collection data helpers', () => {
  it('keeps detail-only text out of collection list payloads', () => {
    const knife = createKnife({
      description: 'A long private note',
      images: ['one.webp', 'two.webp', 'three.webp'],
      sourceUrl: 'https://example.com/knife',
    })

    const listItem = toKnifeListItem(knife)

    expect(listItem).not.toHaveProperty('description')
    expect(listItem).not.toHaveProperty('sourceUrl')
    expect(listItem.images).toEqual(['one.webp'])
    expect(getKnifeImageCount(listItem)).toBe(3)
    expect(hydrateKnifeListItem(listItem)).toMatchObject({
      id: knife.id,
      description: '',
      sourceUrl: '',
    })
  })

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

  it('supports explicit global model-number searches', () => {
    const matchingNumber = createKnife({
      name: 'Pyrite',
      specs: { ...createKnife().specs, modelNumber: 'A4301-B' },
    })
    const matchingNameOnly = createKnife({
      name: 'A4301',
      specs: { ...createKnife().specs, modelNumber: 'J1942' },
    })

    expect(parseGlobalKnifeSearchQuery('/model A4301')).toEqual({
      mode: 'model-number',
      value: 'A4301',
    })
    expect(parseGlobalKnifeSearchQuery('  /MODEL   a4301  ')).toEqual({
      mode: 'model-number',
      value: 'a4301',
    })
    expect(matchesGlobalKnifeSearch(matchingNumber, '/model a4301')).toBe(true)
    expect(matchesGlobalKnifeSearch(matchingNameOnly, '/model A4301')).toBe(
      false,
    )
    expect(matchesGlobalKnifeSearch(matchingNumber, 'Pyrite')).toBe(true)
    expect(matchesGlobalKnifeSearch(matchingNumber, '/model')).toBe(false)
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

  it('validates maintenance types and returns human labels', () => {
    expect(isMaintenanceType('sharpening')).toBe(true)
    expect(isMaintenanceType('invalid')).toBe(false)
    expect(maintenanceTypeLabel('cleaning')).toBe('Cleaned')
    expect(maintenanceTypeLabel('hardware_replacement')).toBe(
      'Hardware replaced',
    )
  })
})
