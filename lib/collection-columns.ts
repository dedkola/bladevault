import { builtInFilterDefinitions } from '@/lib/collection-filters'
import { getKnifeImageCount, type Knife } from '@/lib/data'
import type { CollectionColumn, CustomField } from '@/lib/settings-shared'
import { compactMeasurement } from '@/lib/compact-measurement'

export type CollectionColumnDefinition = {
  key: CollectionColumn
  label: string
  width: string
  getValue: (knife: Knife) => string
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
    getValue: (knife) => compactMeasurement(knife.specs.bladeLength),
  },
  {
    key: 'weight',
    label: 'Weight',
    width: '52px',
    getValue: (knife) => compactMeasurement(knife.specs.weight),
  },
  { key: 'status', label: 'Status', width: '88px', getValue: () => '' },
]

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}

export function getCollectionColumns(
  customFields: CustomField[],
): CollectionColumnDefinition[] {
  return [
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
    },
    {
      key: 'updatedAt',
      label: 'Last Updated',
      width: '110px',
      getValue: (knife) => formatDate(knife.updatedAt),
    },
    {
      key: 'images',
      label: 'Photos',
      width: '70px',
      getValue: (knife) => String(getKnifeImageCount(knife)),
    },
    ...customFields.map((field) => ({
      key: `custom:${field.id}` as CollectionColumn,
      label: field.name,
      width: '140px',
      getValue: (knife: Knife) => {
        const value = knife.customFields[field.id] ?? ''
        return field.type === 'date' && value ? formatDate(value) : value
      },
    })),
  ]
}
