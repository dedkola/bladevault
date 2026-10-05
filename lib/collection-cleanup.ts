import type { Knife } from '@/lib/data'
import {
  parseLengthToMillimeters,
  parseWeightToOunces,
} from '@/lib/collection-stats'
import type { SmartCollection } from '@/lib/smart-collections'
import { getBulkEditFieldValue, type BulkEditFieldKey } from '@/lib/bulk-edit'
import type { BuiltInFilterKey } from '@/lib/collection-filters'
import { normalizeSingleLineText } from '@/lib/knife-text'

export const cleanupMeasurements = [
  { key: 'bladeThickness', label: 'Blade thickness', unit: 'mm' },
  { key: 'bladeLength', label: 'Blade length', unit: 'mm' },
  { key: 'overallLength', label: 'Overall length', unit: 'mm' },
  { key: 'handleLength', label: 'Handle length', unit: 'mm' },
  { key: 'weight', label: 'Weight', unit: 'g' },
] as const
export type CleanupMeasurementKey = (typeof cleanupMeasurements)[number]['key']
export type MeasurementIssue = 'missing' | 'uninterpretable'

export function interpretMeasurement(
  key: CleanupMeasurementKey,
  text: string,
): number | undefined {
  const ounces = key === 'weight' ? parseWeightToOunces(text) : undefined
  const value =
    key === 'weight'
      ? ounces === undefined
        ? undefined
        : ounces * 28.349523125
      : parseLengthToMillimeters(text)
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

export function measurementIssue(
  key: CleanupMeasurementKey,
  text: string,
): MeasurementIssue | undefined {
  if (!text.trim()) return 'missing'
  return interpretMeasurement(key, text) === undefined
    ? 'uninterpretable'
    : undefined
}

export function formatInterpretedMeasurement(
  key: CleanupMeasurementKey,
  text: string,
): string {
  if (!text.trim()) return 'Missing value'
  const value = interpretMeasurement(key, text)
  if (value === undefined)
    return 'Cannot interpret reliably; include a supported unit.'
  const unit = cleanupMeasurements.find((field) => field.key === key)!.unit
  return `${Number(value.toFixed(3))} ${unit} — understood`
}

export const cleanupLabelFields = [
  { key: 'country', field: 'specs.country', label: 'Country' },
  { key: 'designer', field: 'specs.designer', label: 'Designer' },
  {
    key: 'bladeMaterial',
    field: 'specs.bladeMaterial',
    label: 'Blade material',
  },
  { key: 'bladeStyle', field: 'bladeStyle', label: 'Blade style' },
  { key: 'brand', field: 'brand', label: 'Brand / Maker' },
  { key: 'handleMaterial', field: 'handleMaterial', label: 'Handle material' },
  {
    key: 'lockingMechanism',
    field: 'specs.lockingMechanism',
    label: 'Locking mechanism',
  },
  {
    key: 'bladeCoating',
    field: 'specs.bladeCoating',
    label: 'Blade coating / Finish',
  },
] as const satisfies readonly {
  key: BuiltInFilterKey
  field: BulkEditFieldKey
  label: string
}[]

export type CleanupLabelField = (typeof cleanupLabelFields)[number]
export type LabelAliasGroup = {
  key: string
  field: CleanupLabelField
  suggestedValue: string
  values: Array<{ value: string; knives: Knife[] }>
}

export function getLabelAliasGroups(knives: Knife[]): LabelAliasGroup[] {
  return cleanupLabelFields.flatMap((field) => {
    const groups = new Map<string, Map<string, Knife[]>>()
    for (const knife of knives) {
      // Retain the exact stored value for previews and saved-filter checks.
      const original = getBulkEditFieldValue(knife, field.field)
      const normalized = normalizeSingleLineText(original)
      if (!normalized) continue
      // Only the handle field has a known spelling alias. Do not remove
      // punctuation from steels, merge composites, or strip hardness values.
      const key =
        field.key === 'handleMaterial' && /^g-?10$/i.test(normalized)
          ? 'g-10'
          : normalized.toLowerCase()
      const values = groups.get(key) ?? new Map<string, Knife[]>()
      values.set(original, [...(values.get(original) ?? []), knife])
      groups.set(key, values)
    }
    return [...groups.entries()]
      .filter(
        ([, values]) =>
          values.size > 1 ||
          [...values.keys()].some(
            (value) => value !== normalizeSingleLineText(value),
          ),
      )
      .map(([key, entries]) => {
        const values = [...entries.entries()]
          .map(([value, knives]) => ({ value, knives }))
          .sort(
            (a, b) =>
              b.knives.length - a.knives.length ||
              a.value.localeCompare(b.value),
          )
        return {
          key: `${field.key}:${key}`,
          field,
          suggestedValue:
            field.key === 'handleMaterial' && key === 'g-10'
              ? 'G-10'
              : normalizeSingleLineText(values[0].value),
          values,
        }
      })
      .sort((a, b) => a.key.localeCompare(b.key))
  })
}

export function affectedLabelCollections(
  collections: SmartCollection[],
  field: CleanupLabelField,
  from: string[],
): SmartCollection[] {
  return collections.filter((collection) =>
    new URLSearchParams(collection.query)
      .getAll(field.key)
      .some((value) => from.includes(value)),
  )
}

export function getCombinedSteelKnives(knives: Knife[]): Knife[] {
  // A review hint, never an inferred correction or automatic field split.
  return knives.filter((knife) =>
    /\b(?:HRC|Rockwell)\b/i.test(knife.specs.bladeMaterial ?? ''),
  )
}

export type CleanupQueue = {
  field: CleanupMeasurementKey
  issue: MeasurementIssue
  entries: Array<{ id: string; addedAt: string }>
  index: number
  saved: number
  skipped: number
}

export function readCleanupQueue(raw: string | null): CleanupQueue | null {
  if (!raw) return null
  try {
    const queue = JSON.parse(raw) as CleanupQueue
    if (
      !queue ||
      !cleanupMeasurements.some((field) => field.key === queue.field) ||
      !['missing', 'uninterpretable'].includes(queue.issue) ||
      !Array.isArray(queue.entries) ||
      queue.entries.length === 0 ||
      !queue.entries.every(
        (entry) =>
          entry &&
          typeof entry.id === 'string' &&
          typeof entry.addedAt === 'string',
      ) ||
      ![queue.index, queue.saved, queue.skipped].every(
        (value) => Number.isInteger(value) && value >= 0,
      ) ||
      queue.index > queue.entries.length ||
      queue.saved + queue.skipped > queue.index
    )
      return null
    return queue
  } catch {
    return null
  }
}
