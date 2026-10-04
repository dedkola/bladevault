import type { Knife } from '@/lib/data'
import {
  parseLengthToMillimeters,
  parseWeightToOunces,
} from '@/lib/collection-stats'
import type { SmartCollection } from '@/lib/smart-collections'

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

export type MaterialAliasGroup = {
  key: string
  suggestedValue: string
  values: Array<{ value: string; knives: Knife[] }>
}

export function getMaterialAliasGroups(knives: Knife[]): MaterialAliasGroup[] {
  const groups = new Map<string, Map<string, Knife[]>>()
  for (const knife of knives) {
    const value = knife.handleMaterial.trim()
    if (!value) continue
    // Only case variants and the known whole-field G10/G-10 spelling.
    // Composite materials and similar-looking names remain independent.
    const key = /^g-?10$/i.test(value) ? 'g-10' : value.toLowerCase()
    const values = groups.get(key) ?? new Map<string, Knife[]>()
    values.set(value, [...(values.get(value) ?? []), knife])
    groups.set(key, values)
  }
  return [...groups.entries()]
    .filter(([, values]) => values.size > 1)
    .map(([key, entries]) => {
      const values = [...entries.entries()]
        .map(([value, knives]) => ({ value, knives }))
        .sort(
          (a, b) =>
            b.knives.length - a.knives.length || a.value.localeCompare(b.value),
        )
      return {
        key,
        suggestedValue: key === 'g-10' ? 'G-10' : values[0].value,
        values,
      }
    })
    .sort((a, b) => a.key.localeCompare(b.key))
}

export function affectedMaterialCollections(
  collections: SmartCollection[],
  from: string[],
): SmartCollection[] {
  return collections.filter((collection) =>
    new URLSearchParams(collection.query)
      .getAll('handleMaterial')
      .some((value) => from.includes(value)),
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
