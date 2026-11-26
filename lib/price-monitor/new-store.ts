import type Database from 'better-sqlite3'
import type { PriceNotificationEvent } from '@/lib/price-monitor/notifications'
import type { Availability } from '@/lib/price-monitor/shared'

/**
 * A knife's stores are one item. A store's first reading is only a baseline
 * for that store, but for the knife it can be news: a store just added
 * (often found by Other stores on Blade HQ, SMKW or DLT Trading, or added from Amazon) may sell it cheaper
 * than its other stores, or sell it while every other store is out. Those
 * become a price drop or a back-in-stock event of the new store, measured
 * against the knife's other stores (`previous_source_id`), so Price Drops,
 * the chart and the Inbox show them like any other change.
 *
 * No local-db import: local-db runs the backfill when the column arrives.
 */

export type StoreReading = {
  priceMinor: number | null
  currency: string | null
  availability: Availability
}

/** Another store's reading in force at that moment. */
export type OtherStoreReading = StoreReading & {
  sourceId: number
  snapshotId: number
}

export type NewStoreEvent =
  | {
      kind: 'drop'
      /** The knife's cheapest other store selling it. */
      previous: OtherStoreReading & { priceMinor: number; currency: string }
      deltaMinor: number
      deltaPct: number
    }
  | {
      kind: 'back_in_stock'
      /** An other store that had the knife out of stock. */
      previous: OtherStoreReading
    }

const TRUSTED = "(ai_review IS NULL OR ai_review <> 'unconfirmed')"

function forSale(reading: StoreReading): boolean {
  return (
    reading.priceMinor !== null &&
    reading.currency !== null &&
    reading.availability !== 'out_of_stock'
  )
}

/**
 * What a new store's first reading means for the knife: cheaper than every
 * other store selling it (same currency) is a drop; selling it while the
 * other stores are out of stock is back in stock. Null when the new store
 * does not sell it, the knife had no other store, or nothing changed.
 */
export function planNewStoreEvent(
  reading: StoreReading,
  others: readonly OtherStoreReading[],
): NewStoreEvent | null {
  if (!forSale(reading) || !others.length) return null
  const selling = others.filter(forSale)
  if (!selling.length) {
    const out = others.find((other) => other.availability === 'out_of_stock')
    return out ? { kind: 'back_in_stock', previous: out } : null
  }
  const cheapest = selling
    .filter((other) => other.currency === reading.currency)
    .sort((a, b) => a.priceMinor! - b.priceMinor! || a.sourceId - b.sourceId)[0]
  if (!cheapest || reading.priceMinor! >= cheapest.priceMinor!) return null
  const deltaMinor = reading.priceMinor! - cheapest.priceMinor!
  return {
    kind: 'drop',
    previous: {
      ...cheapest,
      priceMinor: cheapest.priceMinor!,
      currency: cheapest.currency!,
    },
    deltaMinor,
    deltaPct: Math.round((deltaMinor / cheapest.priceMinor!) * 10_000) / 100,
  }
}

/**
 * The knife's other monitored stores (paused ones left out) with the
 * trusted reading each showed at `at`.
 */
export function readOtherStoresAt(
  database: Database.Database,
  input: { knifeId: string; sourceId: number; at: string },
): OtherStoreReading[] {
  return (
    database
      .prepare(
        `SELECT s.id AS sourceId, p.id AS snapshotId, p.price_minor AS priceMinor,
                p.currency, p.availability
         FROM price_sources s
         JOIN price_snapshots p ON p.id = (
           SELECT id FROM price_snapshots
           WHERE source_id = s.id AND observed_at <= ? AND ${TRUSTED}
           ORDER BY observed_at DESC, id DESC LIMIT 1)
         WHERE s.knife_id = ? AND s.id <> ? AND s.enabled = 1
           AND s.variant_search IS NULL
           AND (s.removed_at IS NULL OR s.removed_at > ?)
         ORDER BY s.id`,
      )
      .all(input.at, input.knifeId, input.sourceId, input.at) as Array<
      OtherStoreReading & { priceMinor: number | null }
    >
  ).map((row) => ({ ...row, availability: row.availability as Availability }))
}

export type NewStoreReading = {
  knifeId: string
  sourceId: number
  sourceUrl: string
  storeName: string
  /** The store's first trusted snapshot. */
  snapshotId: number
  reading: StoreReading
  extractionMethod: string
  occurredAt: string
}

