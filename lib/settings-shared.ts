export const APP_THEMES = ['light', 'dark'] as const
export const THEME_STYLES = [
  'classic',
  'modern',
  'alloy',
  'forge',
  'titanium',
  'field',
  'lumen',
  'espresso',
  'phosphor',
  'atrium',
  'shelf',
  'ledger',
] as const
/**
 * Forge, Titanium, Field, Lumen, Espresso, Phosphor and Atrium reuse the
 * Modern workspace layout (Atrium with its own shell) and only change its look. The DOM exposes them as `data-theme-style="modern"` plus a
 * `data-theme-variant`, so every Modern layout rule keeps applying.
 */
export const MODERN_THEME_VARIANTS = [
  'forge',
  'titanium',
  'field',
  'lumen',
  'espresso',
  'phosphor',
  'atrium',
  'shelf',
  'ledger',
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
    espresso: 'Espresso',
    phosphor: 'Phosphor',
    atrium: 'Atrium',
    shelf: 'Shelf',
    ledger: 'Ledger',
  }
/** Styles that always render light and ignore the dark color mode. */
export const LIGHT_ONLY_THEME_STYLES = ['lumen', 'espresso', 'atrium'] as const
/**
 * Styles that use Lumen's white, grey and orange palette. Lumen itself keeps
 * the Modern layout; the others bring their own shell. The root carries
 * `data-theme-palette="lumen"` so the Lumen colors apply to all of them.
 */
export const LUMEN_PALETTE_THEME_STYLES = ['lumen', 'atrium'] as const
/** Styles that always render dark and ignore the light color mode. */
export const DARK_ONLY_THEME_STYLES = ['phosphor'] as const
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

/**
 * Styles the footer's theme quick switcher cycles through: every style, in
 * the order Modern, its variants, Classic, Alloy.
 */
export const QUICK_SWITCH_THEME_STYLES: readonly ThemeStyle[] = [
  'modern',
  ...MODERN_THEME_VARIANTS,
  'classic',
  'alloy',
]

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
  'care',
] as const

export type BuiltInCardField = (typeof CARD_FIELDS)[number]
export type CardField = BuiltInCardField | `custom:${string}`

export const DEFAULT_CARD_FIELDS = [
  'bladeStyle',
  'handleMaterial',
] as const satisfies readonly CardField[]

export const DEFAULT_PINNED_CARD_FIELDS = [
  'specs.bladeMaterial',
  'specs.bladeLength',
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
  'care',
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

/** Maintenance types that carry a reminder interval. */
export const CARE_TRACKS = ['sharpening', 'cleaning', 'lubrication'] as const
export type CareTrack = (typeof CARE_TRACKS)[number]

export const CARE_TRACK_NAMES: Record<CareTrack, string> = {
  sharpening: 'Sharpening',
  cleaning: 'Cleaning',
  lubrication: 'Lubrication',
}

/** Short imperative verb for badges: "Sharpen overdue · 4d". */
export const CARE_TRACK_VERBS: Record<CareTrack, string> = {
  sharpening: 'Sharpen',
  cleaning: 'Clean',
  lubrication: 'Lube',
}

/** Past participle for missing-care labels: "Not yet cleaned or lubed". */
export const CARE_TRACK_PAST: Record<CareTrack, string> = {
  sharpening: 'sharpened',
  cleaning: 'cleaned',
  lubrication: 'lubed',
}

export type MaintenanceReminderSettings = {
  /** Master switch for badges, the care filter and the Insights card. */
  enabled: boolean
  /** Days between events per track; null switches the track off. */
  intervals: Record<CareTrack, number | null>
  /** Days before the deadline a knife turns "due soon". */
  dueSoonDays: number
  /** A stropping entry resets the sharpening timer. */
  stroppingCountsAsSharpening: boolean
  skipSoldKnives: boolean
}

export const DEFAULT_MAINTENANCE_REMINDERS: MaintenanceReminderSettings = {
  enabled: true,
  intervals: { sharpening: 90, cleaning: 60, lubrication: 180 },
  dueSoonDays: 14,
  stroppingCountsAsSharpening: true,
  skipSoldKnives: true,
}

export const CARE_INTERVAL_MAX_DAYS = 3650

/**
 * Per-knife interval overrides, keyed by knife id. A missing track falls back
 * to the global interval; an explicit null switches that track off for the
 * knife.
 */
export type CareIntervalOverrides = Record<
  string,
  Partial<Record<CareTrack, number | null>>
>

/**
 * Care the user pushed back, keyed by knife id and then track. `until` is the
 * local date (YYYY-MM-DD) the job is rescheduled to; `after` is the latest
 * logged date of that care when it was pushed back, so logging the care again
 * retires the deferral.
 */
export type CareDeferral = { until: string; after: string }
export type CareDeferrals = Record<
  string,
  Partial<Record<CareTrack, CareDeferral>>
>

function normalizeCareIntervalDays(value: unknown): number | null | undefined {
  if (value === null) return null
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 1 &&
    value <= CARE_INTERVAL_MAX_DAYS
  ) {
    return Math.round(value)
  }
  return undefined
}

