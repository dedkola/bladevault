import { describe, expect, it } from 'vitest'
import { DEFAULT_CARD_FIELDS, normalizeCardFields } from '@/lib/settings-shared'

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