/**
 * Stores the knife-level event of a store's first reading, if any, and
 * returns it for the Inbox. Repeat-safe: a snapshot with an event already
 * gets none.
 */
export function recordNewStoreEvent(
  database: Database.Database,
  input: NewStoreReading,
): PriceNotificationEvent | null {
  const taken = database
    .prepare(
      `SELECT 1 FROM price_change_events WHERE to_snapshot_id = ?
       UNION ALL SELECT 1 FROM stock_events WHERE to_snapshot_id = ?`,
    )
    .get(input.snapshotId, input.snapshotId)
  if (taken) return null
  const event = planNewStoreEvent(
    input.reading,
    readOtherStoresAt(database, {
      knifeId: input.knifeId,
      sourceId: input.sourceId,
      at: input.occurredAt,
    }),
  )
  if (!event) return null
  const { reading } = input
  if (event.kind === 'drop') {
    const eventId = Number(
      database
        .prepare(
          `INSERT INTO price_change_events
            (knife_id, source_id, direction, previous_price_minor, price_minor,
             currency, delta_minor, delta_pct, availability, from_snapshot_id,
             to_snapshot_id, source_url, store_name, extraction_method,
             occurred_at, previous_source_id)
           VALUES (?, ?, 'drop', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.knifeId,
          input.sourceId,
          event.previous.priceMinor,
          reading.priceMinor,
          reading.currency,
          event.deltaMinor,
          event.deltaPct,
          reading.availability,
          event.previous.snapshotId,
          input.snapshotId,
          input.sourceUrl,
          input.storeName,
          input.extractionMethod,
          input.occurredAt,
          event.previous.sourceId,
        ).lastInsertRowid,
    )
    return {
      kind: 'drop',
      eventId,
      knifeId: input.knifeId,
      sourceId: input.sourceId,
      currency: reading.currency!,
      deltaMinor: event.deltaMinor,
      deltaPct: event.deltaPct,
      priceMinor: reading.priceMinor!,
    }
  }
  const eventId = Number(
    database
      .prepare(
        `INSERT INTO stock_events
          (knife_id, source_id, kind, previous_availability, availability,
           price_minor, currency, from_snapshot_id, to_snapshot_id,
           source_url, store_name, occurred_at, previous_source_id)
         VALUES (?, ?, 'back_in_stock', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.knifeId,
        input.sourceId,
        event.previous.availability,
        reading.availability,
        reading.priceMinor,
        reading.currency,
        event.previous.snapshotId,
        input.snapshotId,
        input.sourceUrl,
        input.storeName,
        input.occurredAt,
        event.previous.sourceId,
      ).lastInsertRowid,
  )
  return {
    kind: 'back_in_stock',
    eventId,
    knifeId: input.knifeId,
    sourceId: input.sourceId,
  }
}

/**
 * Gives stores added before this rule their knife-level event: each active
 * store's first trusted reading, judged against the other stores at that
 * moment. History only, no Inbox notifications. Repeat-safe.
 */
export function backfillNewStoreEvents(database: Database.Database): number {
  const rows = database
    .prepare(
      `SELECT s.knife_id AS knifeId, s.id AS sourceId, s.url AS sourceUrl,
              s.store_name AS storeName, p.id AS snapshotId,
              p.price_minor AS priceMinor, p.currency, p.availability,
              p.extraction_method AS extractionMethod,
              p.observed_at AS occurredAt
       FROM price_sources s
       JOIN price_snapshots p ON p.id = (
         SELECT id FROM price_snapshots
         WHERE source_id = s.id AND ${TRUSTED}
         ORDER BY observed_at, id LIMIT 1)
       WHERE s.removed_at IS NULL AND s.variant_search IS NULL
       ORDER BY p.observed_at, p.id`,
    )
    .all() as Array<
    Omit<NewStoreReading, 'reading'> & StoreReading & { availability: string }
  >
  let added = 0
  for (const row of rows) {
    const event = recordNewStoreEvent(database, {
      knifeId: row.knifeId,
      sourceId: row.sourceId,
      sourceUrl: row.sourceUrl,
      storeName: row.storeName,
      snapshotId: row.snapshotId,
      reading: {
        priceMinor: row.priceMinor,
        currency: row.currency,
        availability: row.availability as Availability,
      },
      extractionMethod: row.extractionMethod,
      occurredAt: row.occurredAt,
    })
    if (event) added += 1
  }
  return added
}
