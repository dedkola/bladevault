import type { ChipFilterField } from '@/components/collection-chip-filter'
import type { Knife } from '@/lib/data'
import {
  builtInFilterDefinitions,
  getFilterOptionLabel,
  NOT_SET_FILTER_VALUE,
} from '@/lib/collection-filters'
import type { CustomField, CustomFieldType } from '@/lib/settings-shared'
import { rangeDefinitions } from '@/lib/smart-collections'

/** Shows a custom date value in the reader's locale; other types as stored. */
export function formatCustomFilterValue(
  value: string,
  type: CustomFieldType,
): string {
  if (type !== 'date' || !value) return value
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
    }).format(new Date(value))
  } catch {
    return value
  }
}

/** Numbers sort by value; everything else alphabetically. */
export function sortFilterOptions(
  options: string[],
  type: CustomFieldType,
): string[] {
  if (type === 'number') {
    return [...options].sort((left, right) => {
      const leftNumber = Number.parseFloat(left)
      const rightNumber = Number.parseFloat(right)
      if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) {
        return leftNumber - rightNumber
      }
      return left.localeCompare(right)
    })
  }
  return [...options].sort((left, right) => left.localeCompare(right))
}

/**
 * Fields for the chip search bar: every built-in filter and custom field,
 * with each value's count, a "Not set" option when some knives lack one,
 * and the unit for fields that also take numeric ranges.
 */
export function buildChipFilterFields(
  knives: Knife[],
  customFields: CustomField[],
): ChipFilterField[] {
  const definitions = [
    ...builtInFilterDefinitions.map((definition) => ({
      key: definition.key as string,
      label: definition.label,
      type: 'text' as CustomFieldType,
      custom: false,
      getValue: definition.getValue as (knife: Knife) => string | undefined,
    })),
    ...customFields.map((field) => ({
      key: `custom:${field.id}`,
      label: field.name,
      type: field.type,
      custom: true,
      getValue: (knife: Knife) => knife.customFields[field.id],
    })),
  ]

  return definitions.map((definition) => {
    const counts = new Map<string, number>()
    for (const knife of knives) {
      const value = definition.getValue(knife)
      const key = value && value.trim() ? value : NOT_SET_FILTER_VALUE
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const populated = sortFilterOptions(
      [...counts.keys()].filter((value) => value !== NOT_SET_FILTER_VALUE),
      definition.type,
    )
    const values = counts.has(NOT_SET_FILTER_VALUE)
      ? [NOT_SET_FILTER_VALUE, ...populated]
      : populated
    return {
      key: definition.key,
      label: definition.label,
      custom: definition.custom,
      rangeUnit: rangeDefinitions.find((field) => field.key === definition.key)
        ?.unit,
      options: values.map((value) => ({
        value,
        label:
          value === NOT_SET_FILTER_VALUE
            ? getFilterOptionLabel(value)
            : formatCustomFilterValue(value, definition.type),
        count: counts.get(value) ?? 0,
      })),
    }
  })
}