export function normalizeMaintenanceReminders(
  value: unknown,
  fallback: MaintenanceReminderSettings = DEFAULT_MAINTENANCE_REMINDERS,
): MaintenanceReminderSettings {
  if (!value || typeof value !== 'object') {
    return {
      ...fallback,
      intervals: { ...fallback.intervals },
    }
  }
  const record = value as Record<string, unknown>
  const intervalsInput =
    record.intervals && typeof record.intervals === 'object'
      ? (record.intervals as Record<string, unknown>)
      : {}
  const intervals = {} as Record<CareTrack, number | null>
  for (const track of CARE_TRACKS) {
    const normalized =
      track in intervalsInput
        ? normalizeCareIntervalDays(intervalsInput[track])
        : undefined
    intervals[track] =
      normalized === undefined ? fallback.intervals[track] : normalized
  }
  const dueSoonDays =
    typeof record.dueSoonDays === 'number' &&
    Number.isFinite(record.dueSoonDays) &&
    record.dueSoonDays >= 0 &&
    record.dueSoonDays <= 365
      ? Math.round(record.dueSoonDays)
      : fallback.dueSoonDays
  const bool = (key: keyof MaintenanceReminderSettings) =>
    typeof record[key] === 'boolean'
      ? (record[key] as boolean)
      : (fallback[key] as boolean)
  return {
    enabled: bool('enabled'),
    intervals,
    dueSoonDays,
    stroppingCountsAsSharpening: bool('stroppingCountsAsSharpening'),
    skipSoldKnives: bool('skipSoldKnives'),
  }
}

export function normalizeCareIntervalOverrides(
  value: unknown,
): CareIntervalOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const overrides: CareIntervalOverrides = {}
  for (const [knifeId, entry] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!knifeId || !entry || typeof entry !== 'object') continue
    const tracks: Partial<Record<CareTrack, number | null>> = {}
    for (const track of CARE_TRACKS) {
      if (!(track in (entry as Record<string, unknown>))) continue
      const normalized = normalizeCareIntervalDays(
        (entry as Record<string, unknown>)[track],
      )
      if (normalized !== undefined) tracks[track] = normalized
    }
    if (Object.keys(tracks).length > 0) overrides[knifeId] = tracks
  }
  return overrides
}

export function normalizeCareDeferrals(value: unknown): CareDeferrals {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const deferrals: CareDeferrals = {}
  for (const [knifeId, entry] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!knifeId || !entry || typeof entry !== 'object') continue
    const tracks: Partial<Record<CareTrack, CareDeferral>> = {}
    for (const track of CARE_TRACKS) {
      const item = (entry as Record<string, unknown>)[track]
      if (!item || typeof item !== 'object') continue
      const { until, after } = item as Record<string, unknown>
      if (
        typeof until === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(until) &&
        typeof after === 'string'
      ) {
        tracks[track] = { until, after }
      }
    }
    if (Object.keys(tracks).length > 0) deferrals[knifeId] = tracks
  }
  return deferrals
}

export const PRICE_SCHEDULE_MODES = [
  'daily',
  'twice_daily',
  'every_12h',
  'custom',
] as const
export type PriceScheduleMode = (typeof PRICE_SCHEDULE_MODES)[number]

/** [startHour, endHour) in server local time; start > end wraps midnight. */
export type ActiveHours = [number, number]

