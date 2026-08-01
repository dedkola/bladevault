import { describe, expect, it } from 'vitest'
import {
  normalizeKnifeTextFields,
  normalizeMultilineText,
  normalizeSingleLineText,
} from '@/lib/knife-text'

describe('knife text normalization', () => {
  it('collapses single-line whitespace', () => {
    expect(normalizeSingleLineText('  Benchmade\n\tBugout  ')).toBe(
      'Benchmade Bugout',
    )
  })

  it('normalizes line endings while preserving paragraph breaks', () => {
    expect(normalizeMultilineText(' First  line \r\n\r\n Second\tline ')).toBe(
      'First line\n\nSecond line',
    )
  })

  it('normalizes nested specs and custom fields without mutating the input', () => {
    const input = {
      name: '  Bugout  ',
      sourceUrl: '  https://example.com/a path  ',
      specs: { bladeMaterial: '  CPM-  S30V ' },
      customFields: { acquiredFrom: '  Knife   shop ' },
    }

    expect(normalizeKnifeTextFields(input)).toEqual({
      name: 'Bugout',
      sourceUrl: 'https://example.com/a path',
      specs: { bladeMaterial: 'CPM- S30V' },
      customFields: { acquiredFrom: 'Knife shop' },
    })
    expect(input.name).toBe('  Bugout  ')
  })
})
