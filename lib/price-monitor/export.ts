import type Database from 'better-sqlite3'
import { CSV_BOM, csvLine, type CsvValue } from '@/lib/csv'
import { rangeStart, type HistoryRange } from '@/lib/price-monitor/insights'
import { fromMinorUnits } from '@/lib/price-monitor/money'

/**
 * CSV export of price history. Rows come straight from the permanent
 * history tables; nothing here writes. The regular price, notes and other
 * collection fields are left out on purpose: the file holds only what
 * stores published, so it can be shared without exposing the collection.
 */

export const PRICE_EXPORT_KINDS = ['snapshots', 'events'] as const
export type PriceExportKind = (typeof PRICE_EXPORT_KINDS)[number]

export type PriceExportOptions = {
  kind: PriceExportKind
  /** One knife, or every knife with price history when null. */
  knifeId: string | null
  range: HistoryRange
  now?: number
}

export const SNAPSHOT_COLUMNS = [
  'observed_at',
  'last_seen_at',
  'observations',
  'knife_id',
  'knife_brand',
  'knife_name',
  'store',
  'url',
  'price',
  'currency',
  'availability',
  'extraction_method',
  'ai_review',
] as const

export const EVENT_COLUMNS = [
  'occurred_at',
  'type',
  'kind',
  'knife_id',
  'knife_brand',
  'knife_name',
  'store',
  'url',
  'previous_price',
  'price',
  'currency',
  'change',
  'change_pct',
  'previous_availability',
  'availability',
  'extraction_method',
] as const

/** Rows read per query, so a long export never holds the connection. */
const PAGE_SIZE = 500

function major(minor: number | null, currency: string | null): number | null {
  return minor === null || !currency ? null : fromMinorUnits(minor, currency)
}

type SnapshotRow = {
  id: number
  observed_at: string
  last_seen_at: string
  observations: number
  knife_id: string
  brand: string | null
  name: string | null
  store_name: string | null
  url: string | null
  price_minor: number | null
  currency: string | null
  availability: string
  extraction_method: string
  ai_review: string | null
}

/**
 * A range keeps every state that was current at some point in it: states
 * seen since the start, plus the state each store showed when it began
 * (the same rows the history chart draws).
 */
const SNAPSHOTS_SQL = `
  SELECT s.id, s.observed_at, s.last_seen_at, s.observations, s.knife_id,
         k.brand, k.name, src.store_name, src.url, s.price_minor, s.currency,
         s.availability, s.extraction_method, s.ai_review
  FROM price_snapshots s
  LEFT JOIN price_sources src ON src.id = s.source_id
  LEFT JOIN knives k ON k.id = s.knife_id
  WHERE s.id > @after
    AND (@knifeId IS NULL OR s.knife_id = @knifeId)
    AND (@start IS NULL OR s.last_seen_at >= @start OR NOT EXISTS (
      SELECT 1 FROM price_snapshots n
      WHERE n.source_id = s.source_id AND n.id > s.id
        AND n.observed_at < @start))
  ORDER BY s.id
  LIMIT ${PAGE_SIZE}`

function snapshotLine(row: SnapshotRow): string {
  const values: CsvValue[] = [
    row.observed_at,
    row.last_seen_at,
    row.observations,
    row.knife_id,
    row.brand,
    row.name,
    row.store_name,
    row.url,
    major(row.price_minor, row.currency),
    row.currency,
    row.availability,
    row.extraction_method,
    row.ai_review,
  ]
  return csvLine(values)
}

type EventRow = {
  type: 'price' | 'stock'
  id: number
  occurred_at: string
  kind: string
  knife_id: string
  brand: string | null
  name: string | null
  store_name: string
  source_url: string
  previous_price_minor: number | null
  price_minor: number | null
  currency: string | null
  delta_minor: number | null
  delta_pct: number | null
  previous_availability: string | null
  availability: string
  extraction_method: string | null
}

// Price and stock events merged by time; (occurred_at, type, id) is the
// page cursor.
const EVENTS_SQL = `
  SELECT e.*, k.brand, k.name FROM (
    SELECT 'price' AS type, id, occurred_at, direction AS kind, knife_id,
           store_name, source_url, previous_price_minor, price_minor,
           currency, delta_minor, delta_pct, NULL AS previous_availability,
           availability, extraction_method
    FROM price_change_events
    UNION ALL
    SELECT 'stock', id, occurred_at, kind, knife_id, store_name, source_url,
           NULL, price_minor, currency, NULL, NULL, previous_availability,
           availability, NULL
    FROM stock_events
  ) e
  LEFT JOIN knives k ON k.id = e.knife_id
  WHERE (e.occurred_at, e.type, e.id) > (@afterAt, @afterType, @afterId)
    AND (@knifeId IS NULL OR e.knife_id = @knifeId)
    AND (@start IS NULL OR e.occurred_at >= @start)
  ORDER BY e.occurred_at, e.type, e.id
  LIMIT ${PAGE_SIZE}`

function eventLine(row: EventRow): string {
  const values: CsvValue[] = [
    row.occurred_at,
    row.type,
    row.kind,
    row.knife_id,
    row.brand,
    row.name,
    row.store_name,
    row.source_url,
    major(row.previous_price_minor, row.currency),
    major(row.price_minor, row.currency),
    row.currency,
    major(row.delta_minor, row.currency),
    row.delta_pct,
    row.previous_availability,
    row.availability,
    row.extraction_method,
  ]
  return csvLine(values)
}

/**
 * The export as CSV chunks: a byte-order mark and header first, then one
 * chunk per page of rows. Each page is a separate query, so the shared
 * connection is free between chunks while the response streams.
 */
export function* priceExportChunks(
  database: Database.Database,
  options: PriceExportOptions,
): Generator<string> {
  const start = rangeStart(options.range, options.now ?? Date.now())
  const startIso = start === null ? null : new Date(start).toISOString()
  const knifeId = options.knifeId

  if (options.kind === 'snapshots') {
    yield CSV_BOM + csvLine(SNAPSHOT_COLUMNS)
    const page = database.prepare(SNAPSHOTS_SQL)
    let after = 0
    while (true) {
      const rows = page.all({
        after,
        knifeId,
        start: startIso,
      }) as SnapshotRow[]
      if (!rows.length) return
      yield rows.map(snapshotLine).join('')
      if (rows.length < PAGE_SIZE) return
      after = rows[rows.length - 1].id
    }
  }

  yield CSV_BOM + csvLine(EVENT_COLUMNS)
  const page = database.prepare(EVENTS_SQL)
  let cursor = { afterAt: '', afterType: '', afterId: 0 }
  while (true) {
    const rows = page.all({ ...cursor, knifeId, start: startIso }) as EventRow[]
    if (!rows.length) return
    yield rows.map(eventLine).join('')
    if (rows.length < PAGE_SIZE) return
    const last = rows[rows.length - 1]
    cursor = {
      afterAt: last.occurred_at,
      afterType: last.type,
      afterId: last.id,
    }
  }
}

function slug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
}

function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** e.g. bladevault-price-history-vosteed-raccoon-3m-2026-11-19.csv */
export function priceExportFilename(
  kind: PriceExportKind,
  knife: { brand: string; name: string } | null,
  range: HistoryRange,
  now = new Date(),
): string {
  const parts = [
    'bladevault',
    kind === 'events' ? 'price-events' : 'price-history',
    knife ? slug(`${knife.brand} ${knife.name}`) || 'knife' : '',
    range === 'all' ? '' : range,
    localDay(now),
  ]
  return `${parts.filter(Boolean).join('-')}.csv`
}
