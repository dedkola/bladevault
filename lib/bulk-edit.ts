import type { Knife, KnifeUpdates } from '@/lib/data'

export const builtInBulkEditFields = [
  { key: 'name', label: 'Model Name', type: 'text' },
  { key: 'brand', label: 'Brand / Maker', type: 'text' },
  { key: 'specs.designer', label: 'Designer', type: 'text' },
  { key: 'specs.country', label: 'Country', type: 'text' },
  { key: 'specs.price', label: 'Price', type: 'text' },
  { key: 'specs.bladeMaterial', label: 'Blade Material', type: 'text' },
  { key: 'bladeStyle', label: 'Blade Style', type: 'text' },
  {
    key: 'specs.bladeCoating',
    label: 'Blade Coating / Finish',
    type: 'text',
  },
  { key: 'handleMaterial', label: 'Handle Material', type: 'text' },
  {
    key: 'specs.lockingMechanism',
    label: 'Locking Mechanism',
    type: 'text',
  },
  { key: 'specs.hardness', label: 'Hardness', type: 'text' },
  { key: 'specs.overallLength', label: 'Overall Length', type: 'text' },
  { key: 'specs.bladeLength', label: 'Blade Length', type: 'text' },
  { key: 'specs.bladeThickness', label: 'Blade Thickness', type: 'text' },
  { key: 'specs.handleLength', label: 'Handle Length', type: 'text' },
  { key: 'specs.weight', label: 'Weight', type: 'text' },
] as const

export type BuiltInBulkEditFieldKey =
  (typeof builtInBulkEditFields)[number]['key']
export type BulkEditFieldKey =
  BuiltInBulkEditFieldKey | `customFields.${string}`

export type BulkEditFieldDefinition = {
  key: BulkEditFieldKey
  label: string
  type: 'text' | 'number' | 'date'
}

const builtInBulkEditFieldKeys = new Set<string>(
  builtInBulkEditFields.map((field) => field.key),
)

export function isBuiltInBulkEditFieldKey(
  field: string,
): field is BuiltInBulkEditFieldKey {
  return builtInBulkEditFieldKeys.has(field)
}

export function getCustomBulkEditFieldId(field: string): string | null {
  if (!field.startsWith('customFields.')) return null
  const fieldId = field.slice('customFields.'.length)
  return fieldId || null
}

export function getBulkEditFieldValue(
  knife: Knife,
  field: BulkEditFieldKey,
): string {
  const customFieldId = getCustomBulkEditFieldId(field)
  if (customFieldId) {
    return knife.customFields[customFieldId] ?? ''
  }

  if (field.startsWith('specs.')) {
    const specKey = field.slice('specs.'.length) as keyof Knife['specs']
    return knife.specs[specKey] ?? ''
  }

  return knife[field as 'name' | 'brand' | 'bladeStyle' | 'handleMaterial']
}

export function createBulkKnifeUpdates(
  field: BulkEditFieldKey,
  value: string,
): KnifeUpdates {
  const customFieldId = getCustomBulkEditFieldId(field)
  if (customFieldId) {
    return { customFields: { [customFieldId]: value } }
  }

  if (field.startsWith('specs.')) {
    const specKey = field.slice('specs.'.length) as keyof Knife['specs']
    return { specs: { [specKey]: value } }
  }

  return { [field]: value } as KnifeUpdates
}
