import { describe, expect, it } from 'vitest'
import {
  dimensionInputValue,
  formatDimension,
  formatWeight,
  splitDimension,
  splitWeight,
} from '@/lib/measurements'
import {
  parseWeightToGrams,
  parseWeightToOunces,
} from '@/lib/measurement-parser'

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

describe('weight units', () => {
  it('separates stated grams and ounces without replacing them with rounded conversions', () => {
    expect(splitWeight('5.04oz / 142.8g')).toEqual({
      grams: '142.8',
      ounces: '5.04',
    })
    expect(formatWeight('5.04oz / 142.8g', 'mm')).toBe('142.8 g')
    expect(formatWeight('5.04oz / 142.8g', 'in')).toBe('5.04 oz')
    expect(formatWeight('5.04oz / 142.8g', 'both')).toBe('142.8 g / 5.04 oz')
    expect(splitWeight('142.8g/5.04oz')).toEqual({
      grams: '142.8',
      ounces: '5.04',
    })
    expect(splitWeight('5.04ounces/142.8grams')).toEqual({
      grams: '142.8',
      ounces: '5.04',
    })
  })

  it('converts single units, fractions, decimal commas, kilograms, and pounds', () => {
    expect(formatWeight('1 oz', 'mm')).toBe('28.35 g')
    expect(formatWeight('28.349523125 g', 'in')).toBe('1 oz')
    expect(formatWeight('1/2 oz', 'mm')).toBe('14.175 g')
    expect(formatWeight('71,8 g', 'both')).toBe('71.8 g / 2.5327 oz')
    expect(parseWeightToGrams('0.1 kg')).toBeCloseTo(100)
    expect(parseWeightToGrams('1 lb')).toBeCloseTo(453.59237)
    expect(parseWeightToOunces('1 lb')).toBe(16)
  })

  it('preserves empty, unsupported, and invalid weights without inventing values', () => {
    expect(formatWeight(undefined, 'mm')).toBe('')
    expect(formatWeight('', 'both')).toBe('')
    expect(formatWeight('unknown', 'mm')).toBe('unknown')
    expect(formatWeight('-3 g', 'in')).toBe('-3 g')
    expect(formatWeight('1/0 oz', 'mm')).toBe('1/0 oz')
    expect(dimensionInputValue('71.800', 'g')).toBe('71.800 g')
    expect(dimensionInputValue('2.5300', 'oz')).toBe('2.5300 oz')
  })
})
