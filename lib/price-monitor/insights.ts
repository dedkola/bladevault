import type Database from 'better-sqlite3'
import {
  getEligibility,
  type EligibilitySettings,
} from '@/lib/price-monitor/eligibility'
import { parseStoredPrice, toMinorUnits } from '@/lib/price-monitor/money'
import {
  classifyPriceMoves,
  type PriceMoveClass,
} from '@/lib/price-monitor/price-moves'
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

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
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

/**
 * Where a monitored source stands after its latest check: the last price
 * change inside the window (if the price still sits there), stock, or a
 * problem reading the page.
 */
export const SOURCE_RESULTS = [
  'drop',
  'increase',
  'out_of_stock',
  'same',
  'attention',
  'pending',
] as const
export type SourceResult = (typeof SOURCE_RESULTS)[number]

/** One monitored store listing, as the status timeline and table show it. */
export type MonitoredSource = SourceSummary & {
  result: SourceResult
  /** Price before the latest change in the window, when there was one. */
  previousPriceMinor: number | null
  deltaMinor: number | null
  deltaPct: number | null
  changedAt: string | null
  /**
   * No change only: how far the price moved in the window, in percent, when
   * it stayed under the Minimum change (shown as a muted hint).
   */
  driftPct: number | null
  /** The price moved and came back to an earlier level in the window. */
  fluctuating: boolean
  /** Purchase price in this source's currency, when comparable. */
  paidMinor: number | null
  /** Currency of the stored purchase price, when it names one. */
  paidCurrency: string | null
  nextCheckAt: string | null
}

/** Checks started in one hour, counted by what they found. */
export type CheckHour = {
  /** Start of the hour (ISO). */
  hour: string
} & Record<Exclude<SourceResult, 'pending'>, number>

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
  /** Every enabled source of a monitored knife. */
  monitored: MonitoredSource[]
  /** The last 24 hours of checks, oldest first. */
  checksByHour: CheckHour[]
  round: {
    /** How often each source is checked, or null when unknown. */
    intervalHours: number | null
    /** Checks in the last 24 hours that could not read a price. */
    failed24h: number
    /** The longest-ago latest check among monitored sources. */
    oldestCheckAt: string | null
  }
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

/**
 * The stored events behind Inbox notifications, keyed like `ChangeEvent.id`
 * (`price-<id>` or `stock-<id>`).
 */
export function readChangeEventsById(
  database: Database.Database,
  ids: { price: readonly number[]; stock: readonly number[] },
): Map<string, ChangeEvent> {
  if (!ids.price.length && !ids.stock.length) return new Map()
  const rows = database
    .prepare(
      `SELECT * FROM (${EVENTS_SQL})
       WHERE (type = 'price' AND id IN (SELECT value FROM json_each(?)))
          OR (type = 'stock' AND id IN (SELECT value FROM json_each(?)))`,
    )
    .all(JSON.stringify(ids.price), JSON.stringify(ids.stock)) as EventRow[]
  const knives = readKnives(database)
  return new Map(
    rows.map((row) => {
      const event = toEvent(row, knives)
      return [event.id, event]
    }),
  )
}

