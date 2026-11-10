import { describe, expect, it } from 'vitest'
import { getPinnedDetailLine, getVisibleCardFields } from '@/lib/card-fields'
import { createKnife } from '@/tests/fixtures/knife'

const knife = createKnife({
  specs: {
    ...createKnife().specs,
    modelNumber: '1133A3',
    bladeMaterial: '14C28N',
    bladeLength: '3.25 in',
  },
})

describe('visible card fields', () => {
  it('omits the model number for cards, where it has its own slot', () => {
    const fields = getVisibleCardFields(
      knife,
      ['specs.modelNumber', 'specs.bladeMaterial'],
      [],
      'in',
    )

    expect(fields.map((field) => field.key)).toEqual(['specs.bladeMaterial'])
  })

  it('includes the model number for pinned details when selected', () => {
    const fields = getVisibleCardFields(
      knife,
      ['specs.modelNumber', 'specs.bladeLength'],
      [],
      'in',
      { includeModelNumber: true },
    )

    expect(fields.map((field) => field.value)).toEqual(['1133A3', '3.25 in'])
  })

  it('keeps the stored order and drops empty values', () => {
    const fields = getVisibleCardFields(
      knife,
      ['specs.bladeLength', 'specs.bladeCoating', 'specs.modelNumber'],
      [],
      'in',
      { includeModelNumber: true },
    )

    expect(fields.map((field) => field.key)).toEqual([
      'specs.bladeLength',
      'specs.modelNumber',
    ])
  })
})

function createPinnedKnife(overrides: Parameters<typeof createKnife>[0]) {
  return createKnife({
    name: 'Porcupine',
    brand: 'Vosteed',
    handleMaterial: 'Micarta',
    specs: {
      ...createKnife().specs,
      modelNumber: 'A2605',
      bladeMaterial: '14C28N',
      bladeLength: '2.99 in',
      hardness: '58-60 HRC',
    },
    ...overrides,
  })
}

describe('pinned detail line', () => {
  const fields = ['specs.bladeMaterial', 'specs.bladeLength'] as const

  it('shows only the selected fields when nothing collides', () => {
    const knife = createPinnedKnife({ id: 'porcupine-2' })
    const sibling = createPinnedKnife({
      id: 'porcupine-3',
      specs: { ...createPinnedKnife({}).specs, bladeMaterial: '154CM' },
    })

    expect(
      getPinnedDetailLine(knife, [...fields], [], [knife, sibling], 'in'),
    ).toBe('14C28N · 2.99 in')
  })

  it('appends the model number instead of the slug for identical variants', () => {
    const knife = createPinnedKnife({ id: 'porcupine-2' })
    const sibling = createPinnedKnife({
      id: 'porcupine-3',
      specs: { ...createPinnedKnife({}).specs, modelNumber: 'A2620' },
    })

    expect(
      getPinnedDetailLine(knife, [...fields], [], [knife, sibling], 'in'),
    ).toBe('14C28N · 2.99 in · A2605')
  })

  it('falls through to another readable field when the model matches', () => {
    const knife = createPinnedKnife({ id: 'porcupine-2' })
    const sibling = createPinnedKnife({
      id: 'porcupine-3',
      handleMaterial: 'G10',
    })

    expect(
      getPinnedDetailLine(knife, [...fields], [], [knife, sibling], 'in'),
    ).toBe('14C28N · 2.99 in · Micarta')
  })

  it('skips disambiguators that are already selected', () => {
    const knife = createPinnedKnife({ id: 'porcupine-2' })
    const sibling = createPinnedKnife({
      id: 'porcupine-3',
      handleMaterial: 'G10',
    })
    const selected = ['specs.bladeMaterial', 'specs.modelNumber'] as const

    expect(
      getPinnedDetailLine(knife, [...selected], [], [knife, sibling], 'in'),
    ).toBe('14C28N · A2605 · Micarta')
  })

  it('falls back to the slug when no readable field distinguishes variants', () => {
    const knife = createPinnedKnife({ id: 'porcupine-2' })
    const sibling = createPinnedKnife({ id: 'porcupine-3' })

    expect(
      getPinnedDetailLine(knife, [...fields], [], [knife, sibling], 'in'),
    ).toBe('14C28N · 2.99 in · porcupine-2')
  })
})
