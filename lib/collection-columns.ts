import { builtInFilterDefinitions } from '@/lib/collection-filters'
import { getKnifeImageCount, type Knife } from '@/lib/data'
import type {
  CollectionColumn,
  CollectionColumnSort,
  CustomField,
  DimensionUnit,
} from '@/lib/settings-shared'
import { formatDimension, formatWeight } from '@/lib/measurements'
import {
  parseLengthToInches,
  parseWeightToOunces,
} from '@/lib/measurement-parser'

type SortValue = string | number | undefined

export type CollectionColumnDefinition = {
  key: CollectionColumn
  label: string
  width: string
  getValue: (knife: Knife) => string
  /** Value used for header sorting; defaults to `getValue`. */
  getSortValue?: (knife: Knife) => SortValue
  /** False when list summaries lack the data (descriptions). */
  sortable?: boolean
}

export function statusForKnife(knife: Knife) {
  if (knife.pinned) return { label: 'Pinned', tone: 'pinned' as const }
  if (
    !knife.specs.designer ||
    !knife.specs.bladeLength ||
    !knife.handleMaterial ||
    !knife.bladeStyle ||
    !knife.specs.lockingMechanism
  ) {
    return { label: 'Incomplete', tone: 'missing' as const }
  }
  return { label: 'Complete', tone: 'complete' as const }
}

const statusRank = { complete: 0, missing: 1, pinned: 2 }

function dateSortValue(value: string | undefined): SortValue {
  const time = value ? Date.parse(value) : Number.NaN
  return Number.isNaN(time) ? undefined : time
}

const defaultColumns: CollectionColumnDefinition[] = [
  {
    key: 'maker',
    label: 'Maker',
    width: 'minmax(64px, 0.6fr)',
    getValue: (knife) => knife.brand,
  },
  {
    key: 'steel',
    label: 'Steel',
    width: '54px',
    getValue: (knife) => knife.specs.bladeMaterial ?? '',
  },
  {
    key: 'blade',
    label: 'Blade',
    width: '48px',
    getValue: (knife) => formatDimension(knife.specs.bladeLength),
  },
  {
    key: 'weight',
    label: 'Weight',
    width: '52px',
    getValue: (knife) => formatWeight(knife.specs.weight),
  },
  {
    key: 'status',
    label: 'Status',
    width: '88px',
    getValue: () => '',
    getSortValue: (knife) => statusRank[statusForKnife(knife).tone],
  },
]

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}

export function getCollectionColumns(
  customFields: CustomField[],
  dimensionUnit: DimensionUnit = 'in',
): CollectionColumnDefinition[] {
  const columns: CollectionColumnDefinition[] = [
    ...defaultColumns,
    {
      key: 'name',
      label: 'Model Name',
      width: '160px',
      getValue: (knife) => knife.name,
    },
    ...builtInFilterDefinitions
      .filter(
        (field) =>
          !['brand', 'bladeMaterial', 'bladeLength', 'weight'].includes(
            field.key,
          ),
      )
      .map((field) => ({
        key: field.key as CollectionColumn,
        label: field.label,
        width: '120px',
        getValue: (knife: Knife) => field.getValue(knife) ?? '',
      })),
    {
      key: 'description',
      label: 'Description',
      width: '220px',
      getValue: (knife) => knife.description,
      sortable: false,
    },
    {
      key: 'sourceUrl',
      label: 'Source URL',
      width: '200px',
      getValue: (knife) => knife.sourceUrl,
    },
    {
      key: 'pinned',
      label: 'Pinned',
      width: '70px',
      getValue: (knife) => (knife.pinned ? 'Yes' : 'No'),
    },
    {
      key: 'sold',
      label: 'Sold',
      width: '70px',
      getValue: (knife) => (knife.sold ? 'Yes' : 'No'),
    },
    {
      key: 'addedAt',
      label: 'Date Added',
      width: '110px',
      getValue: (knife) => formatDate(knife.addedAt),
      getSortValue: (knife) => dateSortValue(knife.addedAt),
    },
    {
      key: 'updatedAt',
      label: 'Last Updated',
      width: '110px',
      getValue: (knife) => formatDate(knife.updatedAt),
      getSortValue: (knife) => dateSortValue(knife.updatedAt),
    },
    {
      key: 'images',
      label: 'Photos',
      width: '70px',
      getValue: (knife) => String(getKnifeImageCount(knife)),
      getSortValue: (knife) => getKnifeImageCount(knife),
    },
    ...customFields.map((field) => ({
      key: `custom:${field.id}` as CollectionColumn,
      label: field.name,
      width: '140px',
      getValue: (knife: Knife) => {
        const value = knife.customFields[field.id] ?? ''
        return field.type === 'date' && value ? formatDate(value) : value
      },
      getSortValue: (knife: Knife) => {
        const value = knife.customFields[field.id]?.trim()
        if (!value) return undefined
        if (field.type === 'date') return dateSortValue(value)
        if (field.type === 'number') {
          const number = Number(value.replace(/,/g, ''))
          return Number.isFinite(number) ? number : value
        }
        return value
      },
    })),
  ]
  return columns.map((column) => {
    const specKey = column.key === 'blade' ? 'bladeLength' : column.key
    if (
      ![
        'bladeLength',
        'overallLength',
        'handleLength',
        'bladeThickness',
        'weight',
      ].includes(specKey)
    )
      return column
    const raw = (knife: Knife) =>
      knife.specs[specKey as keyof Knife['specs']] ?? ''
    return {
      ...column,
      width: dimensionUnit === 'both' ? '160px' : column.width,
      // Compare in one unit so metric and imperial entries sort together.
      getSortValue: (knife: Knife) =>
        (specKey === 'weight'
          ? parseWeightToOunces(raw(knife))
          : parseLengthToInches(raw(knife))) ??
        (raw(knife).trim() || undefined),
      getValue: (knife: Knife) =>
        specKey === 'weight'
          ? formatWeight(knife.specs.weight, dimensionUnit)
          : formatDimension(
              knife.specs[specKey as keyof Knife['specs']],
              dimensionUnit,
            ),
    }
  })
}

function compareSortValues(left: SortValue, right: SortValue) {
  if (typeof left === 'number' && typeof right === 'number') return left - right
  // Unparsed text sorts after numbers in the same column.
  if (typeof left === 'number') return -1
  if (typeof right === 'number') return 1
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

/** Sort by a table column. Empty values stay last in both directions. */
export function sortKnivesByColumn(
  knives: Knife[],
  sort: CollectionColumnSort,
  columns: CollectionColumnDefinition[],
): Knife[] {
  const column = columns.find((item) => item.key === sort.key)
  const getSortValue: ((knife: Knife) => SortValue) | undefined =
    sort.key === 'knife'
      ? (knife) => knife.name
      : column && column.sortable !== false
        ? (column.getSortValue ?? column.getValue)
        : undefined
  if (!getSortValue) return [...knives]
  const direction = sort.direction === 'asc' ? 1 : -1
  const keyed = knives.map((knife) => {
    const value = getSortValue(knife)
    return {
      knife,
      value: typeof value === 'string' && !value.trim() ? undefined : value,
    }
  })
  return keyed
    .sort((left, right) => {
      if (left.value === undefined || right.value === undefined) {
        if (left.value === right.value) return 0
        return left.value === undefined ? 1 : -1
      }
      return (
        compareSortValues(left.value, right.value) * direction ||
        left.knife.name.localeCompare(right.knife.name)
      )
    })
    .map((item) => item.knife)
}