/** Price and stock events since a moment, newest first (MCP price tools). */
export function listChangeEvents(
  database: Database.Database,
  options: { since: string; limit?: number },
): ChangeEvent[] {
  const rows = database
    .prepare(
      `SELECT * FROM (${EVENTS_SQL}) WHERE occurred_at >= ?
       ORDER BY occurred_at DESC, id DESC LIMIT ?`,
    )
    .all(options.since, options.limit ?? 100) as EventRow[]
  const knives = readKnives(database)
  return rows.map((row) => toEvent(row, knives))
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
  next_check_at: string | null
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

/**
 * Eligibility plus the notification Minimum change, which also decides which
 * price moves count as a change on the page (0 or missing: every move).
 */
export type OverviewSettings = EligibilitySettings & {
  thresholds?: { minPercent: number }
}

export function buildPriceOverview(
  database: Database.Database,
  settings: OverviewSettings,
  options: {
    now?: number
    windowDays?: number
    limit?: number
    /** Check frequency from the schedule, shown with the status timeline. */
    frequencyMs?: number
  } = {},
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
              last_checked_at, last_success_at, last_error, next_check_at
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
  const moves = classifyWindowMoves(
    sources,
    windowRows,
    settings.thresholds?.minPercent ?? 0,
  )
  const significant = new Set(
    [...moves.values()].flatMap((move) => move.significantIds),
  )
  // Moves under the Minimum change are noise: they stay in history and
  // Recent, but not in the drop and increase lists or their counts.
  const drops = windowRows.filter(
    (row) => row.kind === 'drop' && significant.has(row.id),
  )
  const increases = windowRows.filter(
    (row) => row.kind === 'increase' && significant.has(row.id),
  )

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

  const monitoredSources = buildMonitoredSources(
    sources.filter(
      (source) => source.enabled === 1 && monitored.has(source.knife_id),
    ),
    knives,
    moves,
  )
  const dayAgo = new Date(now - DAY_MS).toISOString()
  const checksByHour = readChecksByHour(database, now, significant)
  const oldestCheckAt =
    monitoredSources
      .map((source) => source.lastCheckedAt)
      .filter((value): value is string => Boolean(value))
      .sort()[0] ?? null

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
    monitored: monitoredSources,
    checksByHour,
    round: {
      intervalHours: options.frequencyMs
        ? Math.round((options.frequencyMs / HOUR_MS) * 10) / 10
        : null,
      failed24h: (
        database
          .prepare(
            `SELECT COUNT(*) AS n FROM price_check_log
             WHERE started_at >= ? AND outcome IN ('failed', 'blocked')`,
          )
          .get(dayAgo) as { n: number }
      ).n,
      oldestCheckAt,
    },
  }
}

function paidCurrency(knife: KnifeRow | undefined) {
  if (!knife) return null
  return parseStoredPrice(storedPrice(knife.specs))?.currency || null
}

function paidIn(knife: KnifeRow | undefined, currency: string | null) {
  if (!knife || !currency) return null
  const paid = parseStoredPrice(storedPrice(knife.specs))
  return paid && (paid.currency === currency || !paid.currency)
    ? toMinorUnits(paid.amount, currency)
    : null
}

/** Classifies each source's price events in the window (newest first in). */
function classifyWindowMoves(
  sources: SourceRow[],
  windowPriceEvents: EventRow[],
  minPercent: number,
): Map<number, PriceMoveClass> {
  const bySource = new Map<number, EventRow[]>()
  for (const row of windowPriceEvents) {
    const list = bySource.get(row.source_id) ?? []
    list.push(row)
    bySource.set(row.source_id, list)
  }
  const current = new Map(sources.map((source) => [source.id, source]))
  const moves = new Map<number, PriceMoveClass>()
  for (const [sourceId, rows] of bySource) {
    const source = current.get(sourceId)
    moves.set(
      sourceId,
      classifyPriceMoves(
        rows
          .filter(
            (row) =>
              row.previous_price_minor !== null && row.price_minor !== null,
          )
          .reverse()
          .map((row) => ({
            id: row.id,
            previousPriceMinor: row.previous_price_minor!,
            priceMinor: row.price_minor!,
            currency: row.currency,
            occurredAt: row.occurred_at,
          })),
        {
          priceMinor: source?.last_price_minor ?? null,
          currency: source?.last_currency ?? null,
        },
        minPercent,
      ),
    )
  }
  return moves
}

function sourceResult(
  source: SourceRow,
  move: PriceMoveClass | undefined,
): SourceResult {
  if (!source.last_checked_at) return 'pending'
  if (source.last_availability === 'out_of_stock') return 'out_of_stock'
  if (
    source.status === 'failed' ||
    source.status === 'blocked' ||
    source.status === 'price_unavailable' ||
    source.status === 'needs_review'
  )
    return 'attention'
  // Only a counted change that still stands; noise and bounces are no change.
  return move?.result ?? 'same'
}