export type PriceMonitoringSettings = {
  /** Scheduled checks; Check now works either way. */
  enabled: boolean
  /** Auto mode skips sold knives; Always monitor still covers them. */
  skipSoldKnives: boolean
  /** Target frequency per source; the queue spreads checks across it. */
  schedule: {
    mode: PriceScheduleMode
    /** Custom mode only, 1–168. */
    intervalHours: number
    /** Null: around the clock (Twice daily defaults to 8–22). */
    activeHours: ActiveHours | null
  }
  /** Per-store limits; different stores are checked in parallel. */
  pacing: {
    /** Floor between two checks at one store; raised automatically. */
    minGapSeconds: number
    amazonMinGapSeconds: number
  }
  /** Which detected changes create an Inbox notification. */
  notify: PriceNotifyCategories
  /**
   * Price changes notify when they move by at least `minPercent` of the
   * previous price; 0 notifies on every price change. Stock changes ignore
   * the threshold.
   */
  thresholds: {
    /** Percent of the previous price, 0–100. */
    minPercent: number
  }
  /** Optional OpenAI-compatible AI; monitoring works without it. */
  ai: PriceAiSettings
  /** AI looks for monitored knives on other stores (needs AI connected). */
  otherStores: PriceOtherStoresSettings
}

/** Marketplaces AI can search for monitored knives. */
export const AMAZON_MARKETPLACES = [
  'amazon.com',
  'amazon.ca',
  'amazon.co.uk',
  'amazon.de',
  'amazon.fr',
  'amazon.it',
  'amazon.es',
  'amazon.nl',
  'amazon.se',
  'amazon.pl',
  'amazon.com.au',
  'amazon.co.jp',
] as const
export type AmazonMarketplace = (typeof AMAZON_MARKETPLACES)[number]

/** Stores AI can search; Amazon first, more can join the list later. */
export const OTHER_STORE_IDS = ['amazon'] as const
export type OtherStoreId = (typeof OTHER_STORE_IDS)[number]

export type PriceOtherStoresSettings = {
  /** Let AI find, verify and add monitored knives on the stores below. */
  enabled: boolean
  stores: Record<OtherStoreId, boolean>
  amazonMarketplace: AmazonMarketplace
}

/**
 * The API key is not part of these settings: it lives in a private file in
 * the vault's control folder (never in backups), see price-monitor/secrets.
 */
export type PriceAiSettings = {
  enabled: boolean
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 or a local Ollama. */
  baseUrl: string
  /** Model id from Discover models, or typed. */
  model: string
  /**
   * Extra HTTP headers sent with every AI request, for gateways that route
   * by header (e.g. OpenCode Go's `x-opencode-session`). Not a secret store:
   * put keys in the API key field.
   */
  headers: Record<string, string>
  /** Read the price with AI when the page parsers find none. */
  extractionFallback: boolean
  /** Let AI review store pacing (statistics and store host names only). */
  advisor: boolean
  /**
   * Let AI solve failed checks: work the page in the monitoring browser to
   * reach the price (price-monitor/solver) and choose how to recover from
   * errors within fixed limits (price-monitor/troubleshoot).
   */
  resolveErrors: boolean
  /** The model reads images: the solver may read a price from a screenshot. */
  vision: boolean
}

export type PriceNotifyCategories = {
  drop: boolean
  increase: boolean
  outOfStock: boolean
  backInStock: boolean
}

export const PRICE_MONITORING_LIMITS = {
  intervalHours: [1, 168],
  minGapSeconds: [30, 3600],
  amazonMinGapSeconds: [60, 21_600],
  minPercent: [0, 100],
} as const

export const DEFAULT_PRICE_MONITORING: PriceMonitoringSettings = {
  enabled: true,
  skipSoldKnives: true,
  schedule: { mode: 'daily', intervalHours: 24, activeHours: null },
  pacing: { minGapSeconds: 60, amazonMinGapSeconds: 300 },
  notify: { drop: true, increase: false, outOfStock: false, backInStock: true },
  thresholds: { minPercent: 5 },
  ai: {
    enabled: false,
    baseUrl: '',
    model: '',
    headers: {},
    extractionFallback: true,
    advisor: true,
    resolveErrors: true,
    vision: false,
  },
  otherStores: {
    enabled: false,
    stores: { amazon: true },
    amazonMarketplace: 'amazon.com',
  },
}

