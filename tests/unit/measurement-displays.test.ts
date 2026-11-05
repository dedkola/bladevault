import { describe, expect, it } from 'vitest'
import { getVisibleCardFields } from '@/lib/card-fields'
import { getCollectionColumns } from '@/lib/collection-columns'
import { createKnife } from '@/tests/fixtures/knife'

const knife = createKnife({
  specs: {
    ...createKnife().specs,
    bladeLength: '3.5 in',
    overallLength: '203.2 mm',
    bladeThickness: '0.125 in',
    handleLength: '4.5 in',
    weight: '5.04oz / 142.8g',
  },
})

describe('measurement display preferences', () => {
  it('formats card dimensions and weights without changing saved measurements', () => {
    const fields = getVisibleCardFields(
      knife,
      [
        'specs.bladeLength',
        'specs.overallLength',
        'specs.bladeThickness',
        'specs.handleLength',
        'specs.weight',
      ],
      [],
      'mm',
    )
    expect(fields.map((field) => field.value)).toEqual([
      '88.9 mm',
      '203.2 mm',
      '3.175 mm',
      '114.3 mm',
      '142.8 g',
    ])
    expect(knife.specs.bladeLength).toBe('3.5 in')
    expect(knife.specs.weight).toBe('5.04oz / 142.8g')
  })

  it('shows both length and weight units in collection columns', () => {
    const columns = getCollectionColumns([], 'both')
    const value = (key: string) =>
      columns.find((column) => column.key === key)?.getValue(knife)
    expect(value('blade')).toBe('88.9 mm / 3.5 in')
    expect(value('overallLength')).toBe('203.2 mm / 8 in')
    expect(value('bladeThickness')).toBe('3.175 mm / 0.125 in')
    expect(value('handleLength')).toBe('114.3 mm / 4.5 in')
    expect(value('weight')).toBe('142.8 g / 5.04 oz')
    expect(columns.find((column) => column.key === 'blade')?.width).toBe(
      '160px',
    )
    expect(columns.find((column) => column.key === 'weight')?.width).toBe(
      '160px',
    )
  })
})
