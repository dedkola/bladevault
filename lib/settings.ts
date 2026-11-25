import { withVaultWriteSync } from '@/lib/vault-access'
import { getLocalDb } from './local-db'
import { forgetAchievementBaseline } from '@/lib/achievements/store'
import {
  APP_THEMES,
  normalizeCollectionDisplay,
  DEFAULT_CARD_FIELDS,
  DEFAULT_PINNED_CARD_FIELDS,
  CUSTOM_FIELD_TYPES,
  DEFAULT_SETTINGS,
  normalizeCardFields,
  normalizeStartPage,
  normalizeThemeStyle,
  normalizeTimeFormat,
  normalizeDimensionUnit,
  normalizeMaintenanceReminders,
  normalizeCareDeferrals,
  normalizeCareIntervalOverrides,
  normalizePriceMonitoring,
  normalizeAchievementSettings,
  normalizeBackupNotificationSettings,
  normalizePopupNotificationSettings,
  normalizeKnifeDetailPanelWidth,
  normalizeImageHostList,
  type AppSettings,
  type AppTheme,
  type CardField,
  type CustomField,
  type CustomFieldType,
  type ThemeStyle,
} from './settings-shared'
export { DEFAULT_SETTINGS, SETTINGS_UPDATED_EVENT } from './settings-shared'
export type {
  AppSettings,
  AppTheme,
  CardField,
  CustomField,
  CustomFieldType,
  ThemeStyle,
  TimeFormat,
  DimensionUnit,
} from './settings-shared'

const SETTINGS_KEYS: Record<keyof AppSettings, string> = {
  collectionDisplay: 'collection_display',
  theme: 'theme',
  themeStyle: 'theme_style',
  timeFormat: 'time_format',
  dimensionUnit: 'dimension_unit',
  startPage: 'start_page',
  pinnedItemsFirst: 'pinned_items_first',
  cardFields: 'card_fields',
  pinnedCardFields: 'pinned_card_fields',
  driveAutoBackupEnabled: 'drive_auto_backup_enabled',
  mcpEnabled: 'mcp_enabled',
  mcpWriteEnabled: 'mcp_write_enabled',
  mcpImageHostAllowlistEnabled: 'mcp_image_host_allowlist_enabled',
  mcpImageHostAllowlist: 'mcp_image_host_allowlist',
  customFields: 'custom_fields',
  maintenanceReminders: 'maintenance_reminders',
  careIntervalOverrides: 'care_interval_overrides',
  careDeferrals: 'care_deferrals',
  priceMonitoring: 'price_monitoring',
  achievements: 'achievements',
  backupNotifications: 'backup_notifications',
  popupNotifications: 'popup_notifications',
  knifeDetailPanelWidth: 'knife_detail_panel_width',
}

function parseMaintenanceReminders(value: string | undefined) {
  try {
    return normalizeMaintenanceReminders(value ? JSON.parse(value) : undefined)
  } catch {
    return normalizeMaintenanceReminders(undefined)
  }
}

function parseBackupNotificationSettings(value: string | undefined) {
  try {
    return normalizeBackupNotificationSettings(
      value ? JSON.parse(value) : undefined,
    )
  } catch {
    return normalizeBackupNotificationSettings(undefined)
  }
}

function parsePopupNotificationSettings(value: string | undefined) {
  try {
    return normalizePopupNotificationSettings(
      value ? JSON.parse(value) : undefined,
    )
  } catch {
    return normalizePopupNotificationSettings(undefined)
  }
}

function parseAchievementSettings(value: string | undefined) {
  try {
    return normalizeAchievementSettings(value ? JSON.parse(value) : undefined)
  } catch {
    return normalizeAchievementSettings(undefined)
  }
}

function parseCareIntervalOverrides(value: string | undefined) {
  try {
    return normalizeCareIntervalOverrides(value ? JSON.parse(value) : undefined)
  } catch {
    return {}
  }
}

function parseCareDeferrals(value: string | undefined) {
  try {
    return normalizeCareDeferrals(value ? JSON.parse(value) : undefined)
  } catch {
    return {}
  }
}

function parsePriceMonitoring(value: string | undefined) {
  try {
    return normalizePriceMonitoring(value ? JSON.parse(value) : undefined)
  } catch {
    return normalizePriceMonitoring(undefined)
  }
}

function parseCardFields(value: string | undefined): CardField[] {
  if (!value) return [...DEFAULT_CARD_FIELDS]

  try {
    return normalizeCardFields(JSON.parse(value))
  } catch {
    return [...DEFAULT_CARD_FIELDS]
  }
}

