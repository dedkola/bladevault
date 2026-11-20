import { matchesKnifeSearch, type Knife } from '@/lib/data'
import {
  CARE_KIND_PARAM,
  isCareStatusLevel,
  matchesCareFilter,
  parseCareKind,
  type KnifeCareStatus,
} from '@/lib/maintenance-due'
import {
  builtInFilterDefinitions,
  NOT_SET_FILTER_VALUE,
} from '@/lib/collection-filters'
import {
  isMarketFilterValue,
  MARKET_PARAM,
  matchesMarketFilter,
  type MarketSummaryMap,
} from '@/lib/market-status'
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
        key === 'knifeType' ||
        key === 'care' ||
        key === CARE_KIND_PARAM ||
        key === MARKET_PARAM ||
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
  /**
   * Derived care status per knife; without it the `care` filter is ignored,
   * so callers that cannot know care status keep their current results.
   */
  careStatusById?: ReadonlyMap<string, KnifeCareStatus>,
  /**
   * Market summary per knife; without it the `market` filter is ignored, so
   * targets without price monitoring (the static app) keep their results.
   */
  marketById?: MarketSummaryMap,
): boolean {
  if (rangeError(params) || !matchesKnifeSearch(knife, params.get('q') ?? ''))
    return false
  if (careStatusById) {
    const careValues = params.getAll('care').filter(isCareStatusLevel)
    const careKind = parseCareKind(params.get(CARE_KIND_PARAM))
    if (
      (careValues.length > 0 || careKind) &&
      !matchesCareFilter(careStatusById.get(knife.id), careValues, careKind)
    )
      return false
  }
  if (marketById) {
    const marketValues = params.getAll(MARKET_PARAM).filter(isMarketFilterValue)
    if (!matchesMarketFilter(marketById.get(knife.id), marketValues))
      return false
  }
  const knifeType = params.get('knifeType')
  if (knifeType === 'fixed' || knifeType === 'folding') {
    const lock = knife.specs.lockingMechanism?.trim() ?? ''
    const fixed = /\bfix(?:ed)?\b/i.test(lock)
    const folding =
      !fixed &&
      /liner|frame|crossbar|button|axis|slip.?joint|back.?lock|lock.?back|compression|ball bearing|tri.?ad|shark|vanchor|superlock|recoil|clutch|scorpion|friction/i.test(
        lock,
      )
    if (!(knifeType === 'fixed' ? fixed : folding)) return false
  }
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
