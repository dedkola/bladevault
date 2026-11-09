export const APP_THEMES = ['light', 'dark'] as const
export const THEME_STYLES = [
  'classic',
  'modern',
  'alloy',
  'forge',
  'titanium',
  'field',
  'lumen',
  'amber',
] as const
/**
 * Forge, Titanium and Field reuse the Modern workspace layout and only change
 * its look. The DOM exposes them as `data-theme-style="modern"` plus a
 * `data-theme-variant`, so every Modern layout rule keeps applying.
 */
export const MODERN_THEME_VARIANTS = [
  'forge',
  'titanium',
  'field',
  'lumen',
  'amber',
] as const
/** Display names for each style, shown in Settings and under the app logo. */
export const THEME_STYLE_NAMES: Record<(typeof THEME_STYLES)[number], string> =
  {
    classic: 'Classic',
    modern: 'Modern',
    alloy: 'Alloy',
    forge: 'Forge',
    titanium: 'Titanium',
    field: 'Field',
    lumen: 'Lumen',
    amber: 'Amber',
  }
/** Styles that always render light and ignore the dark color mode. */
export const LIGHT_ONLY_THEME_STYLES = ['lumen', 'amber'] as const
export const START_PAGES = ['insights', 'studio', 'collection'] as const
export type StartPage = (typeof START_PAGES)[number]

export const TIME_FORMATS = ['12h', '24h'] as const
export const DIMENSION_UNITS = ['in', 'mm', 'both'] as const
export type DimensionUnit = (typeof DIMENSION_UNITS)[number]

export type AppTheme = (typeof APP_THEMES)[number]
export type ThemeStyle = (typeof THEME_STYLES)[number]
export type ModernThemeVariant = (typeof MODERN_THEME_VARIANTS)[number]
export type ThemeFamily = 'classic' | 'modern' | 'alloy'
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
export type CollectionColumnSort = {
  /** A collection column key, or `knife` for the name column. */
  key: string
  direction: 'asc' | 'desc'
}
export type CollectionDisplay = {
  columns: CollectionColumn[]
  columnWidths: Record<string, number>
  view: 'list' | 'grid'
  sort: 'newest' | 'model' | 'brand'
  density: 'gallery' | 'compact' | 'table'
  /** Table header sort; overrides `sort` while the table is shown. */
  columnSort: CollectionColumnSort | null
}
export const DEFAULT_COLLECTION_DISPLAY: CollectionDisplay = {
  columns: ['maker', 'steel', 'blade', 'weight', 'status'],
  columnWidths: {},
  view: 'list',
  sort: 'newest',
  density: 'gallery',
  columnSort: null,
}

function isColumnKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    (key === 'knife' ||
      (COLLECTION_COLUMNS as readonly string[]).includes(key) ||
      (key.startsWith('custom:') && key.length > 'custom:'.length))
  )
}

function normalizeColumnSort(value: unknown): CollectionColumnSort | null {
  if (!value || typeof value !== 'object') return null
  const { key, direction } = value as Partial<CollectionColumnSort>
  if (!isColumnKey(key) || (direction !== 'asc' && direction !== 'desc'))
    return null
  return { key, direction }
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
      input.density === 'gallery' ||
      input.density === 'compact' ||
      input.density === 'table'
        ? input.density
        : fallback.density,
    columnSort: !('columnSort' in input)
      ? fallback.columnSort
      : normalizeColumnSort(input.columnSort),
  }
}

export type AppSettings = {
  collectionDisplay: CollectionDisplay
  theme: AppTheme
  themeStyle: ThemeStyle
  timeFormat: TimeFormat
  dimensionUnit: DimensionUnit
  startPage: StartPage
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
  dimensionUnit: 'in',
  startPage: 'insights',
  pinnedItemsFirst: true,
  cardFields: [...DEFAULT_CARD_FIELDS],
  cloudBackupLastSyncedAt: '',
  cloudAutoBackupEnabled: false,
  mcpEnabled: true,
  mcpWriteEnabled: false,
  customFields: [],
}

export function normalizeStartPage(
  value: unknown,
  fallback: StartPage = DEFAULT_SETTINGS.startPage,
): StartPage {
  return typeof value === 'string' && START_PAGES.includes(value as StartPage)
    ? (value as StartPage)
    : fallback
}