export const PRICE_AI_LIMITS = {
  baseUrlLength: 500,
  modelLength: 200,
  headerCount: 20,
  headerNameLength: 100,
  headerValueLength: 1000,
} as const

/**
 * Headers BladeVault sets itself or that HTTP manages; custom headers may not
 * replace them (the key belongs in the API key field).
 */
const RESERVED_AI_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'host',
  'content-length',
  'content-type',
  'connection',
  'transfer-encoding',
  'cookie',
])

/**
 * Custom AI request headers from a JSON object of string values. Returns
 * the cleaned headers, or an error message for the settings field.
 */
export function parseAiHeaders(
  value: unknown,
):
  { ok: true; headers: Record<string, string> } | { ok: false; error: string } {
  let record: unknown = value
  if (typeof value === 'string') {
    if (!value.trim()) return { ok: true, headers: {} }
    try {
      record = JSON.parse(value)
    } catch {
      return {
        ok: false,
        error: 'Enter a JSON object, e.g. {"X-Org": "acme"}.',
      }
    }
  }
  if (!record || typeof record !== 'object' || Array.isArray(record))
    return { ok: false, error: 'Enter a JSON object, e.g. {"X-Org": "acme"}.' }
  const entries = Object.entries(record as Record<string, unknown>)
  if (entries.length > PRICE_AI_LIMITS.headerCount)
    return {
      ok: false,
      error: `Use at most ${PRICE_AI_LIMITS.headerCount} headers.`,
    }
  const headers: Record<string, string> = {}
  const seen = new Set<string>()
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim()
    if (
      !name ||
      name.length > PRICE_AI_LIMITS.headerNameLength ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
    )
      return { ok: false, error: `"${rawName}" is not a valid header name.` }
    const lower = name.toLowerCase()
    if (RESERVED_AI_HEADERS.has(lower))
      return {
        ok: false,
        error:
          lower === 'authorization'
            ? 'Put the key in the API key field instead of an Authorization header.'
            : `BladeVault sets ${name} itself.`,
      }
    if (seen.has(lower))
      return { ok: false, error: `${name} appears more than once.` }
    seen.add(lower)
    if (typeof rawValue !== 'string')
      return { ok: false, error: `The value of ${name} must be a string.` }
    const text = rawValue.trim()
    if (
      text.length > PRICE_AI_LIMITS.headerValueLength ||
      /[\u0000-\u001f\u007f]/.test(text) ||
      // fetch only sends Latin-1 header values.
      /[^\u0000-\u00ff]/.test(text)
    )
      return { ok: false, error: `The value of ${name} is not allowed.` }
    headers[name] = text
  }
  return { ok: true, headers }
}

/** Headers as shown in the settings field: compact JSON, empty when none. */
export function formatAiHeaders(headers: Record<string, string>): string {
  return Object.keys(headers).length ? JSON.stringify(headers) : ''
}

/**
 * An http(s) base URL without credentials, query or fragment, and without a
 * trailing slash; null when it is not usable. Local addresses are allowed on
 * purpose (Ollama, LM Studio).
 */
export function normalizeAiBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > PRICE_AI_LIMITS.baseUrlLength) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password || url.search || url.hash) return null
  return url.toString().replace(/\/+$/, '')
}

/** A model id: printable, without spaces at either end. */
export function normalizeAiModel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length > PRICE_AI_LIMITS.modelLength) return null
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null
  return trimmed
}

function headersOrFallback(
  value: unknown,
  fallback: Record<string, string>,
): Record<string, string> {
  if (value === undefined) return { ...fallback }
  const parsed = parseAiHeaders(value)
  return parsed.ok ? parsed.headers : { ...fallback }
}

