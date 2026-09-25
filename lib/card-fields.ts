import type { Knife } from '@/lib/data'
import type {
  BuiltInCardField,
  CardField,
  CustomField,
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
): string {
  const value = getCardFieldValue(knife, field)
  if (!value) return ''
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

export function getVisibleCardFields(
  knife: Knife,
  fields: readonly CardField[],
  customFields: CustomField[],
): { key: CardField; label: string; value: string }[] {
  return fields
    .filter((field) => field !== 'specs.modelNumber')
    .map((field) => ({
      key: field,
      label: getCardFieldLabel(field, customFields),
      value: getCardFieldDisplayValue(knife, field, customFields),
    }))
    .filter((field) => field.value)
}