export function normalizeThemeStyle(
  value: unknown,
  fallback: ThemeStyle = DEFAULT_SETTINGS.themeStyle,
): ThemeStyle {
  return typeof value === 'string' && THEME_STYLES.includes(value as ThemeStyle)
    ? (value as ThemeStyle)
    : fallback
}

export function getModernThemeVariant(
  themeStyle: ThemeStyle,
): ModernThemeVariant | undefined {
  return MODERN_THEME_VARIANTS.includes(themeStyle as ModernThemeVariant)
    ? (themeStyle as ModernThemeVariant)
    : undefined
}

/** Layout family for a style: Forge, Titanium and Field use Modern's layout. */
export function getThemeFamily(themeStyle: ThemeStyle): ThemeFamily {
  return getModernThemeVariant(themeStyle)
    ? 'modern'
    : (themeStyle as ThemeFamily)
}

export function isModernThemeFamily(themeStyle: ThemeStyle): boolean {
  return getThemeFamily(themeStyle) === 'modern'
}

/** Browser chrome color (meta theme-color) for each style and mode. */
export const THEME_COLORS: Record<ThemeStyle, { light: string; dark: string }> =
  {
    classic: { light: '#fcfcfb', dark: '#18150f' },
    modern: { light: '#f5f5f7', dark: '#0d0d0f' },
    alloy: { light: '#101010', dark: '#080808' },
    forge: { light: '#f3f2ef', dark: '#0a0a0b' },
    titanium: { light: '#f4f3f6', dark: '#0c0b0f' },
    field: { light: '#ecebe4', dark: '#0f100d' },
    lumen: { light: '#ffffff', dark: '#ffffff' },
    amber: { light: '#ffffff', dark: '#ffffff' },
  }

export function isLightOnlyThemeStyle(themeStyle: ThemeStyle): boolean {
  return (LIGHT_ONLY_THEME_STYLES as readonly ThemeStyle[]).includes(themeStyle)
}

/** Whether the root should carry the `dark` class for a mode and style. */
export function isDarkThemeActive(
  theme: AppTheme,
  themeStyle: ThemeStyle,
): boolean {
  return theme === 'dark' && !isLightOnlyThemeStyle(themeStyle)
}

/**
 * Records the chosen color mode on the root and applies the `dark` class.
 * Light-only styles keep the saved mode but render light.
 */
export function applyThemeModeToElement(element: HTMLElement, theme: AppTheme) {
  element.dataset.themeMode = theme
  element.classList.toggle(
    'dark',
    isDarkThemeActive(theme, readThemeStyleFromElement(element)),
  )
}

/** Writes the theme style to the root element's data attributes. */
export function applyThemeStyleToElement(
  element: HTMLElement,
  themeStyle: ThemeStyle,
) {
  element.dataset.themeStyle = getThemeFamily(themeStyle)
  const variant = getModernThemeVariant(themeStyle)
  if (variant) element.dataset.themeVariant = variant
  else delete element.dataset.themeVariant
  // Re-apply the saved mode: a light-only style drops the `dark` class.
  const mode = element.dataset.themeMode
  if (mode === 'light' || mode === 'dark') {
    element.classList.toggle('dark', isDarkThemeActive(mode, themeStyle))
  }
}

/** Reads the theme style back from the root element's data attributes. */
export function readThemeStyleFromElement(element: HTMLElement): ThemeStyle {
  return normalizeThemeStyle(
    element.dataset.themeVariant ?? element.dataset.themeStyle,
  )
}

export function normalizeTimeFormat(
  value: unknown,
  fallback: TimeFormat = DEFAULT_SETTINGS.timeFormat,
): TimeFormat {
  return typeof value === 'string' && TIME_FORMATS.includes(value as TimeFormat)
    ? (value as TimeFormat)
    : fallback
}

export function normalizeDimensionUnit(
  value: unknown,
  fallback: DimensionUnit = DEFAULT_SETTINGS.dimensionUnit,
): DimensionUnit {
  return typeof value === 'string' &&
    DIMENSION_UNITS.includes(value as DimensionUnit)
    ? (value as DimensionUnit)
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