function buildMonitoredSources(
  sources: SourceRow[],
  knives: Map<string, KnifeRow>,
  moves: Map<number, PriceMoveClass>,
): MonitoredSource[] {
  return sources.map((source) => {
    const move = moves.get(source.id)
    const result = sourceResult(source, move)
    const changed = result === 'drop' || result === 'increase'
    const knife = knives.get(source.knife_id)
    return {
      ...toSourceSummary(source, knives),
      result,
      previousPriceMinor: changed ? (move?.previousPriceMinor ?? null) : null,
      deltaMinor: changed ? (move?.deltaMinor ?? null) : null,
      deltaPct: changed ? (move?.deltaPct ?? null) : null,
      changedAt: changed ? (move?.changedAt ?? null) : null,
      driftPct: result === 'same' ? (move?.driftPct ?? null) : null,
      fluctuating: (changed || result === 'same') && Boolean(move?.fluctuating),
      paidMinor: paidIn(knife, source.last_currency),
      paidCurrency: paidCurrency(knife),
      nextCheckAt: source.next_check_at,
    }
  })
}

type CheckLogRow = {
  started_at: string
  outcome: string
  change: 'drop' | 'increase' | null
  /** The price event behind `change`. */
  change_id: number | null
  stock: 'out_of_stock' | 'back_in_stock' | null
  /** 1 when the page loaded but showed no price. */
  missing: number | null
}

/** 24 hourly buckets ending with the current hour. */
function readChecksByHour(
  database: Database.Database,
  now: number,
  significant: ReadonlySet<number>,
) {
  const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS
  const first = currentHour - 23 * HOUR_MS
  const hours: CheckHour[] = Array.from({ length: 24 }, (_, index) => ({
    hour: new Date(first + index * HOUR_MS).toISOString(),
    drop: 0,
    increase: 0,
    out_of_stock: 0,
    same: 0,
    attention: 0,
  }))
  // A check that stored a new snapshot links to it; the snapshot links to
  // the price or stock event it produced. A check that only confirmed the
  // previous reading extended that snapshot, so the earliest snapshot still
  // seen at or after the check started is the one it read.
  const rows = database
    .prepare(
      `SELECT l.started_at, l.outcome,
              (SELECT e.direction FROM price_snapshots s
                 JOIN price_change_events e ON e.to_snapshot_id = s.id
               WHERE s.check_log_id = l.id LIMIT 1) AS change,
              (SELECT e.id FROM price_snapshots s
                 JOIN price_change_events e ON e.to_snapshot_id = s.id
               WHERE s.check_log_id = l.id LIMIT 1) AS change_id,
              (SELECT e.kind FROM price_snapshots s
                 JOIN stock_events e ON e.to_snapshot_id = s.id
               WHERE s.check_log_id = l.id LIMIT 1) AS stock,
              (SELECT s.price_minor IS NULL
                      AND s.availability != 'out_of_stock'
               FROM price_snapshots s
               WHERE s.source_id = l.source_id
                 AND s.last_seen_at >= l.started_at
               ORDER BY s.id LIMIT 1) AS missing
       FROM price_check_log l WHERE l.started_at >= ?`,
    )
    .all(new Date(first).toISOString()) as CheckLogRow[]
  for (const row of rows) {
    const index = Math.floor((Date.parse(row.started_at) - first) / HOUR_MS)
    const bucket = hours[index]
    if (!bucket) continue
    if (row.outcome !== 'ok') bucket.attention += 1
    else if (row.stock === 'out_of_stock') bucket.out_of_stock += 1
    else if (row.missing === 1) bucket.attention += 1
    // A move under the Minimum change found no change worth showing.
    else if (row.change && significant.has(row.change_id ?? -1))
      bucket[row.change] += 1
    else bucket.same += 1
  }
  return hours
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
  /** Readings the line is drawn from: AI-unconfirmed ones are left out. */
  points: HistoryPoint[]
  /**
   * Readings AI could not confirm (`ai_review = 'unconfirmed'`) in the
   * range. They never became the source's price, so they are marked apart.
   */
  unconfirmed: HistoryPoint[]
}

/** The lowest or highest price ever seen in one currency, in stock. */
export type PriceExtreme = {
  priceMinor: number
  /** When the store first showed it. */
  at: string
  /** The last time it was still seen. */
  until: string
  sourceId: number
  storeName: string
}

