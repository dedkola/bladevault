import type Database from 'better-sqlite3'
import {
  getEligibility,
  type EligibilitySettings,
} from '@/lib/price-monitor/eligibility'
import { parseStoredPrice, toMinorUnits } from '@/lib/price-monitor/money'
import type {
  Availability,
  PriceSourceStatus,
  PriceWatchMode,
} from '@/lib/price-monitor/shared'

/**
 * Read models for the Price Drops page and the Market tab. Everything comes
 * from the permanent history tables; nothing here writes.
 */

export const HISTORY_RANGES = ['7d', '1m', '3m', '6m', '1y', 'all'] as const
export type HistoryRange = (typeof HISTORY_RANGES)[number]

const DAY_MS = 24 * 60 * 60 * 1000
const RANGE_DAYS: Record<Exclude<HistoryRange, 'all'>, number> = {
  '7d': 7,
  '1m': 30,
  '3m': 90,
  '6m': 182,
  '1y': 365,
}

export function parseHistoryRange(value: string | null): HistoryRange {
  return (HISTORY_RANGES as readonly string[]).includes(value ?? '')
    ? (value as HistoryRange)
    : '3m'
}

/** Start of a range, or null for all history. */
export function rangeStart(range: HistoryRange, now: number): number | null {
  return range === 'all' ? null : now - RANGE_DAYS[range] * DAY_MS
}

export type KnifeRef = {
  id: string
  name: string
  brand: string
  image: string | null
}

export type ChangeEvent = {
  id: string
  type: 'price' | 'stock'
  /** drop | increase for price; out_of_stock | back_in_stock for stock. */
  kind: 'drop' | 'increase' | 'out_of_stock' | 'back_in_stock'
  knife: KnifeRef
  sourceId: number
  storeName: string
  sourceUrl: string
  previousPriceMinor: number | null
  priceMinor: number | null
  currency: string | null
  deltaMinor: number | null
  deltaPct: number | null
  occurredAt: string
}

export type SourceSummary = {
  sourceId: number
  knife: KnifeRef
  storeName: string
  laneKey: string
  url: string
  status: PriceSourceStatus
  priceMinor: number | null
  currency: string | null
  availability: Availability | null
  lastCheckedAt: string | null
  lastError: string | null
  /** When it went out of stock (out-of-stock list only). */
  since: string | null
}

export type KnifeSummary = {
  knife: KnifeRef
  monitored: boolean
  sources: number
  /** Lowest in-stock price; the most common currency among the sources. */
  bestPriceMinor: number | null
  currency: string | null
  /** Purchase price in the same currency, when comparable. */
  paidMinor: number | null
  outOfStock: boolean
  lastChange: ChangeEvent | null
  lastCheckedAt: string | null
}

export type PriceOverview = {
  windowDays: number
  kpis: {
    monitoredKnives: number
    sources: number
    stores: number
    drops: number
    increases: number
    outOfStock: number
    lastSuccessAt: string | null
  }
  recent: ChangeEvent[]
  drops: ChangeEvent[]
  increases: ChangeEvent[]
  outOfStock: SourceSummary[]
  recentlyMonitored: SourceSummary[]
  knives: KnifeSummary[]
}

type KnifeRow = {
  id: string
  name: string
  brand: string
  images: string
  specs: string
  sold: number
  mode: PriceWatchMode
}

function firstImage(images: string): string | null {
  try {
    const list = JSON.parse(images) as unknown
    return Array.isArray(list) && typeof list[0] === 'string' ? list[0] : null
  } catch {
    return null
  }
}

function storedPrice(specs: string): string | undefined {
  try {
    return (JSON.parse(specs) as { price?: string }).price
  } catch {
    return undefined
  }
}

function readKnives(database: Database.Database): Map<string, KnifeRow> {
  const rows = database
    .prepare(
      `SELECT k.id, k.name, k.brand, k.images, k.specs, k.sold,
              COALESCE(w.mode, 'auto') AS mode
       FROM knives k LEFT JOIN price_watch w ON w.knife_id = k.id
       WHERE k.id IN (SELECT knife_id FROM price_sources WHERE removed_at IS NULL)
          OR k.id IN (SELECT knife_id FROM price_change_events)
          OR k.id IN (SELECT knife_id FROM stock_events)`,
    )
    .all() as KnifeRow[]
  return new Map(rows.map((row) => [row.id, row]))
}

