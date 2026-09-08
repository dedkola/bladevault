import { describe, expect, it } from 'vitest'
import { createKnife } from '@/tests/fixtures/knife'
import { prioritizePinnedKnives } from '@/lib/data'
import {
  getKnifeFamilyKey,
  getKnifeVariantLabel,
  groupKnifeFamilies,
} from '@/lib/knife-families'

describe('model families', () => {
  it('groups matching maker and model despite case and whitespace, without changing records', () => {
    const first = createKnife({
      id: 'first',
      brand: ' Vosteed ',
      name: 'Raccoon  2.0',
    })
    const second = createKnife({
      id: 'second',
      brand: 'vosteed',
      name: 'raccoon 2.0',
    })
    const originals = structuredClone([first, second])
    const families = groupKnifeFamilies([first, second])
    expect(families).toHaveLength(1)
    expect(families[0].knives.map(({ id }) => id)).toEqual(['first', 'second'])
    expect([first, second]).toEqual(originals)
  })

  it('keeps brands, generations, sizes, and punctuation separate', () => {
    const knives = [
      createKnife({ id: 'base', brand: 'Vosteed', name: 'Raccoon' }),
      createKnife({ id: 'gen2', brand: 'Vosteed', name: 'Raccoon 2.0' }),
      createKnife({ id: 'mini', brand: 'Vosteed', name: 'Raccoon Mini' }),
      createKnife({ id: 'other', brand: 'Other', name: 'Raccoon' }),
      createKnife({ id: 'punctuation', brand: 'Vosteed', name: 'Raccoon 20' }),
    ]
    expect(groupKnifeFamilies(knives)).toHaveLength(5)
  })

  it('does not group unrelated records with missing identity fields', () => {
    const knives = [
      createKnife({ id: 'a', brand: '' }),
      createKnife({ id: 'b', brand: ' ' }),
      createKnife({ id: 'c', name: '' }),
      createKnife({ id: 'd', name: '' }),
    ]
    expect(groupKnifeFamilies(knives)).toHaveLength(4)
  })

  it('preserves incoming order and pin priority while keeping families whole', () => {
    const first = createKnife({ id: 'first', name: 'First' })
    const other = createKnife({ id: 'other', name: 'Other' })
    const pinned = createKnife({ id: 'pinned', name: 'First', pinned: true })
    const families = groupKnifeFamilies(
      prioritizePinnedKnives([other, first, pinned], true),
    )
    expect(families.map(({ name }) => name)).toEqual(['First', 'Other'])
    expect(families[0].knives.map(({ id }) => id)).toEqual(['pinned', 'first'])
  })

  it('keeps a filtered variant linked to the full family without adding excluded knives', () => {
    const first = createKnife({ id: 'first' })
    const second = createKnife({ id: 'second' })
    const full = groupKnifeFamilies([first, second])
    const filtered = groupKnifeFamilies([second])
    expect(filtered[0].key).toBe(full[0].key)
    expect(filtered[0].knives).toEqual([second])
    expect(getKnifeFamilyKey(second)).toBe(full[0].key)
  })

  it('labels variants with model number, steel, handle, and finish', () => {
    const knife = createKnife({
      handleMaterial: 'Titanium',
      specs: {
        ...createKnife().specs,
        modelNumber: 'A3510',
        bladeMaterial: '154CM',
        bladeCoating: 'Destroyer Gray',
      },
    })
    expect(getKnifeVariantLabel(knife, [knife])).toBe(
      'A3510 · 154CM · Titanium · Destroyer Gray',
    )
  })

  it('disambiguates identical or missing specs with stable record IDs', () => {
    const first = createKnife({ id: 'first' })
    const second = createKnife({ id: 'second' })
    expect(getKnifeVariantLabel(first, [first, second])).toContain(' · first')
    expect(getKnifeVariantLabel(second, [first, second])).toContain(' · second')
    const empty = createKnife({
      id: 'empty',
      specs: { weight: '', bladeLength: '', overallLength: '', country: '' },
      handleMaterial: '',
    })
    expect(getKnifeVariantLabel(empty, [empty])).toBe('empty')
  })
})