function parsePinnedCardFields(value: string | undefined): CardField[] {
  if (!value) return [...DEFAULT_PINNED_CARD_FIELDS]

  try {
    return normalizeCardFields(JSON.parse(value), DEFAULT_PINNED_CARD_FIELDS)
  } catch {
    return [...DEFAULT_PINNED_CARD_FIELDS]
  }
}

function parseCollectionDisplay(value: string | undefined) {
  try {
    return normalizeCollectionDisplay(value ? JSON.parse(value) : undefined)
  } catch {
    return normalizeCollectionDisplay(undefined)
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

function parseThemeStyle(value: string | undefined): ThemeStyle {
  return normalizeThemeStyle(value)
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

function parseImageHostList(value: string | undefined): string[] {
  if (!value) return DEFAULT_SETTINGS.mcpImageHostAllowlist
  try {
    return normalizeImageHostList(JSON.parse(value))
  } catch {
    return DEFAULT_SETTINGS.mcpImageHostAllowlist
  }
}

export function getSettings(): AppSettings {
  const rows = getDb()
    .prepare('SELECT key, value FROM settings')
    .all() as Array<{ key: string; value: string }>

  const map = new Map(rows.map((row) => [row.key, row.value]))

  return {
    collectionDisplay: parseCollectionDisplay(
      map.get(SETTINGS_KEYS.collectionDisplay),
    ),
    theme: parseTheme(map.get(SETTINGS_KEYS.theme)),
    themeStyle: parseThemeStyle(map.get(SETTINGS_KEYS.themeStyle)),
    timeFormat: normalizeTimeFormat(map.get(SETTINGS_KEYS.timeFormat)),
    dimensionUnit: normalizeDimensionUnit(map.get(SETTINGS_KEYS.dimensionUnit)),
    startPage: normalizeStartPage(map.get(SETTINGS_KEYS.startPage)),
    pinnedItemsFirst: parseBool(
      map.get(SETTINGS_KEYS.pinnedItemsFirst),
      DEFAULT_SETTINGS.pinnedItemsFirst,
    ),
    cardFields: parseCardFields(map.get(SETTINGS_KEYS.cardFields)),
    pinnedCardFields: parsePinnedCardFields(
      map.get(SETTINGS_KEYS.pinnedCardFields),
    ),
    driveAutoBackupEnabled: parseBool(
      map.get(SETTINGS_KEYS.driveAutoBackupEnabled),
      DEFAULT_SETTINGS.driveAutoBackupEnabled,
    ),
    mcpEnabled: parseBool(
      map.get(SETTINGS_KEYS.mcpEnabled),
      DEFAULT_SETTINGS.mcpEnabled,
    ),
    mcpWriteEnabled: parseBool(
      map.get(SETTINGS_KEYS.mcpWriteEnabled),
      DEFAULT_SETTINGS.mcpWriteEnabled,
    ),
    mcpImageHostAllowlistEnabled: parseBool(
      map.get(SETTINGS_KEYS.mcpImageHostAllowlistEnabled),
      DEFAULT_SETTINGS.mcpImageHostAllowlistEnabled,
    ),
    mcpImageHostAllowlist: parseImageHostList(
      map.get(SETTINGS_KEYS.mcpImageHostAllowlist),
    ),
    customFields: parseCustomFields(map.get(SETTINGS_KEYS.customFields)),
    maintenanceReminders: parseMaintenanceReminders(
      map.get(SETTINGS_KEYS.maintenanceReminders),
    ),
    careIntervalOverrides: parseCareIntervalOverrides(
      map.get(SETTINGS_KEYS.careIntervalOverrides),
    ),
    careDeferrals: parseCareDeferrals(map.get(SETTINGS_KEYS.careDeferrals)),
    priceMonitoring: parsePriceMonitoring(
      map.get(SETTINGS_KEYS.priceMonitoring),
    ),
    achievements: parseAchievementSettings(map.get(SETTINGS_KEYS.achievements)),
    backupNotifications: parseBackupNotificationSettings(
      map.get(SETTINGS_KEYS.backupNotifications),
    ),
    popupNotifications: parsePopupNotificationSettings(
      map.get(SETTINGS_KEYS.popupNotifications),
    ),
    knifeDetailPanelWidth: normalizeKnifeDetailPanelWidth(
      map.get(SETTINGS_KEYS.knifeDetailPanelWidth) || undefined,
    ),
  }
}

export function saveSettings(settings: Partial<AppSettings>): AppSettings {
  return withVaultWriteSync(() => {
    const current = getSettings()
    const next = {
      ...current,
      ...settings,
      collectionDisplay: normalizeCollectionDisplay(
        settings.collectionDisplay,
        current.collectionDisplay,
      ),
      cardFields:
        settings.cardFields === undefined
          ? current.cardFields
          : normalizeCardFields(settings.cardFields, current.cardFields),
      pinnedCardFields:
        settings.pinnedCardFields === undefined
          ? current.pinnedCardFields
          : normalizeCardFields(
              settings.pinnedCardFields,
              current.pinnedCardFields,
            ),
      themeStyle: normalizeThemeStyle(settings.themeStyle, current.themeStyle),
      timeFormat: normalizeTimeFormat(settings.timeFormat, current.timeFormat),
      dimensionUnit: normalizeDimensionUnit(
        settings.dimensionUnit,
        current.dimensionUnit,
      ),
      startPage: normalizeStartPage(settings.startPage, current.startPage),
      mcpImageHostAllowlist:
        settings.mcpImageHostAllowlist === undefined
          ? current.mcpImageHostAllowlist
          : normalizeImageHostList(settings.mcpImageHostAllowlist),
      maintenanceReminders:
        settings.maintenanceReminders === undefined
          ? current.maintenanceReminders
          : normalizeMaintenanceReminders(
              settings.maintenanceReminders,
              current.maintenanceReminders,
            ),
      careIntervalOverrides:
        settings.careIntervalOverrides === undefined
          ? current.careIntervalOverrides
          : normalizeCareIntervalOverrides(settings.careIntervalOverrides),
      careDeferrals:
        settings.careDeferrals === undefined
          ? current.careDeferrals
          : normalizeCareDeferrals(settings.careDeferrals),
      priceMonitoring:
        settings.priceMonitoring === undefined
          ? current.priceMonitoring
          : normalizePriceMonitoring(
              settings.priceMonitoring,
              current.priceMonitoring,
            ),
      achievements:
        settings.achievements === undefined
          ? current.achievements
          : normalizeAchievementSettings(
              settings.achievements,
              current.achievements,
            ),
      backupNotifications:
        settings.backupNotifications === undefined
          ? current.backupNotifications
          : normalizeBackupNotificationSettings(
              settings.backupNotifications,
              current.backupNotifications,
            ),
      popupNotifications:
        settings.popupNotifications === undefined
          ? current.popupNotifications
          : normalizePopupNotificationSettings(
              settings.popupNotifications,
              current.popupNotifications,
            ),
      knifeDetailPanelWidth:
        settings.knifeDetailPanelWidth === undefined
          ? current.knifeDetailPanelWidth
          : normalizeKnifeDetailPanelWidth(
              settings.knifeDetailPanelWidth,
              current.knifeDetailPanelWidth,
            ),
    }

    const insert = getDb().prepare(
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
    )

    const entries: Array<[keyof AppSettings, string]> = [
      ['collectionDisplay', JSON.stringify(next.collectionDisplay)],
      ['theme', next.theme],
      ['themeStyle', next.themeStyle],
      ['timeFormat', next.timeFormat],
      ['dimensionUnit', next.dimensionUnit],
      ['startPage', next.startPage],
      ['pinnedItemsFirst', next.pinnedItemsFirst ? '1' : '0'],
      ['cardFields', JSON.stringify(next.cardFields)],
      ['pinnedCardFields', JSON.stringify(next.pinnedCardFields)],
      ['driveAutoBackupEnabled', next.driveAutoBackupEnabled ? '1' : '0'],
      ['mcpEnabled', next.mcpEnabled ? '1' : '0'],
      ['mcpWriteEnabled', next.mcpWriteEnabled ? '1' : '0'],
      [
        'mcpImageHostAllowlistEnabled',
        next.mcpImageHostAllowlistEnabled ? '1' : '0',
      ],
      ['mcpImageHostAllowlist', JSON.stringify(next.mcpImageHostAllowlist)],
      ['customFields', JSON.stringify(next.customFields)],
      ['maintenanceReminders', JSON.stringify(next.maintenanceReminders)],
      ['careIntervalOverrides', JSON.stringify(next.careIntervalOverrides)],
      ['careDeferrals', JSON.stringify(next.careDeferrals)],
      ['priceMonitoring', JSON.stringify(next.priceMonitoring)],
      ['achievements', JSON.stringify(next.achievements)],
      ['backupNotifications', JSON.stringify(next.backupNotifications)],
      ['popupNotifications', JSON.stringify(next.popupNotifications)],
      [
        'knifeDetailPanelWidth',
        next.knifeDetailPanelWidth === null
          ? 'null'
          : String(next.knifeDetailPanelWidth),
      ],
    ]

    const transaction = getDb().transaction(() => {
      for (const [key, value] of entries) {
        insert.run(SETTINGS_KEYS[key], value)
      }
      if (!current.achievements.enabled && next.achievements.enabled) {
        forgetAchievementBaseline(getDb())
      }
    })

    transaction()
    return next
  })
}