const knifeRef = (row: KnifeRow | undefined, id: string): KnifeRef => ({
  id,
  name: row?.name ?? 'Deleted knife',
  brand: row?.brand ?? '',
  image: row ? firstImage(row.images) : null,
})

type EventRow = {
  id: number
  type: 'price' | 'stock'
  kind: ChangeEvent['kind']
  knife_id: string
  source_id: number
  store_name: string
  source_url: string
  previous_price_minor: number | null
  price_minor: number | null
  currency: string | null
  delta_minor: number | null
  delta_pct: number | null
  occurred_at: string
}

const EVENTS_SQL = `
  SELECT id, 'price' AS type, direction AS kind, knife_id, source_id,
         store_name, source_url, previous_price_minor, price_minor, currency,
         delta_minor, delta_pct, occurred_at
  FROM price_change_events
  UNION ALL
  SELECT id, 'stock' AS type, kind, knife_id, source_id, store_name,
         source_url, NULL, price_minor, currency, NULL, NULL, occurred_at
  FROM stock_events`

function toEvent(row: EventRow, knives: Map<string, KnifeRow>): ChangeEvent {
  return {
    id: `${row.type}-${row.id}`,
    type: row.type,
    kind: row.kind,
    knife: knifeRef(knives.get(row.knife_id), row.knife_id),
    sourceId: row.source_id,
    storeName: row.store_name,
    sourceUrl: row.source_url,
    previousPriceMinor: row.previous_price_minor,
    priceMinor: row.price_minor,
    currency: row.currency,
    deltaMinor: row.delta_minor,
    deltaPct: row.delta_pct,
    occurredAt: row.occurred_at,
  }
}

type SourceRow = {
  id: number
  knife_id: string
  store_name: string
  lane_key: string
  url: string
  enabled: number
  status: PriceSourceStatus
  last_price_minor: number | null
  last_currency: string | null
  last_availability: Availability | null
  last_checked_at: string | null
  last_success_at: string | null
  last_error: string | null
}

function toSourceSummary(
  row: SourceRow,
  knives: Map<string, KnifeRow>,
  since: string | null = null,
): SourceSummary {
  return {
    sourceId: row.id,
    knife: knifeRef(knives.get(row.knife_id), row.knife_id),
    storeName: row.store_name,
    laneKey: row.lane_key,
    url: row.url,
    status: row.status,
    priceMinor: row.last_price_minor,
    currency: row.last_currency,
    availability: row.last_availability,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    since,
  }
}

function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best: string | null = null
  for (const [value, count] of counts)
    if (best === null || count > (counts.get(best) ?? 0)) best = value
  return best
}

