export const APP_THEMES = ['light', 'dark'] as const

export type AppTheme = (typeof APP_THEMES)[number]

export const CARD_FIELDS = [
  'bladeStyle',
  'handleMaterial',
  'specs.modelNumber',
  'specs.designer',
  'specs.country',
  'specs.price',
  'specs.bladeMaterial',
  'specs.bladeCoating',
  'specs.lockingMechanism',
  'specs.hardness',
  'specs.overallLength',
  'specs.bladeLength',
  'specs.bladeThickness',
  'specs.handleLength',
  'specs.weight',
] as const

export type BuiltInCardField = (typeof CARD_FIELDS)[number]
export type CardField = BuiltInCardField | `custom:${string}`

export const DEFAULT_CARD_FIELDS = [
  'bladeStyle',
  'handleMaterial',
] as const satisfies readonly CardField[]

export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date'] as const

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number]

export type CustomField = {
  id: string
  name: string
  type: CustomFieldType
}

export type AppSettings = {
  theme: AppTheme
  pinnedItemsFirst: boolean
  cardFields: CardField[]
  cloudBackupLastSyncedAt: string
  cloudAutoBackupEnabled: boolean
  mcpEnabled: boolean
  mcpWriteEnabled: boolean
  customFields: CustomField[]
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  pinnedItemsFirst: true,
  cardFields: [...DEFAULT_CARD_FIELDS],
  cloudBackupLastSyncedAt: '',
  cloudAutoBackupEnabled: false,
  mcpEnabled: true,
  mcpWriteEnabled: false,
  customFields: [],
}

export function normalizeCardFields(
  value: unknown,
  fallback: readonly CardField[] = DEFAULT_CARD_FIELDS,
): CardField[] {
  if (!Array.isArray(value)) return [...fallback]

  const builtInFields = new Set<string>(CARD_FIELDS)
  const normalized: CardField[] = []
  const seen = new Set<string>()

  for (const item of value) {
    if (
      typeof item !== 'string' ||
      seen.has(item) ||
      (!builtInFields.has(item) &&
        !(item.startsWith('custom:') && item.length > 'custom:'.length))
    ) {
      continue
    }

    normalized.push(item as CardField)
    seen.add(item)
  }

  return normalized
}

export const SETTINGS_UPDATED_EVENT = 'bladevault-settings-change'
