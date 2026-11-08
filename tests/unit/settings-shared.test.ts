import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CARD_FIELDS,
  DEFAULT_COLLECTION_DISPLAY,
  normalizeCollectionDisplay,
  normalizeCardFields,
  normalizeThemeStyle,
  applyThemeStyleToElement,
  getModernThemeVariant,
  getThemeFamily,
  isModernThemeFamily,
  readThemeStyleFromElement,
  normalizeDimensionUnit,
} from '@/lib/settings-shared'

describe('normalizeCardFields', () => {
  it('keeps valid built-in and custom fields in their first-seen order', () => {
    expect(
      normalizeCardFields([
        'specs.price',
        'custom:acquired',
        'specs.price',
        'unknown',
        42,
      ]),
    ).toEqual(['specs.price', 'custom:acquired'])
  })

  it('uses an independent copy of the fallback for malformed input', () => {
    const normalized = normalizeCardFields(null)
    expect(normalized).toEqual(DEFAULT_CARD_FIELDS)
    expect(normalized).not.toBe(DEFAULT_CARD_FIELDS)
  })

  it('rejects an empty custom-field identifier', () => {
    expect(normalizeCardFields(['custom:', 'bladeStyle'])).toEqual([
      'bladeStyle',
    ])
  })
})

describe('normalizeThemeStyle', () => {
  it('keeps supported theme styles and falls back to the default', () => {
    expect(normalizeThemeStyle('modern')).toBe('modern')
    expect(normalizeThemeStyle('classic')).toBe('classic')
    expect(normalizeThemeStyle('alloy')).toBe('alloy')
    expect(normalizeThemeStyle('forge')).toBe('forge')
    expect(normalizeThemeStyle('titanium')).toBe('titanium')
    expect(normalizeThemeStyle('field')).toBe('field')
    expect(normalizeThemeStyle('unknown')).toBe('classic')
    expect(normalizeThemeStyle(null)).toBe('classic')
  })

  it('preserves Alloy when an unrelated or invalid preference is normalized', () => {
    expect(normalizeThemeStyle(undefined, 'alloy')).toBe('alloy')
    expect(normalizeThemeStyle('unknown', 'alloy')).toBe('alloy')
  })
})

describe('theme families', () => {
  it('maps Forge, Titanium and Field onto the Modern layout', () => {
    expect(getThemeFamily('forge')).toBe('modern')
    expect(getThemeFamily('field')).toBe('modern')
    expect(getThemeFamily('alloy')).toBe('alloy')
    expect(getModernThemeVariant('titanium')).toBe('titanium')
    expect(getModernThemeVariant('modern')).toBeUndefined()
    expect(isModernThemeFamily('forge')).toBe(true)
    expect(isModernThemeFamily('classic')).toBe(false)
  })

  it('round-trips the style through root data attributes', () => {
    const element = { dataset: {} as DOMStringMap } as HTMLElement
    applyThemeStyleToElement(element, 'titanium')
    expect(element.dataset).toEqual({
      themeStyle: 'modern',
      themeVariant: 'titanium',
    })
    expect(readThemeStyleFromElement(element)).toBe('titanium')
    applyThemeStyleToElement(element, 'alloy')
    expect(element.dataset).toEqual({ themeStyle: 'alloy' })
    expect(readThemeStyleFromElement(element)).toBe('alloy')
  })
})

describe('normalizeCollectionDisplay', () => {
  it('rejects unknown columns and invalid layout values while preserving valid choices', () => {
    expect(
      normalizeCollectionDisplay({
        columns: ['status', 'unknown', 'status'],
        view: 'other',
        sort: 'model',
        density: false,
      }),
    ).toEqual({
      ...DEFAULT_COLLECTION_DISPLAY,
      columns: ['status'],
      sort: 'model',
    })
  })

  it('keeps additional fields and custom-field identifiers while removing duplicates and invalid fields', () => {
    expect(
      normalizeCollectionDisplay({
        columns: [
          'modelNumber',
          'custom:inventory',
          'description',
          'custom:',
          'unknown',
          'custom:inventory',
        ],
      }).columns,
    ).toEqual(['modelNumber', 'custom:inventory', 'description'])
  })

  it('validates saved column widths and bounds invalid sizes', () => {
    expect(
      normalizeCollectionDisplay({
        columnWidths: {
          knife: 20,
          steel: 120.4,
          maker: 9999,
          unknown: 100,
          status: Infinity,
          'custom:inventory': 180,
        },
      }).columnWidths,
    ).toEqual({ knife: 140, steel: 120, maker: 800, 'custom:inventory': 180 })
  })

  it('validates the table header sort and lets it be cleared', () => {
    expect(
      normalizeCollectionDisplay({
        columnSort: { key: 'blade', direction: 'desc' },
      }).columnSort,
    ).toEqual({ key: 'blade', direction: 'desc' })
    expect(
      normalizeCollectionDisplay({
        columnSort: { key: 'unknown', direction: 'asc' },
      }).columnSort,
    ).toBeNull()
    expect(
      normalizeCollectionDisplay({
        columnSort: { key: 'knife', direction: 'sideways' },
      }).columnSort,
    ).toBeNull()
    const current = {
      ...DEFAULT_COLLECTION_DISPLAY,
      columnSort: { key: 'maker', direction: 'asc' as const },
    }
    expect(
      normalizeCollectionDisplay({ sort: 'brand' }, current).columnSort,
    ).toEqual(current.columnSort)
    expect(
      normalizeCollectionDisplay({ columnSort: null }, current).columnSort,
    ).toBeNull()
  })

  it('allows every optional column to be hidden and defaults missing preferences', () => {
    expect(normalizeCollectionDisplay({ columns: [] }).columns).toEqual([])
    expect(normalizeCollectionDisplay(null)).toEqual(DEFAULT_COLLECTION_DISPLAY)
  })
})

describe('normalizeDimensionUnit', () => {
  it('keeps supported choices and defaults missing or malformed values to inches', () => {
    for (const unit of ['in', 'mm', 'both'] as const) {
      expect(normalizeDimensionUnit(unit)).toBe(unit)
    }
    expect(normalizeDimensionUnit(undefined)).toBe('in')
    expect(normalizeDimensionUnit('cm')).toBe('in')
    expect(normalizeDimensionUnit({})).toBe('in')
  })

  it('preserves the saved preference for an invalid or unrelated update', () => {
    expect(normalizeDimensionUnit(undefined, 'both')).toBe('both')
    expect(normalizeDimensionUnit('cm', 'mm')).toBe('mm')
  })
})
