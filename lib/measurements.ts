import {
  parseLengthToInches,
  parseLengthToMillimeters,
  parseWeightToGrams,
  parseWeightToOunces,
  statesMeasurementUnit,
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

/**
 * Rounds a converted (not stated) value to a readable precision. Stated values
 * keep the precision they were entered with.
 */
function displayValue(
  formatted: string,
  source: string,
  unit: 'in' | 'mm' | 'g' | 'oz',
): string {
  if (statesMeasurementUnit(source, unit)) return formatted
  // Round from the parsed value so the stored 3–4 decimals don't round twice.
  const number =
    {
      in: parseLengthToInches,
      mm: parseLengthToMillimeters,
      g: parseWeightToGrams,
      oz: parseWeightToOunces,
    }[unit](source) ?? Number(formatted)
  const decimals =
    unit === 'in'
      ? number < 1
        ? 3
        : 2
      : unit === 'mm'
        ? number < 10
          ? 3
          : 1
        : unit === 'g'
          ? 1
          : 2
  return Number(number.toFixed(decimals)).toString()
}

export function formatDimension(
  value: string | undefined,
  unit: DimensionUnit = 'in',
): string {
  const split = splitDimension(value)
  if (!value || !split.inches || !split.millimeters) return value?.trim() ?? ''
  const inches = displayValue(split.inches, value, 'in')
  const millimeters = displayValue(split.millimeters, value, 'mm')
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
  const split = splitWeight(value)
  if (!value || !split.grams || !split.ounces) return value?.trim() ?? ''
  const grams = displayValue(split.grams, value, 'g')
  const ounces = displayValue(split.ounces, value, 'oz')
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
