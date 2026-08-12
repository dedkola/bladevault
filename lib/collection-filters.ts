import type { Knife } from '@/lib/data'

export const NOT_SET_FILTER_VALUE = '__not_set__'

export const builtInFilterDefinitions = [
  { key: 'brand', label: 'Brand', getValue: (knife: Knife) => knife.brand },
  {
    key: 'modelNumber',
    label: 'Model Number',
    getValue: (knife: Knife) => knife.specs.modelNumber,
  },
  {
    key: 'bladeMaterial',
    label: 'Blade Material',
    getValue: (knife: Knife) => knife.specs.bladeMaterial,
  },
  {
    key: 'bladeStyle',
    label: 'Blade Style',
    getValue: (knife: Knife) => knife.bladeStyle,
  },
  {
    key: 'bladeCoating',
    label: 'Blade Coating / Finish',
    getValue: (knife: Knife) => knife.specs.bladeCoating,
  },
  {
    key: 'hardness',
    label: 'Hardness',
    getValue: (knife: Knife) => knife.specs.hardness,
  },
  {
    key: 'lockingMechanism',
    label: 'Locking Mechanism',
    getValue: (knife: Knife) => knife.specs.lockingMechanism,
  },
  {
    key: 'designer',
    label: 'Designer',
    getValue: (knife: Knife) => knife.specs.designer,
  },
  {
    key: 'handleMaterial',
    label: 'Handle Material',
    getValue: (knife: Knife) => knife.handleMaterial,
  },
  {
    key: 'handleLength',
    label: 'Handle Length',
    getValue: (knife: Knife) => knife.specs.handleLength,
  },
  {
    key: 'bladeLength',
    label: 'Blade Length',
    getValue: (knife: Knife) => knife.specs.bladeLength,
  },
  {
    key: 'overallLength',
    label: 'Overall Length',
    getValue: (knife: Knife) => knife.specs.overallLength,
  },
  {
    key: 'bladeThickness',
    label: 'Blade Thickness',
    getValue: (knife: Knife) => knife.specs.bladeThickness,
  },
  {
    key: 'weight',
    label: 'Weight',
    getValue: (knife: Knife) => knife.specs.weight,
  },
  {
    key: 'price',
    label: 'Price',
    getValue: (knife: Knife) => knife.specs.price,
  },
  {
    key: 'country',
    label: 'Country',
    getValue: (knife: Knife) => knife.specs.country,
  },
] as const

export type BuiltInFilterKey = (typeof builtInFilterDefinitions)[number]['key']

export function getFilterOptionLabel(value: string): string {
  return value === NOT_SET_FILTER_VALUE ? 'Not set' : value
}
