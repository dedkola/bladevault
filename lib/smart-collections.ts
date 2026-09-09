import { matchesKnifeSearch, type Knife } from '@/lib/data'
import {
  builtInFilterDefinitions,
  NOT_SET_FILTER_VALUE,
} from '@/lib/collection-filters'
import {
  parseLengthToMillimeters,
  parseWeightToOunces,
} from '@/lib/collection-stats'

export type SmartCollection = { id: string; name: string; query: string }
export const rangeDefinitions = [
  { key: 'bladeLength', label: 'Blade length', unit: 'mm' },
  { key: 'overallLength', label: 'Overall length', unit: 'mm' },
  { key: 'handleLength', label: 'Handle length', unit: 'mm' },
  { key: 'bladeThickness', label: 'Blade thickness', unit: 'mm' },
  { key: 'weight', label: 'Weight', unit: 'g' },
] as const

export function collectionQuery(params: URLSearchParams): string {
  const result = new URLSearchParams()
  for (const [key, value] of params) {
    if (
      value &&
      (key === 'q' ||
        key === 'missingSpecs' ||
        key.startsWith('custom:') ||
        builtInFilterDefinitions.some((field) => field.key === key) ||
        rangeDefinitions.some(
          (field) => key === `${field.key}Min` || key === `${field.key}Max`,
        ))
    )
      result.append(key, value)
  }
  result.sort()
  return result.toString()
}

export function rangeError(params: URLSearchParams): string | null {
  for (const field of rangeDefinitions) {
    const min = params.get(`${field.key}Min`)
    const max = params.get(`${field.key}Max`)
    for (const value of [min, max]) {
      if (
        value !== null &&
        (!value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0)
      )
        return 'Enter a non-negative number for each range.'
    }
    if (min !== null && max !== null && Number(min) >= Number(max))
      return `${field.label}: minimum must be below the upper limit.`
  }
  return null
}

export function matchesCollection(
  knife: Knife,
  params: URLSearchParams,
): boolean {
  if (rangeError(params) || !matchesKnifeSearch(knife, params.get('q') ?? ''))
    return false
  for (const field of builtInFilterDefinitions) {
    const values = params.getAll(field.key)
    const actual = field.getValue(knife)
    if (
      values.length &&
      !values.some((value) =>
        value === NOT_SET_FILTER_VALUE ? !actual?.trim() : actual === value,
      )
    )
      return false
  }
  for (const key of new Set(params.keys())) {
    if (!key.startsWith('custom:')) continue
    const actual = knife.customFields[key.slice(7)]
    if (
      !params
        .getAll(key)
        .some((value) =>
          value === NOT_SET_FILTER_VALUE ? !actual?.trim() : actual === value,
        )
    )
      return false
  }
  if (
    params.get('missingSpecs') === '1' &&
    !builtInFilterDefinitions.some(
      (field) => field.key !== 'brand' && !field.getValue(knife)?.trim(),
    )
  )
    return false
  for (const field of rangeDefinitions) {
    const min = params.get(`${field.key}Min`)
    const max = params.get(`${field.key}Max`)
    if (min === null && max === null) continue
    const raw = knife.specs[field.key] ?? ''
    // Prefer explicit grams in dual-unit values to avoid rounding at boundaries.
    const grams = raw.match(/(-?\d+(?:[.,]\d+)?)\s*(?:g|grams?)\b/i)
    const ounces = field.key === 'weight' ? parseWeightToOunces(raw) : undefined
    const value =
      field.key === 'weight'
        ? grams
          ? Number(grams[1].replace(',', '.'))
          : ounces === undefined
            ? undefined
            : ounces * 28.349523125
        : parseLengthToMillimeters(raw)
    if (
      value === undefined ||
      value < 0 ||
      (min !== null && value < Number(min)) ||
      (max !== null && value >= Number(max))
    )
      return false
  }
  return true
}
