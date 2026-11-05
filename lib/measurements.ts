import {
  parseLengthToInches,
  parseLengthToMillimeters,
  parseWeightToGrams,
  parseWeightToOunces,
} from '@/lib/measurement-parser'
import type { DimensionUnit } from '@/lib/settings-shared'

export function formatDimensionNumber(
  value: number,
  unit: 'in' | 'mm',
): string {
  return Number(value.toFixed(unit === 'in' ? 4 : 3)).toString()
}

export function splitDimension(value: string | undefined): {
  inches: string
  millimeters: string
} {
  if (!value?.trim()) return { inches: '', millimeters: '' }
  const inches = parseLengthToInches(value)
  const millimeters = parseLengthToMillimeters(value)
  return {
    inches:
      inches !== undefined && inches >= 0
        ? formatDimensionNumber(inches, 'in')
        : '',
    millimeters:
      millimeters !== undefined && millimeters >= 0
        ? formatDimensionNumber(millimeters, 'mm')
        : '',
  }
}

export function formatDimension(
  value: string | undefined,
  unit: DimensionUnit = 'in',
): string {
  const { inches, millimeters } = splitDimension(value)
  if (!inches || !millimeters) return value?.trim() ?? ''
  if (unit === 'both') return `${millimeters} mm / ${inches} in`
  return unit === 'mm' ? `${millimeters} mm` : `${inches} in`
}

export function splitWeight(value: string | undefined): {
  grams: string
  ounces: string
} {
  if (!value?.trim()) return { grams: '', ounces: '' }
  const grams = parseWeightToGrams(value)
  const ounces = parseWeightToOunces(value)
  return {
    grams:
      grams !== undefined && grams >= 0
        ? Number(grams.toFixed(3)).toString()
        : '',
    ounces:
      ounces !== undefined && ounces >= 0
        ? Number(ounces.toFixed(4)).toString()
        : '',
  }
}

export function formatWeight(
  value: string | undefined,
  unit: DimensionUnit = 'in',
): string {
  const { grams, ounces } = splitWeight(value)
  if (!grams || !ounces) return value?.trim() ?? ''
  if (unit === 'both') return `${grams} g / ${ounces} oz`
  return unit === 'mm' ? `${grams} g` : `${ounces} oz`
}

/** Retain the entered value and its precision; derive the other unit for display. */
export function dimensionInputValue(
  input: string,
  unit: 'in' | 'mm' | 'g' | 'oz',
): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  if (/^[\d\s.,/+-]+$/.test(trimmed)) return `${trimmed} ${unit}`
  return trimmed
}
