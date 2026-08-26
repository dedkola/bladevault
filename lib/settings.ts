import { getLocalDb } from './local-db'
import {
  APP_THEMES,
  DEFAULT_CARD_FIELDS,
  CUSTOM_FIELD_TYPES,
  DEFAULT_SETTINGS,
  normalizeCardFields,
  normalizeTimeFormat,
  type AppSettings,
  type AppTheme,
  type CardField,
  type CustomField,
  type CustomFieldType,
  type TimeFormat,
} from './settings-shared'
export { DEFAULT_SETTINGS, SETTINGS_UPDATED_EVENT } from './settings-shared'
export type {
  AppSettings,
  AppTheme,
  CardField,
  CustomField,
  CustomFieldType,
  TimeFormat,
} from './settings-shared'

const SETTINGS_KEYS: Record<keyof AppSettings, string> = {
  theme: 'theme',
  timeFormat: 'time_format',
  pinnedItemsFirst: 'pinned_items_first',
  cardFields: 'card_fields',
  cloudBackupLastSyncedAt: 'cloud_backup_last_synced_at',
  cloudAutoBackupEnabled: 'cloud_auto_backup_enabled',
  mcpEnabled: 'mcp_enabled',
  mcpWriteEnabled: 'mcp_write_enabled',
  customFields: 'custom_fields',
}

function parseCardFields(value: string | undefined): CardField[] {
  if (!value) return [...DEFAULT_CARD_FIELDS]

  try {
    return normalizeCardFields(JSON.parse(value))
  } catch {
    return [...DEFAULT_CARD_FIELDS]
  }
}

function getDb() {
  return getLocalDb()
}

function parseTheme(value: string | undefined): AppTheme {
  if (value && APP_THEMES.includes(value as AppTheme)) {
    return value as AppTheme
  }

  return DEFAULT_SETTINGS.theme
}

function isCustomFieldType(value: unknown): value is CustomFieldType {
  return (
    typeof value === 'string' &&
    CUSTOM_FIELD_TYPES.includes(value as CustomFieldType)
  )
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === '1') return true
  if (value === '0') return false
  return defaultValue
}

function parseCustomFields(value: string | undefined): CustomField[] {
  if (!value) return DEFAULT_SETTINGS.customFields

  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return DEFAULT_SETTINGS.customFields

    const fields: CustomField[] = []
    for (const item of parsed) {
      if (
        item &&
        typeof item === 'object' &&
        typeof (item as Record<string, unknown>).id === 'string' &&
        typeof (item as Record<string, unknown>).name === 'string' &&
        isCustomFieldType((item as Record<string, unknown>).type)
      ) {
        fields.push({
          id: String((item as Record<string, unknown>).id),
          name: String((item as Record<string, unknown>).name),
          type: (item as Record<string, unknown>).type as CustomFieldType,
        })
      }
    }
    return fields
  } catch {
    return DEFAULT_SETTINGS.customFields
  }
}

export function getSettings(): AppSettings {
  const rows = getDb()
    .prepare('SELECT key, value FROM settings')
    .all() as Array<{ key: string; value: string }>

  const map = new Map(rows.map((row) => [row.key, row.value]))

  return {
    theme: parseTheme(map.get(SETTINGS_KEYS.theme)),
    timeFormat: normalizeTimeFormat(map.get(SETTINGS_KEYS.timeFormat)),
    pinnedItemsFirst: parseBool(
      map.get(SETTINGS_KEYS.pinnedItemsFirst),
      DEFAULT_SETTINGS.pinnedItemsFirst,
    ),
    cardFields: parseCardFields(map.get(SETTINGS_KEYS.cardFields)),
    cloudBackupLastSyncedAt:
      map.get(SETTINGS_KEYS.cloudBackupLastSyncedAt) ||
      DEFAULT_SETTINGS.cloudBackupLastSyncedAt,
    cloudAutoBackupEnabled: parseBool(
      map.get(SETTINGS_KEYS.cloudAutoBackupEnabled),
      DEFAULT_SETTINGS.cloudAutoBackupEnabled,
    ),
    mcpEnabled: parseBool(
      map.get(SETTINGS_KEYS.mcpEnabled),
      DEFAULT_SETTINGS.mcpEnabled,
    ),
    mcpWriteEnabled: parseBool(
      map.get(SETTINGS_KEYS.mcpWriteEnabled),
      DEFAULT_SETTINGS.mcpWriteEnabled,
    ),
    customFields: parseCustomFields(map.get(SETTINGS_KEYS.customFields)),
  }
}

export function saveSettings(settings: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  const next = {
    ...current,
    ...settings,
    cardFields:
      settings.cardFields === undefined
        ? current.cardFields
        : normalizeCardFields(settings.cardFields, current.cardFields),
    timeFormat: normalizeTimeFormat(settings.timeFormat, current.timeFormat),
  }

  const insert = getDb().prepare(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
  )

  const entries: Array<[keyof AppSettings, string]> = [
    ['theme', next.theme],
    ['timeFormat', next.timeFormat],
    ['pinnedItemsFirst', next.pinnedItemsFirst ? '1' : '0'],
    ['cardFields', JSON.stringify(next.cardFields)],
    ['cloudBackupLastSyncedAt', next.cloudBackupLastSyncedAt],
    ['cloudAutoBackupEnabled', next.cloudAutoBackupEnabled ? '1' : '0'],
    ['mcpEnabled', next.mcpEnabled ? '1' : '0'],
    ['mcpWriteEnabled', next.mcpWriteEnabled ? '1' : '0'],
    ['customFields', JSON.stringify(next.customFields)],
  ]

  const transaction = getDb().transaction(() => {
    for (const [key, value] of entries) {
      insert.run(SETTINGS_KEYS[key], value)
    }
  })

  transaction()
  return next
}