export function buildPriceOverview(
  database: Database.Database,
  settings: EligibilitySettings,
  options: { now?: number; windowDays?: number; limit?: number } = {},
): PriceOverview {
  const now = options.now ?? Date.now()
  const windowDays = options.windowDays ?? 30
  const limit = options.limit ?? 50
  const since = new Date(now - windowDays * DAY_MS).toISOString()
  const knives = readKnives(database)

  const sources = database
    .prepare(
      `SELECT id, knife_id, store_name, lane_key, url, enabled, status,
              last_price_minor, last_currency, last_availability,
              last_checked_at, last_success_at, last_error
       FROM price_sources WHERE removed_at IS NULL`,
    )
    .all() as SourceRow[]

  const enabledByKnife = new Map<string, SourceRow[]>()
  for (const source of sources) {
    if (source.enabled !== 1) continue
    const list = enabledByKnife.get(source.knife_id) ?? []
    list.push(source)
    enabledByKnife.set(source.knife_id, list)
  }
  const monitored = new Set<string>()
  for (const [knifeId, list] of enabledByKnife) {
    const knife = knives.get(knifeId)
    if (
      knife &&
      getEligibility(
        { sold: knife.sold === 1, specs: { price: storedPrice(knife.specs) } },
        knife.mode,
        list.length,
        settings,
      ).monitored
    )
      monitored.add(knifeId)
  }

  const recentRows = database
    .prepare(`${EVENTS_SQL} ORDER BY occurred_at DESC, id DESC LIMIT ?`)
    .all(limit) as EventRow[]
  const windowRows = database
    .prepare(
      `SELECT * FROM (${EVENTS_SQL}) WHERE type = 'price' AND occurred_at >= ?
       ORDER BY occurred_at DESC, id DESC`,
    )
    .all(since) as EventRow[]
  const drops = windowRows.filter((row) => row.kind === 'drop')
  const increases = windowRows.filter((row) => row.kind === 'increase')

  const outOfStockSince = new Map(
    (
      database
        .prepare(
          `SELECT source_id, MAX(occurred_at) AS since FROM stock_events
           WHERE kind = 'out_of_stock' GROUP BY source_id`,
        )
        .all() as Array<{ source_id: number; since: string }>
    ).map((row) => [row.source_id, row.since]),
  )
  const outOfStock = sources
    .filter((source) => source.last_availability === 'out_of_stock')
    .map((source) =>
      toSourceSummary(source, knives, outOfStockSince.get(source.id) ?? null),
    )
  const recentlyMonitored = sources
    .filter((source) => source.last_checked_at)
    .sort((a, b) => b.last_checked_at!.localeCompare(a.last_checked_at!))
    .slice(0, 20)
    .map((source) => toSourceSummary(source, knives))

  const lastChangeByKnife = new Map<string, ChangeEvent>()
  for (const row of database
    .prepare(`${EVENTS_SQL} ORDER BY occurred_at ASC, id ASC`)
    .all() as EventRow[])
    lastChangeByKnife.set(row.knife_id, toEvent(row, knives))

  const sourcesByKnife = new Map<string, SourceRow[]>()
  for (const source of sources) {
    const list = sourcesByKnife.get(source.knife_id) ?? []
    list.push(source)
    sourcesByKnife.set(source.knife_id, list)
  }
  const knifeSummaries: KnifeSummary[] = [...sourcesByKnife].map(
    ([knifeId, list]) => {
      const knife = knives.get(knifeId)
      const priced = list.filter(
        (source) =>
          source.last_price_minor !== null &&
          source.last_currency &&
          source.last_availability !== 'out_of_stock',
      )
      const currency = mostCommon(priced.map((s) => s.last_currency!))
      const inCurrency = priced.filter((s) => s.last_currency === currency)
      const best = inCurrency.length
        ? Math.min(...inCurrency.map((s) => s.last_price_minor!))
        : null
      const paid = knife ? parseStoredPrice(storedPrice(knife.specs)) : null
      const checked = list
        .map((source) => source.last_checked_at)
        .filter((value): value is string => Boolean(value))
        .sort()
      return {
        knife: knifeRef(knife, knifeId),
        monitored: monitored.has(knifeId),
        sources: list.length,
        bestPriceMinor: best,
        currency,
        paidMinor:
          paid && currency && (paid.currency === currency || !paid.currency)
            ? toMinorUnits(paid.amount, currency)
            : null,
        outOfStock:
          list.length > 0 &&
          list.every((source) => source.last_availability === 'out_of_stock'),
        lastChange: lastChangeByKnife.get(knifeId) ?? null,
        lastCheckedAt: checked.at(-1) ?? null,
      }
    },
  )

  const lastSuccess = sources
    .map((source) => source.last_success_at)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1)

  return {
    windowDays,
    kpis: {
      monitoredKnives: monitored.size,
      sources: sources.filter((s) => monitored.has(s.knife_id)).length,
      stores: new Set(
        sources
          .filter((s) => monitored.has(s.knife_id))
          .map((source) => source.lane_key),
      ).size,
      drops: drops.length,
      increases: increases.length,
      outOfStock: outOfStock.length,
      lastSuccessAt: lastSuccess ?? null,
    },
    recent: recentRows.map((row) => toEvent(row, knives)),
    drops: drops.slice(0, limit).map((row) => toEvent(row, knives)),
    increases: increases.slice(0, limit).map((row) => toEvent(row, knives)),
    outOfStock,
    recentlyMonitored,
    knives: knifeSummaries.sort(
      (a, b) =>
        (b.lastChange?.occurredAt ?? '').localeCompare(
          a.lastChange?.occurredAt ?? '',
        ) || a.knife.name.localeCompare(b.knife.name),
    ),
  }
}

