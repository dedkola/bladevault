import type { Knife, KnifeUpdates } from '@/lib/data'
import { normalizeKnifeTextFields } from '@/lib/knife-text'
import type { CustomField } from '@/lib/settings-shared'

export type KnifeFieldValue = string | boolean

export type KnifeFieldDefinition = {
  path: string
  label: string
  type: 'text' | 'boolean' | 'number' | 'date'
  aliases: readonly string[]
  writable: boolean
}

export type ValidatedKnifeChange = {
  field: string
  previousValue: KnifeFieldValue
  value: KnifeFieldValue
}

export type KnifeChangeInput = {
  field: string
  value: string | boolean | null
}

const BUILT_IN_KNIFE_FIELDS = [
  {
    path: 'name',
    label: 'Model',
    type: 'text',
    aliases: ['model'],
    writable: true,
  },
  {
    path: 'brand',
    label: 'Brand / Maker',
    type: 'text',
    aliases: ['maker'],
    writable: true,
  },
  {
    path: 'bladeStyle',
    label: 'Blade Style',
    type: 'text',
    aliases: ['blade_style'],
    writable: true,
  },
  {
    path: 'handleMaterial',
    label: 'Handle Material',
    type: 'text',
    aliases: ['handle_material'],
    writable: true,
  },
  {
    path: 'description',
    label: 'Description',
    type: 'text',
    aliases: ['notes'],
    writable: true,
  },
  {
    path: 'sourceUrl',
    label: 'Source URL',
    type: 'text',
    aliases: ['source_url'],
    writable: true,
  },
  {
    path: 'pinned',
    label: 'Pinned',
    type: 'boolean',
    aliases: [],
    writable: true,
  },
  {
    path: 'specs.weight',
    label: 'Weight',
    type: 'text',
    aliases: ['weight'],
    writable: true,
  },
  {
    path: 'specs.overallLength',
    label: 'Overall Length',
    type: 'text',
    aliases: ['overallLength', 'overall_length'],
    writable: true,
  },
  {
    path: 'specs.bladeLength',
    label: 'Blade Length',
    type: 'text',
    aliases: ['bladeLength', 'blade_length'],
    writable: true,
  },
  {
    path: 'specs.bladeThickness',
    label: 'Blade Thickness',
    type: 'text',
    aliases: ['bladeThickness', 'blade_thickness'],
    writable: true,
  },
  {
    path: 'specs.bladeCoating',
    label: 'Blade Coating / Finish',
    type: 'text',
    aliases: ['bladeCoating', 'blade_coating', 'finish'],
    writable: true,
  },
  {
    path: 'specs.bladeMaterial',
    label: 'Blade Material',
    type: 'text',
    aliases: ['bladeMaterial', 'blade_material', 'steel'],
    writable: true,
  },
  {
    path: 'specs.lockingMechanism',
    label: 'Locking Mechanism',
    type: 'text',
    aliases: ['lockingMechanism', 'locking_mechanism', 'lock'],
    writable: true,
  },
  {
    path: 'specs.designer',
    label: 'Designer',
    type: 'text',
    aliases: ['designer'],
    writable: true,
  },
  {
    path: 'specs.modelNumber',
    label: 'Model Number',
    type: 'text',
    aliases: ['modelNumber', 'model_number'],
    writable: true,
  },
  {
    path: 'specs.handleLength',
    label: 'Handle Length',
    type: 'text',
    aliases: ['handleLength', 'handle_length'],
    writable: true,
  },
  {
    path: 'specs.hardness',
    label: 'Hardness',
    type: 'text',
    aliases: ['hardness'],
    writable: true,
  },
  {
    path: 'specs.price',
    label: 'Price',
    type: 'text',
    aliases: ['price'],
    writable: true,
  },
  {
    path: 'specs.country',
    label: 'Country',
    type: 'text',
    aliases: ['country'],
    writable: true,
  },
  {
    path: 'id',
    label: 'ID',
    type: 'text',
    aliases: [],
    writable: false,
  },
  {
    path: 'addedAt',
    label: 'Added At',
    type: 'date',
    aliases: ['added_at'],
    writable: false,
  },
  {
    path: 'updatedAt',
    label: 'Updated At',
    type: 'date',
    aliases: ['updated_at'],
    writable: false,
  },
] as const satisfies readonly KnifeFieldDefinition[]

const normalizedFieldAliases = new Map<string, KnifeFieldDefinition>()
for (const field of BUILT_IN_KNIFE_FIELDS) {
  for (const key of [field.path, ...field.aliases]) {
    normalizedFieldAliases.set(key.toLowerCase(), field)
  }
}

function customFieldDefinition(field: CustomField): KnifeFieldDefinition {
  return {
    path: `customFields.${field.id}`,
    label: field.name,
    type: field.type,
    aliases: [],
    writable: true,
  }
}

export function getKnifeFieldDefinitions(
  customFields: CustomField[],
): KnifeFieldDefinition[] {
  return [...BUILT_IN_KNIFE_FIELDS, ...customFields.map(customFieldDefinition)]
}