/**
 * Figures over the knife's whole history, whatever the chart range: the
 * stats row, the all-time low marker and the best current offer.
 */
export type KnifeHistoryStats = {
  /** Currency of the figures: the one most current offers use. */
  currency: string | null
  lowest: PriceExtreme | null
  highest: PriceExtreme | null
  /** First recorded reading of any source, removed ones included. */
  trackingSince: string | null
  /** Lowest current in-stock price among active sources. */
  bestNow: {
    priceMinor: number
    sourceId: number
    storeName: string
    url: string
    availability: Availability | null
  } | null
  /** Purchase price in `currency`, when comparable. */
  paidMinor: number | null
  /** Best price now minus the purchase price, and that as a percentage. */
  gapMinor: number | null
  gapPct: number | null
}

export type KnifeHistory = {
  knife: KnifeRef
  paid: { amount: number; currency: string } | null
  range: HistoryRange
  rangeStart: string | null
  /**
   * Where the chart's time axis starts: the range start, or the first
   * reading when the range reaches back before tracking began.
   */
  chartStart: string | null
  sources: SourceHistory[]
  events: ChangeEvent[]
  stats: KnifeHistoryStats
}

const TRUSTED_SNAPSHOT = "(ai_review IS NULL OR ai_review <> 'unconfirmed')"

type SnapshotPointRow = {
  observed_at: string
  last_seen_at: string
  price_minor: number | null
  currency: string | null
  availability: Availability
}

function readExtreme(
  database: Database.Database,
  knifeId: string,
  currency: string,
  order: 'ASC' | 'DESC',
): PriceExtreme | null {
  const row = database
    .prepare(
      `SELECT s.price_minor, s.observed_at, s.last_seen_at, s.source_id,
              p.store_name
       FROM price_snapshots s JOIN price_sources p ON p.id = s.source_id
       WHERE s.knife_id = ? AND s.currency = ? AND s.price_minor IS NOT NULL
         AND s.availability <> 'out_of_stock'
         AND (s.ai_review IS NULL OR s.ai_review <> 'unconfirmed')
       ORDER BY s.price_minor ${order}, s.id DESC LIMIT 1`,
    )
    .get(knifeId, currency) as
    | {
        price_minor: number
        observed_at: string
        last_seen_at: string
        source_id: number
        store_name: string
      }
    | undefined
  return row
    ? {
        priceMinor: row.price_minor,
        at: row.observed_at,
        until: row.last_seen_at,
        sourceId: row.source_id,
        storeName: row.store_name,
      }
    : null
}

