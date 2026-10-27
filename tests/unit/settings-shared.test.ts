import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CARD_FIELDS,
  DEFAULT_COLLECTION_DISPLAY,
  normalizeCollectionDisplay,
  normalizeCardFields,
  normalizeThemeStyle,
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
    expect(normalizeThemeStyle('unknown')).toBe('classic')
    expect(normalizeThemeStyle(null)).toBe('classic')
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

  it('allows every optional column to be hidden and defaults missing preferences', () => {
    expect(normalizeCollectionDisplay({ columns: [] }).columns).toEqual([])
    expect(normalizeCollectionDisplay(null)).toEqual(DEFAULT_COLLECTION_DISPLAY)
  })
})