function normalizePriceAi(
  value: unknown,
  fallback: PriceAiSettings,
): PriceAiSettings {
  const record = plainObject(value)
  const flag = (
    key:
      'enabled' | 'extractionFallback' | 'advisor' | 'resolveErrors' | 'vision',
  ) =>
    typeof record[key] === 'boolean' ? (record[key] as boolean) : fallback[key]
  let baseUrl = fallback.baseUrl
  if (typeof record.baseUrl === 'string')
    baseUrl = record.baseUrl.trim()
      ? (normalizeAiBaseUrl(record.baseUrl) ?? fallback.baseUrl)
      : ''
  return {
    enabled: flag('enabled'),
    baseUrl,
    model: normalizeAiModel(record.model) ?? fallback.model,
    headers: headersOrFallback(record.headers, fallback.headers),
    extractionFallback: flag('extractionFallback'),
    advisor: flag('advisor'),
    resolveErrors: flag('resolveErrors'),
    vision: flag('vision'),
  }
}

function normalizeOtherStores(
  value: unknown,
  fallback: PriceOtherStoresSettings,
): PriceOtherStoresSettings {
  const record = plainObject(value)
  const stores = plainObject(record.stores)
  return {
    enabled:
      typeof record.enabled === 'boolean' ? record.enabled : fallback.enabled,
    stores: Object.fromEntries(
      OTHER_STORE_IDS.map((id) => [
        id,
        typeof stores[id] === 'boolean' ? stores[id] : fallback.stores[id],
      ]),
    ) as Record<OtherStoreId, boolean>,
    amazonMarketplace: (AMAZON_MARKETPLACES as readonly unknown[]).includes(
      record.amazonMarketplace,
    )
      ? (record.amazonMarketplace as AmazonMarketplace)
      : fallback.amazonMarketplace,
  }
}

const PRICE_NOTIFY_KEYS = [
  'drop',
  'increase',
  'outOfStock',
  'backInStock',
] as const satisfies readonly (keyof PriceNotifyCategories)[]

function boundedInteger(
  value: unknown,
  [min, max]: readonly [number, number],
  fallback: number,
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback
}

/** Clamps to the range and rounds to `decimals` places. */
function boundedDecimal(
  value: unknown,
  [min, max]: readonly [number, number],
  decimals: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const factor = 10 ** decimals
  return Math.min(max, Math.max(min, Math.round(value * factor) / factor))
}

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function normalizeActiveHours(
  value: unknown,
  fallback: ActiveHours | null,
): ActiveHours | null {
  if (value === null) return null
  if (!Array.isArray(value) || value.length !== 2) return fallback
  const [start, end] = value
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start > 23 ||
    end < 0 ||
    end > 24 ||
    start === end % 24
  )
    return fallback
  return [start, end]
}