export type HistoryPoint = {
  /** Start of this state (clamped to the range start). */
  from: string
  /** Last time the state was confirmed. */
  to: string
  priceMinor: number | null
  currency: string | null
  availability: Availability
}

export type SourceHistory = {
  sourceId: number
  storeName: string
  url: string
  /** Removed sources keep their history and are labelled in the chart. */
  removed: boolean
  points: HistoryPoint[]
}

export type KnifeHistory = {
  knife: KnifeRef
  paid: { amount: number; currency: string } | null
  range: HistoryRange
  rangeStart: string | null
  sources: SourceHistory[]
  events: ChangeEvent[]
}

/**
 * Step-line history per source for one knife. Includes the snapshot that
 * was current when the range started, so every line begins at the left edge.
 */
export function buildKnifeHistory(
  database: Database.Database,
  knifeId: string,
  range: HistoryRange,
  now = Date.now(),
): KnifeHistory | null {
  const knives = readKnives(database)
  const knife = database
    .prepare(
      `SELECT k.id, k.name, k.brand, k.images, k.specs, k.sold,
              COALESCE(w.mode, 'auto') AS mode
       FROM knives k LEFT JOIN price_watch w ON w.knife_id = k.id
       WHERE k.id = ?`,
    )
    .get(knifeId) as KnifeRow | undefined
  if (!knife) return null
  knives.set(knife.id, knife)

  const start = rangeStart(range, now)
  const startIso = start === null ? null : new Date(start).toISOString()
  const sources = database
    .prepare(
      `SELECT id, store_name, url, removed_at FROM price_sources
       WHERE knife_id = ? AND (removed_at IS NULL OR id IN
         (SELECT source_id FROM price_snapshots WHERE knife_id = ?))
       ORDER BY removed_at IS NOT NULL, id`,
    )
    .all(knifeId, knifeId) as Array<{
    id: number
    store_name: string
    url: string
    removed_at: string | null
  }>

  const pointsFor = database.prepare(
    `SELECT observed_at, last_seen_at, price_minor, currency, availability
     FROM price_snapshots
     WHERE source_id = ? AND (? IS NULL OR last_seen_at >= ? OR id = (
       SELECT id FROM price_snapshots
       WHERE source_id = ? AND observed_at < ? ORDER BY id DESC LIMIT 1))
     ORDER BY id`,
  )
  const history: SourceHistory[] = sources
    .map((source) => ({
      sourceId: source.id,
      storeName: source.store_name,
      url: source.url,
      removed: source.removed_at !== null,
      points: (
        pointsFor.all(
          source.id,
          startIso,
          startIso,
          source.id,
          startIso,
        ) as Array<{
          observed_at: string
          last_seen_at: string
          price_minor: number | null
          currency: string | null
          availability: Availability
        }>
      ).map((row) => ({
        from:
          startIso && row.observed_at < startIso ? startIso : row.observed_at,
        to: row.last_seen_at,
        priceMinor: row.price_minor,
        currency: row.currency,
        availability: row.availability,
      })),
    }))
    .filter((source) => source.points.length || !source.removed)

  const events = (
    database
      .prepare(
        `SELECT * FROM (${EVENTS_SQL})
         WHERE knife_id = ? AND (? IS NULL OR occurred_at >= ?)
         ORDER BY occurred_at DESC, id DESC LIMIT 100`,
      )
      .all(knifeId, startIso, startIso) as EventRow[]
  ).map((row) => toEvent(row, knives))

  const paid = parseStoredPrice(storedPrice(knife.specs))
  return {
    knife: knifeRef(knife, knife.id),
    paid: paid && paid.currency ? paid : null,
    range,
    rangeStart: startIso,
    sources: history,
    events,
  }
}
