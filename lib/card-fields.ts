import type { Knife } from '@/lib/data'
import { formatDimension, formatWeight } from '@/lib/measurements'
import type {
  BuiltInCardField,
  CardField,
  CustomField,
  DimensionUnit,
} from '@/lib/settings-shared'

export type CardFieldDefinition = {
  key: CardField
  label: string
}

export type CardFieldGroup = {
  label: string
  fields: CardFieldDefinition[]
}

export const BUILT_IN_CARD_FIELD_GROUPS = [
  {
    label: 'Identity',
    fields: [
      { key: 'specs.modelNumber', label: 'Model number' },
      { key: 'specs.designer', label: 'Designer' },
      { key: 'specs.country', label: 'Country' },
      { key: 'specs.price', label: 'Price' },
    ],
  },
  {
    label: 'Construction',
    fields: [
      { key: 'specs.bladeMaterial', label: 'Blade material' },
      { key: 'bladeStyle', label: 'Blade style' },
      { key: 'specs.bladeCoating', label: 'Blade coating / finish' },
      { key: 'handleMaterial', label: 'Handle material' },
      { key: 'specs.lockingMechanism', label: 'Locking mechanism' },
      { key: 'specs.hardness', label: 'Hardness' },
    ],
  },
  {
    label: 'Dimensions',
    fields: [
      { key: 'specs.overallLength', label: 'Overall length' },
      { key: 'specs.bladeLength', label: 'Blade length' },
      { key: 'specs.bladeThickness', label: 'Blade thickness' },
      { key: 'specs.handleLength', label: 'Handle length' },
      { key: 'specs.weight', label: 'Weight' },
    ],
  },
] as const satisfies readonly {
  label: string
  fields: readonly {
    key: BuiltInCardField
    label: string
  }[]
}[]

export function getCardFieldGroups(
  customFields: CustomField[],
): CardFieldGroup[] {
  const groups: CardFieldGroup[] = BUILT_IN_CARD_FIELD_GROUPS.map((group) => ({
    label: group.label,
    fields: group.fields.map((field) => ({ ...field })),
  }))

  if (customFields.length > 0) {
    groups.push({
      label: 'Custom fields',
      fields: customFields.map((field) => ({
        key: `custom:${field.id}`,
        label: field.name,
      })),
    })
  }

  return groups
}

export function getCardFieldLabel(
  field: CardField,
  customFields: CustomField[],
): string {
  if (field.startsWith('custom:')) {
    const id = field.slice('custom:'.length)
    return customFields.find((item) => item.id === id)?.name || 'Custom field'
  }

  for (const group of BUILT_IN_CARD_FIELD_GROUPS) {
    const definition = group.fields.find((item) => item.key === field)
    if (definition) return definition.label
  }

  return field
}

export function getCardFieldValue(knife: Knife, field: CardField): string {
  if (field.startsWith('custom:')) {
    return knife.customFields[field.slice('custom:'.length)] ?? ''
  }

  if (field === 'bladeStyle') return knife.bladeStyle
  if (field === 'handleMaterial') return knife.handleMaterial

  const specKey = field.slice('specs.'.length) as keyof Knife['specs']
  return knife.specs[specKey] ?? ''
}

export function getCardFieldDisplayValue(
  knife: Knife,
  field: CardField,
  customFields: CustomField[],
  dimensionUnit?: DimensionUnit,
): string {
  const value = getCardFieldValue(knife, field)
  if (!value) return ''
  if (
    dimensionUnit &&
    [
      'specs.overallLength',
      'specs.bladeLength',
      'specs.bladeThickness',
      'specs.handleLength',
    ].includes(field)
  )
    return formatDimension(value, dimensionUnit)
  if (dimensionUnit && field === 'specs.weight')
    return formatWeight(value, dimensionUnit)
  if (field === 'bladeStyle' || field === 'handleMaterial') return value

  const customField = field.startsWith('custom:')
    ? customFields.find((item) => item.id === field.slice('custom:'.length))
    : undefined
  const formattedValue =
    customField?.type === 'date'
      ? (() => {
          try {
            return new Intl.DateTimeFormat(undefined, {
              dateStyle: 'medium',
            }).format(new Date(value))
          } catch {
            return value
          }
        })()
      : value

  return formattedValue
}

const PINNED_DISAMBIGUATOR_FIELDS: readonly CardField[] = [
  'specs.modelNumber',
  'handleMaterial',
  'specs.bladeCoating',
  'specs.hardness',
]

function normalizeDisambiguatorValue(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Detail line for a pinned sidebar item. When family variants would render the
 * same line, a readable field is appended; the slug is only a last resort.
 */
export function getPinnedDetailLine(
  knife: Knife,
  fields: readonly CardField[],
  customFields: CustomField[],
  siblings: readonly Knife[],
  dimensionUnit?: DimensionUnit,
): string {
  const getDetails = (item: Knife) =>
    getVisibleCardFields(item, fields, customFields, dimensionUnit, {
      includeModelNumber: true,
    })
      .map((field) => field.value)
      .join(' · ')
  const getValue = (item: Knife, field: CardField) =>
    getCardFieldDisplayValue(item, field, customFields, dimensionUnit)

  const details = getDetails(knife)
  const colliding = siblings.filter(
    (sibling) => sibling.id !== knife.id && getDetails(sibling) === details,
  )
  if (colliding.length === 0) return details

  for (const field of PINNED_DISAMBIGUATOR_FIELDS) {
    if (fields.includes(field)) continue
    const value = getValue(knife, field)
    if (!value) continue
    const normalized = normalizeDisambiguatorValue(value)
    const distinguishes = colliding.every(
      (sibling) =>
        normalizeDisambiguatorValue(getValue(sibling, field)) !== normalized,
    )
    if (distinguishes) {
      return [details, value].filter(Boolean).join(' · ')
    }
  }

  return [details, knife.id].filter(Boolean).join(' · ')
}

export function getVisibleCardFields(
  knife: Knife,
  fields: readonly CardField[],
  customFields: CustomField[],
  dimensionUnit?: DimensionUnit,
  options: { includeModelNumber?: boolean } = {},
): { key: CardField; label: string; value: string }[] {
  return fields
    .filter(
      (field) => options.includeModelNumber || field !== 'specs.modelNumber',
    )
    .map((field) => ({
      key: field,
      label: getCardFieldLabel(field, customFields),
      value: getCardFieldDisplayValue(
        knife,
        field,
        customFields,
        dimensionUnit,
      ),
    }))
    .filter((field) => field.value)
}