function buildHistoryStats(
  database: Database.Database,
  knife: KnifeRow,
): KnifeHistoryStats {
  const current = database
    .prepare(
      `SELECT id, store_name, url, last_price_minor, last_currency,
              last_availability
       FROM price_sources
       WHERE knife_id = ? AND removed_at IS NULL
         AND last_price_minor IS NOT NULL AND last_currency IS NOT NULL
         AND (last_availability IS NULL OR last_availability <> 'out_of_stock')
       ORDER BY last_price_minor, id`,
    )
    .all(knife.id) as Array<{
    id: number
    store_name: string
    url: string
    last_price_minor: number
    last_currency: string
    last_availability: Availability | null
  }>
  const currency =
    mostCommon(current.map((source) => source.last_currency)) ??
    mostCommon(
      (
        database
          .prepare(
            `SELECT currency FROM price_snapshots
             WHERE knife_id = ? AND currency IS NOT NULL
               AND price_minor IS NOT NULL AND ${TRUSTED_SNAPSHOT}`,
          )
          .all(knife.id) as Array<{ currency: string }>
      ).map((row) => row.currency),
    )
  const best = current.find((source) => source.last_currency === currency)
  const trackingSince =
    (
      database
        .prepare(
          'SELECT MIN(observed_at) AS since FROM price_snapshots WHERE knife_id = ?',
        )
        .get(knife.id) as { since: string | null }
    ).since ?? null
  const paidMinor = paidIn(knife, currency)
  const gapMinor =
    best && paidMinor !== null && paidMinor > 0
      ? best.last_price_minor - paidMinor
      : null
  return {
    currency,
    lowest: currency ? readExtreme(database, knife.id, currency, 'ASC') : null,
    highest: currency
      ? readExtreme(database, knife.id, currency, 'DESC')
      : null,
    trackingSince,
    bestNow: best
      ? {
          priceMinor: best.last_price_minor,
          sourceId: best.id,
          storeName: best.store_name,
          url: best.url,
          availability: best.last_availability,
        }
      : null,
    paidMinor,
    gapMinor,
    gapPct:
      gapMinor !== null && paidMinor
        ? Math.round((gapMinor / paidMinor) * 1000) / 10
        : null,
  }
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
     WHERE source_id = ? AND ${TRUSTED_SNAPSHOT}
       AND (? IS NULL OR last_seen_at >= ? OR id = (
         SELECT id FROM price_snapshots
         WHERE source_id = ? AND observed_at < ? AND ${TRUSTED_SNAPSHOT}
         ORDER BY id DESC LIMIT 1))
     ORDER BY id`,
  )
  const unconfirmedFor = database.prepare(
    `SELECT observed_at, last_seen_at, price_minor, currency, availability
     FROM price_snapshots
     WHERE source_id = ? AND ai_review = 'unconfirmed'
       AND (? IS NULL OR last_seen_at >= ?)
     ORDER BY id`,
  )
  const toPoint = (row: SnapshotPointRow): HistoryPoint => ({
    from: startIso && row.observed_at < startIso ? startIso : row.observed_at,
    to: row.last_seen_at,
    priceMinor: row.price_minor,
    currency: row.currency,
    availability: row.availability,
  })
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
        ) as SnapshotPointRow[]
      ).map(toPoint),
      unconfirmed: (
        unconfirmedFor.all(source.id, startIso, startIso) as SnapshotPointRow[]
      ).map(toPoint),
    }))
    .filter(
      (source) =>
        source.points.length || source.unconfirmed.length || !source.removed,
    )

  const events = (
    database
      .prepare(
        `SELECT * FROM (${EVENTS_SQL})
         WHERE knife_id = ? AND (? IS NULL OR occurred_at >= ?)
         ORDER BY occurred_at DESC, id DESC LIMIT 100`,
      )
      .all(knifeId, startIso, startIso) as EventRow[]
  ).map((row) => toEvent(row, knives))

  const stats = buildHistoryStats(database, knife)
  const since = stats.trackingSince
  const paid = parseStoredPrice(storedPrice(knife.specs))
  return {
    knife: knifeRef(knife, knife.id),
    paid: paid && paid.currency ? paid : null,
    range,
    rangeStart: startIso,
    chartStart: since && (!startIso || since > startIso) ? since : startIso,
    sources: history,
    events,
    stats,
  }
}

export type CheckOutcome = 'ok' | 'no_price' | 'failed' | 'blocked'

export type SourceCheckStep = { action: string; detail: string; result: string }

/** One finished check of a source, as the check history shows it. */
export type SourceCheck = {
  id: number
  startedAt: string
  /** scheduled | manual | retry | probe */
  trigger: string
  outcome: CheckOutcome
  /** http | browser | headed | ai | solver, or null when nothing loaded. */
  method: string | null
  attempt: number
  httpStatus: number | null
  errorCode: string | null
  errorMessage: string | null
  durationMs: number
  /** What the AI problem solver did on the page. */
  solverSteps: SourceCheckStep[]
  /** The reading the check stored or confirmed, when it read one. */
  reading: {
    priceMinor: number | null
    currency: string | null
    availability: Availability
    aiReview: 'confirmed' | 'unconfirmed' | null
  } | null
}

export type SourceCheckHistory = {
  source: {
    id: number
    knifeId: string
    storeName: string
    url: string
    removed: boolean
  }
  checks: SourceCheck[]
}

const clip = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.slice(0, max) : ''

function parseSolverSteps(value: string | null): SourceCheckStep[] {
  if (!value) return []
  try {
    const list = JSON.parse(value) as unknown
    if (!Array.isArray(list)) return []
    return list
      .filter(
        (step): step is Record<string, unknown> =>
          Boolean(step) && typeof step === 'object',
      )
      .slice(0, 12)
      .map((step) => ({
        action: clip(step.action, 40),
        detail: clip(step.detail, 200),
        result: clip(step.result, 200),
      }))
      .filter((step) => step.action)
  } catch {
    return []
  }
}

type CheckRow = {
  id: number
  started_at: string
  trigger: string
  outcome: CheckOutcome
  method: string | null
  attempt: number
  http_status: number | null
  error_code: string | null
  error_message: string | null
  duration_ms: number
  solver_steps: string | null
}

type ReadingRow = {
  id: number
  check_log_id: number | null
  observed_at: string
  last_seen_at: string
  price_minor: number | null
  currency: string | null
  availability: Availability
  ai_review: string | null
}

/**
 * The latest checks of one source (newest first) with the reading each one
 * stored or confirmed. A check that only confirmed the previous reading
 * extended that snapshot instead of linking one, so it is matched by time;
 * an `ai_unconfirmed` check prefers the unconfirmed reading it repeated.
 * No page content or keys are stored in the log, so none can leave here.
 */
export function readSourceChecks(
  database: Database.Database,
  sourceId: number,
  limit = 30,
): SourceCheckHistory | null {
  const source = database
    .prepare(
      'SELECT id, knife_id, store_name, url, removed_at FROM price_sources WHERE id = ?',
    )
    .get(sourceId) as
    | {
        id: number
        knife_id: string
        store_name: string
        url: string
        removed_at: string | null
      }
    | undefined
  if (!source) return null
  const rows = database
    .prepare(
      `SELECT id, started_at, trigger, outcome, method, attempt, http_status,
              error_code, error_message, duration_ms, solver_steps
       FROM price_check_log WHERE source_id = ?
       ORDER BY started_at DESC, id DESC LIMIT ?`,
    )
    .all(sourceId, limit) as CheckRow[]
  const oldest = rows.at(-1)?.started_at
  const readings = oldest
    ? (database
        .prepare(
          `SELECT id, check_log_id, observed_at, last_seen_at, price_minor,
                  currency, availability, ai_review
           FROM price_snapshots
           WHERE source_id = ? AND last_seen_at >= ?
           ORDER BY id DESC`,
        )
        .all(sourceId, oldest) as ReadingRow[])
    : []
  const linked = new Map(
    readings
      .filter((row) => row.check_log_id !== null)
      .map((row) => [row.check_log_id!, row]),
  )
  const readingFor = (row: CheckRow): ReadingRow | null => {
    const own = linked.get(row.id)
    if (own) return own
    if (row.outcome !== 'ok' && row.outcome !== 'no_price') return null
    const end = new Date(
      Date.parse(row.started_at) + row.duration_ms,
    ).toISOString()
    const candidates = readings.filter(
      (reading) =>
        reading.observed_at <= end && reading.last_seen_at >= row.started_at,
    )
    const wantUnconfirmed = row.error_code === 'ai_unconfirmed'
    return (
      candidates.find(
        (reading) => (reading.ai_review === 'unconfirmed') === wantUnconfirmed,
      ) ??
      candidates[0] ??
      null
    )
  }
  return {
    source: {
      id: source.id,
      knifeId: source.knife_id,
      storeName: source.store_name,
      url: source.url,
      removed: source.removed_at !== null,
    },
    checks: rows.map((row) => {
      const reading = readingFor(row)
      return {
        id: row.id,
        startedAt: row.started_at,
        trigger: row.trigger,
        outcome: row.outcome,
        method: row.method,
        attempt: row.attempt,
        httpStatus: row.http_status,
        errorCode: row.error_code,
        errorMessage: row.error_message
          ? row.error_message.slice(0, 500)
          : null,
        durationMs: row.duration_ms,
        solverSteps: parseSolverSteps(row.solver_steps),
        reading: reading
          ? {
              priceMinor: reading.price_minor,
              currency: reading.currency,
              availability: reading.availability,
              aiReview:
                reading.ai_review === 'confirmed' ||
                reading.ai_review === 'unconfirmed'
                  ? reading.ai_review
                  : null,
            }
          : null,
      }
    }),
  }
}