export function resolveKnifeField(
  field: string,
  customFields: CustomField[],
): KnifeFieldDefinition | undefined {
  const trimmed = field.trim()
  const builtIn = normalizedFieldAliases.get(trimmed.toLowerCase())
  if (builtIn) return builtIn

  if (!trimmed.startsWith('customFields.')) return undefined
  const id = trimmed.slice('customFields.'.length)
  const definition = customFields.find((item) => item.id === id)
  return definition ? customFieldDefinition(definition) : undefined
}

export function getKnifeFieldValue(
  knife: Knife,
  field: string,
): KnifeFieldValue | undefined {
  if (field.startsWith('customFields.')) {
    return knife.customFields[field.slice('customFields.'.length)] ?? ''
  }

  if (field.startsWith('specs.')) {
    return (
      knife.specs[field.slice('specs.'.length) as keyof Knife['specs']] ?? ''
    )
  }

  if (field === 'pinned') return knife.pinned
  if (
    field === 'id' ||
    field === 'name' ||
    field === 'brand' ||
    field === 'bladeStyle' ||
    field === 'handleMaterial' ||
    field === 'description' ||
    field === 'sourceUrl' ||
    field === 'addedAt' ||
    field === 'updatedAt'
  ) {
    return knife[field]
  }

  return undefined
}

function normalizeCustomFieldValue(
  value: string,
  definition: KnifeFieldDefinition,
): string {
  if (definition.type === 'number') {
    if (!value) return ''
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
      throw new Error(`${definition.label} must be a valid number`)
    }
    return value.trim()
  }

  if (definition.type === 'date') {
    if (!value) return ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error(`${definition.label} must use YYYY-MM-DD format`)
    }
    const date = new Date(`${value}T00:00:00.000Z`)
    if (
      Number.isNaN(date.getTime()) ||
      date.toISOString().slice(0, 10) !== value
    ) {
      throw new Error(`${definition.label} must be a valid date`)
    }
  }

  return value.trim()
}

function normalizeFieldValue(
  definition: KnifeFieldDefinition,
  value: KnifeChangeInput['value'],
): KnifeFieldValue {
  if (definition.type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new Error(`${definition.label} must be true or false`)
    }
    return value
  }

  if (value !== null && typeof value !== 'string') {
    throw new Error(`${definition.label} must be text`)
  }

  const stringValue = value ?? ''
  if (definition.path.startsWith('customFields.')) {
    return normalizeCustomFieldValue(stringValue, definition)
  }

  const updates = definition.path.startsWith('specs.')
    ? {
        specs: {
          [definition.path.slice('specs.'.length)]: stringValue,
        },
      }
    : { [definition.path]: stringValue }
  const normalized = normalizeKnifeTextFields(updates as KnifeUpdates)
  const result = definition.path.startsWith('specs.')
    ? normalized.specs?.[
        definition.path.slice('specs.'.length) as keyof Knife['specs']
      ]
    : normalized[
        definition.path as keyof Omit<KnifeUpdates, 'specs' | 'customFields'>
      ]

  if (typeof result !== 'string') {
    throw new Error(`${definition.label} must be text`)
  }
  if (definition.path === 'name' && !result) {
    throw new Error('Model cannot be empty')
  }
  if (definition.path === 'sourceUrl' && result) {
    let url: URL
    try {
      url = new URL(result)
    } catch {
      throw new Error('Source URL must be a valid http or https URL')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Source URL must be a valid http or https URL')
    }
  }
  return result
}

export function validateKnifeChanges({
  knife,
  changes,
  customFields,
}: {
  knife: Knife
  changes: KnifeChangeInput[]
  customFields: CustomField[]
}): { changes: ValidatedKnifeChange[]; updates: KnifeUpdates } {
  if (changes.length === 0) {
    throw new Error('Provide at least one field change')
  }

  const seen = new Set<string>()
  const validated: ValidatedKnifeChange[] = []
  const updates: KnifeUpdates = {}

  for (const change of changes) {
    const definition = resolveKnifeField(change.field, customFields)
    if (!definition) {
      throw new Error(`Unsupported field: ${change.field}`)
    }
    if (!definition.writable) {
      throw new Error(`${definition.path} is read-only`)
    }
    if (seen.has(definition.path)) {
      throw new Error(`Field appears more than once: ${definition.path}`)
    }
    seen.add(definition.path)

    const previousValue = getKnifeFieldValue(knife, definition.path)
    if (previousValue === undefined) {
      throw new Error(`Unsupported field: ${definition.path}`)
    }
    const value = normalizeFieldValue(definition, change.value)
    if (value === previousValue) continue

    validated.push({ field: definition.path, previousValue, value })
    if (definition.path.startsWith('customFields.')) {
      updates.customFields = {
        ...updates.customFields,
        [definition.path.slice('customFields.'.length)]: String(value),
      }
    } else if (definition.path.startsWith('specs.')) {
      updates.specs = {
        ...updates.specs,
        [definition.path.slice('specs.'.length)]: String(value),
      }
    } else if (definition.path === 'pinned') {
      updates.pinned = Boolean(value)
    } else {
      Object.assign(updates, { [definition.path]: String(value) })
    }
  }

  return { changes: validated, updates }
}

export function isMissingKnifeField(knife: Knife, field: string): boolean {
  const value = getKnifeFieldValue(knife, field)
  return typeof value === 'string'
    ? value.trim().length === 0
    : value === undefined
}