export function normalizePriceMonitoring(
  value: unknown,
  fallback: PriceMonitoringSettings = DEFAULT_PRICE_MONITORING,
): PriceMonitoringSettings {
  const record = plainObject(value)
  const schedule = plainObject(record.schedule)
  const pacing = plainObject(record.pacing)
  const notify = plainObject(record.notify)
  const thresholds = plainObject(record.thresholds)
  const mode = (PRICE_SCHEDULE_MODES as readonly unknown[]).includes(
    schedule.mode,
  )
    ? (schedule.mode as PriceScheduleMode)
    : fallback.schedule.mode
  return {
    enabled:
      typeof record.enabled === 'boolean' ? record.enabled : fallback.enabled,
    skipSoldKnives:
      typeof record.skipSoldKnives === 'boolean'
        ? record.skipSoldKnives
        : fallback.skipSoldKnives,
    schedule: {
      mode,
      intervalHours: boundedInteger(
        schedule.intervalHours,
        PRICE_MONITORING_LIMITS.intervalHours,
        fallback.schedule.intervalHours,
      ),
      activeHours:
        'activeHours' in schedule
          ? normalizeActiveHours(
              schedule.activeHours,
              fallback.schedule.activeHours,
            )
          : fallback.schedule.activeHours,
    },
    pacing: {
      minGapSeconds: boundedInteger(
        pacing.minGapSeconds,
        PRICE_MONITORING_LIMITS.minGapSeconds,
        fallback.pacing.minGapSeconds,
      ),
      amazonMinGapSeconds: boundedInteger(
        pacing.amazonMinGapSeconds,
        PRICE_MONITORING_LIMITS.amazonMinGapSeconds,
        fallback.pacing.amazonMinGapSeconds,
      ),
    },
    notify: Object.fromEntries(
      PRICE_NOTIFY_KEYS.map((key) => [
        key,
        typeof notify[key] === 'boolean' ? notify[key] : fallback.notify[key],
      ]),
    ) as PriceNotifyCategories,
    thresholds: {
      minPercent: boundedDecimal(
        thresholds.minPercent,
        PRICE_MONITORING_LIMITS.minPercent,
        1,
        fallback.thresholds.minPercent,
      ),
    },
    ai: normalizePriceAi(record.ai, fallback.ai),
    otherStores: normalizeOtherStores(record.otherStores, fallback.otherStores),
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
  pinnedCardFields: CardField[]
  driveAutoBackupEnabled: boolean
  mcpEnabled: boolean
  mcpWriteEnabled: boolean
  customFields: CustomField[]
  maintenanceReminders: MaintenanceReminderSettings
  careIntervalOverrides: CareIntervalOverrides
  careDeferrals: CareDeferrals
  priceMonitoring: PriceMonitoringSettings
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
  pinnedCardFields: [...DEFAULT_PINNED_CARD_FIELDS],
  driveAutoBackupEnabled: false,
  mcpEnabled: true,
  mcpWriteEnabled: false,
  customFields: [],
  maintenanceReminders: DEFAULT_MAINTENANCE_REMINDERS,
  careIntervalOverrides: {},
  careDeferrals: {},
  priceMonitoring: DEFAULT_PRICE_MONITORING,
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
  // Espresso was called Amber before it was redesigned.
  if (value === 'amber') return 'espresso'
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

/** Next style in the footer's quick-switch cycle. */
export function getNextThemeStyle(themeStyle: ThemeStyle): ThemeStyle {
  const index = QUICK_SWITCH_THEME_STYLES.indexOf(themeStyle)
  return QUICK_SWITCH_THEME_STYLES[
    (index + 1) % QUICK_SWITCH_THEME_STYLES.length
  ]
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
    espresso: { light: '#f8f2e7', dark: '#f8f2e7' },
    phosphor: { light: '#0d0b08', dark: '#0d0b08' },
    atrium: { light: '#ffffff', dark: '#ffffff' },
    shelf: { light: '#f5f3ef', dark: '#141211' },
    ledger: { light: '#123d2c', dark: '#0a120e' },
  }

export function isLightOnlyThemeStyle(themeStyle: ThemeStyle): boolean {
  return (LIGHT_ONLY_THEME_STYLES as readonly ThemeStyle[]).includes(themeStyle)
}

export function isLumenPaletteThemeStyle(themeStyle: ThemeStyle): boolean {
  return (LUMEN_PALETTE_THEME_STYLES as readonly ThemeStyle[]).includes(
    themeStyle,
  )
}

/** Value for the root's `data-theme-palette`, or undefined for none. */
export function getThemePalette(themeStyle: ThemeStyle): 'lumen' | undefined {
  return isLumenPaletteThemeStyle(themeStyle) ? 'lumen' : undefined
}

export function isDarkOnlyThemeStyle(themeStyle: ThemeStyle): boolean {
  return (DARK_ONLY_THEME_STYLES as readonly ThemeStyle[]).includes(themeStyle)
}

/** Styles locked to one mode, where the light/dark choice does nothing. */
export function hasFixedColorMode(themeStyle: ThemeStyle): boolean {
  return isLightOnlyThemeStyle(themeStyle) || isDarkOnlyThemeStyle(themeStyle)
}

/** Whether the root should carry the `dark` class for a mode and style. */
export function isDarkThemeActive(
  theme: AppTheme,
  themeStyle: ThemeStyle,
): boolean {
  if (isDarkOnlyThemeStyle(themeStyle)) return true
  return theme === 'dark' && !isLightOnlyThemeStyle(themeStyle)
}

/**
 * Records the chosen color mode on the root and applies the `dark` class.
 * Light-only and dark-only styles keep the saved mode but render in their
 * fixed mode.
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
  const palette = getThemePalette(themeStyle)
  if (palette) element.dataset.themePalette = palette
  else delete element.dataset.themePalette
  // Re-apply the saved mode: a light-only style drops the `dark` class and a
  // dark-only style adds it.
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
