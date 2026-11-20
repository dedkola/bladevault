import { describe, expect, it } from 'vitest'
import { csvField, csvLine } from '@/lib/csv'
import { priceExportFilename } from '@/lib/price-monitor/export'

describe('csvField', () => {
  it('writes plain text and numbers as they are', () => {
    expect(csvField('Vosteed')).toBe('Vosteed')
    expect(csvField(129.99)).toBe('129.99')
    expect(csvField(-12.5)).toBe('-12.5')
    expect(csvField(0)).toBe('0')
  })

  it('leaves empty values and non-finite numbers blank', () => {
    expect(csvField(null)).toBe('')
    expect(csvField(undefined)).toBe('')
    expect(csvField(Number.NaN)).toBe('')
    expect(csvField(Infinity)).toBe('')
  })

  it('quotes commas, quotes and line breaks', () => {
    expect(csvField('Knife, large')).toBe('"Knife, large"')
    expect(csvField('The "Raccoon"')).toBe('"The ""Raccoon"""')
    expect(csvField('two\nlines')).toBe('"two\nlines"')
    expect(csvField('crlf\r\nend')).toBe('"crlf\r\nend"')
  })

  it('neutralizes text a spreadsheet would run as a formula', () => {
    expect(csvField('=HYPERLINK("http://x","y")')).toBe(
      `"'=HYPERLINK(""http://x"",""y"")"`,
    )
    expect(csvField('+1')).toBe("'+1")
    expect(csvField('-2+3')).toBe("'-2+3")
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvField('\tcmd')).toBe("'\tcmd")
    expect(csvField('\rcmd')).toBe(`"'\rcmd"`)
    expect(csvField('a=b')).toBe('a=b')
  })

  it('joins a record with CRLF', () => {
    expect(csvLine(['a', 1, null, 'b,c'])).toBe('a,1,,"b,c"\r\n')
  })
})

describe('priceExportFilename', () => {
  const day = new Date(2026, 10, 19, 12)

  it('names all-knife and per-knife exports', () => {
    expect(priceExportFilename('snapshots', null, 'all', day)).toBe(
      'bladevault-price-history-2026-11-19.csv',
    )
    expect(
      priceExportFilename(
        'events',
        { brand: 'Böker', name: 'Plus "Kwaiken" / Air' },
        '3m',
        day,
      ),
    ).toBe('bladevault-price-events-boker-plus-kwaiken-air-3m-2026-11-19.csv')
  })

  it('falls back when the name has no usable characters', () => {
    expect(
      priceExportFilename('snapshots', { brand: '', name: '刀' }, 'all', day),
    ).toBe('bladevault-price-history-knife-2026-11-19.csv')
  })
})
