import { describe, expect, it } from 'vitest'
import {
  dimensionInputValue,
  formatDimension,
  splitDimension,
} from '@/lib/measurements'

describe('dimension units', () => {
  it('converts a single source measurement into either display unit', () => {
    expect(formatDimension('3.5 in', 'mm')).toBe('88.9 mm')
    expect(formatDimension('88.9 mm', 'in')).toBe('3.5 in')
    expect(formatDimension('3.5 in', 'both')).toBe('88.9 mm / 3.5 in')
    expect(formatDimension('0.090 in', 'mm')).toBe('2.286 mm')
  })

  it('separates retailer pairs and preserves stated values in both units', () => {
    expect(splitDimension("3.52''/89.4mm")).toEqual({
      inches: '3.52',
      millimeters: '89.4',
    })
    expect(splitDimension('3"(76mm)')).toEqual({
      inches: '3',
      millimeters: '76',
    })
    expect(splitDimension('3.52in/89.4mm')).toEqual({
      inches: '3.52',
      millimeters: '89.4',
    })
    expect(splitDimension('89.4mm/3.52in')).toEqual({
      inches: '3.52',
      millimeters: '89.4',
    })
  })

  it('supports centimeters, decimal commas, fractions, and inch quote styles', () => {
    expect(formatDimension('8,89 cm', 'both')).toBe('88.9 mm / 3.5 in')
    expect(formatDimension('3 1/2 in', 'mm')).toBe('88.9 mm')
    expect(formatDimension('3.5”', 'mm')).toBe('88.9 mm')
  })

  it('preserves unknown legacy text without inventing conversions', () => {
    expect(formatDimension('unknown', 'mm')).toBe('unknown')
    expect(formatDimension('-3 mm', 'in')).toBe('-3 mm')
    expect(formatDimension('', 'both')).toBe('')
    expect(formatDimension(undefined, 'mm')).toBe('')
    expect(formatDimension('1//8 in', 'mm')).toBe('1//8 in')
    expect(formatDimension('1/0 in', 'mm')).toBe('1/0 in')
  })

  it('stores the entered precision and accepts explicit pasted units', () => {
    expect(dimensionInputValue('0.09000', 'in')).toBe('0.09000 in')
    expect(dimensionInputValue('3 1/2', 'in')).toBe('3 1/2 in')
    expect(dimensionInputValue('88.9 mm', 'in')).toBe('88.9 mm')
    expect(dimensionInputValue(' ', 'mm')).toBe('')
    expect(dimensionInputValue('unknown', 'mm')).toBe('unknown')
  })
})
