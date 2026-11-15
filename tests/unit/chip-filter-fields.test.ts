import { describe, expect, it } from 'vitest'
import type { Knife } from '@/lib/data'
import { buildChipFilterFields } from '@/lib/chip-filter-fields'
import { NOT_SET_FILTER_VALUE } from '@/lib/collection-filters'

function knife(overrides: Partial<Knife> & { id: string }): Knife {
  return {
    name: 'Knife',
    brand: 'Maker',
    bladeStyle: '',
    handleMaterial: '',
    images: [],
    specs: { weight: '', overallLength: '', bladeLength: '', country: '' },
    customFields: {},
    addedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    description: '',
    sourceUrl: '',
    pinned: false,
    sold: false,
    ...overrides,
  }
}

describe('buildChipFilterFields', () => {
  const knives = [
    knife({ id: 'a', brand: 'Spyderco' }),
    knife({ id: 'b', brand: 'Benchmade' }),
    knife({ id: 'c', brand: 'Spyderco' }),
    knife({ id: 'd', brand: '  ', customFields: { f1: '12' } }),
  ]
  const fields = buildChipFilterFields(knives, [
    { id: 'f1', name: 'Edges', type: 'number' },
  ])

  it('counts each value, sorts them and lists missing values first', () => {
    const brand = fields.find((field) => field.key === 'brand')
    expect(brand?.options).toEqual([
      { value: NOT_SET_FILTER_VALUE, label: 'Not set', count: 1 },
      { value: 'Benchmade', label: 'Benchmade', count: 1 },
      { value: 'Spyderco', label: 'Spyderco', count: 2 },
    ])
    expect(brand?.custom).toBe(false)
  })

  it('marks range fields with their unit', () => {
    expect(fields.find((field) => field.key === 'bladeLength')?.rangeUnit).toBe(
      'mm',
    )
    expect(fields.find((field) => field.key === 'weight')?.rangeUnit).toBe('g')
    expect(
      fields.find((field) => field.key === 'brand')?.rangeUnit,
    ).toBeUndefined()
  })

  it('adds custom fields under their own key', () => {
    const custom = fields.find((field) => field.key === 'custom:f1')
    expect(custom).toMatchObject({ label: 'Edges', custom: true })
    expect(custom?.options.map((option) => option.value)).toEqual([
      NOT_SET_FILTER_VALUE,
      '12',
    ])
  })
})
