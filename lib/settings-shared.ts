export const APP_THEMES = ['light', 'dark'] as const
export const THEME_STYLES = ['classic', 'modern'] as const
export const TIME_FORMATS = ['12h', '24h'] as const

export type AppTheme = (typeof APP_THEMES)[number]
export type ThemeStyle = (typeof THEME_STYLES)[number]
export type TimeFormat = (typeof TIME_FORMATS)[number]

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

export const COLLECTION_COLUMNS = [
  'maker',
  'steel',
  'blade',
  'weight',
  'status',
  'name',
  'modelNumber',
  'designer',
  'country',
  'price',
  'bladeStyle',
  'bladeCoating',
  'hardness',
  'lockingMechanism',
  'handleMaterial',
  'handleLength',
  'overallLength',
  'bladeThickness',
  'description',
  'sourceUrl',
  'pinned',
  'sold',
  'addedAt',
  'updatedAt',
  'images',
] as const
export type CollectionColumn =
  (typeof COLLECTION_COLUMNS)[number] | `custom:${string}`
export type CollectionDisplay = {
  columns: CollectionColumn[]
  columnWidths: Record<string, number>
  view: 'list' | 'grid'
  sort: 'newest' | 'model' | 'brand'
  density: 'gallery' | 'compact'
}
export const DEFAULT_COLLECTION_DISPLAY: CollectionDisplay = {
  columns: ['maker', 'steel', 'blade', 'weight', 'status'],
  columnWidths: {},
  view: 'list',
  sort: 'newest',
  density: 'gallery',
}

export function normalizeCollectionDisplay(
  value: unknown,
  fallback: CollectionDisplay = DEFAULT_COLLECTION_DISPLAY,
): CollectionDisplay {
  const input =
    value && typeof value === 'object'
      ? (value as Partial<CollectionDisplay>)
      : {}
  return {
    columns: Array.isArray(input.columns)
      ? [
          ...new Set(
            input.columns.filter(
              (column): column is CollectionColumn =>
                typeof column === 'string' &&
                ((COLLECTION_COLUMNS as readonly string[]).includes(column) ||
                  (column.startsWith('custom:') &&
                    column.length > 'custom:'.length)),
            ),
          ),
        ]
      : [...fallback.columns],
    columnWidths:
      input.columnWidths &&
      typeof input.columnWidths === 'object' &&
      !Array.isArray(input.columnWidths)
        ? Object.fromEntries(
            Object.entries(input.columnWidths)
              .filter(
                ([key, width]) =>
                  (key === 'knife' ||
                    (COLLECTION_COLUMNS as readonly string[]).includes(key) ||
                    (key.startsWith('custom:') && key.length > 7)) &&
                  typeof width === 'number' &&
                  Number.isFinite(width),
              )
              .map(([key, width]) => [
                key,
                Math.round(
                  Math.min(800, Math.max(key === 'knife' ? 140 : 48, width)),
                ),
              ]),
          )
        : { ...fallback.columnWidths },
    view:
      input.view === 'list' || input.view === 'grid'
        ? input.view
        : fallback.view,
    sort:
      input.sort === 'newest' ||
      input.sort === 'model' ||
      input.sort === 'brand'
        ? input.sort
        : fallback.sort,
    density:
      input.density === 'gallery' || input.density === 'compact'
        ? input.density
        : fallback.density,
  }
}

export type AppSettings = {
  collectionDisplay: CollectionDisplay
  theme: AppTheme
  themeStyle: ThemeStyle
  timeFormat: TimeFormat
  pinnedItemsFirst: boolean
  cardFields: CardField[]
  cloudBackupLastSyncedAt: string
  cloudAutoBackupEnabled: boolean
  mcpEnabled: boolean
  mcpWriteEnabled: boolean
  customFields: CustomField[]
}

export const DEFAULT_SETTINGS: AppSettings = {
  collectionDisplay: DEFAULT_COLLECTION_DISPLAY,
  theme: 'light',
  themeStyle: 'classic',
  timeFormat: '12h',
  pinnedItemsFirst: true,
  cardFields: [...DEFAULT_CARD_FIELDS],
  cloudBackupLastSyncedAt: '',
  cloudAutoBackupEnabled: false,
  mcpEnabled: true,
  mcpWriteEnabled: false,
  customFields: [],
}

export function normalizeThemeStyle(
  value: unknown,
  fallback: ThemeStyle = DEFAULT_SETTINGS.themeStyle,
): ThemeStyle {
  return typeof value === 'string' && THEME_STYLES.includes(value as ThemeStyle)
    ? (value as ThemeStyle)
    : fallback
}

export function normalizeTimeFormat(
  value: unknown,
  fallback: TimeFormat = DEFAULT_SETTINGS.timeFormat,
): TimeFormat {
  return typeof value === 'string' && TIME_FORMATS.includes(value as TimeFormat)
    ? (value as TimeFormat)
    : fallback
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
