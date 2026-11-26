import type Database from 'better-sqlite3'
import {
  getEligibility,
  type EligibilitySettings,
} from '@/lib/price-monitor/eligibility'
import { parseStoredPrice, toMinorUnits } from '@/lib/price-monitor/money'
import { withMonitorScope } from '@/lib/price-monitor/scope'
import {
  classifyPriceMoves,
  type PriceMoveClass,
  type PriceMoveEvent,
} from '@/lib/price-monitor/price-moves'
import type { Availability, PriceWatchMode } from '@/lib/price-monitor/shared'
import {
  MARKET_DROP_WINDOW_DAYS,
  MARKET_RESTOCK_WINDOW_DAYS,
  type KnifeMarketSummary,
} from '@/lib/market-status'

const DAY_MS = 24 * 60 * 60 * 1000

type KnifeRow = {
  id: string
  specs: string
  sold: number
  mode: PriceWatchMode
}

type SourceRow = {
  id: number
  knife_id: string
  last_price_minor: number | null
  last_currency: string | null
  last_availability: Availability | null
  last_checked_at: string | null
}

type ChangeRow = {
  id: number
  source_id: number
  previous_price_minor: number | null
  price_minor: number | null
  currency: string | null
  occurred_at: string
}

/**
 * Eligibility plus the notification Minimum change, which decides which
 * price moves count as a drop, as on the Price Drops page.
 */
export type MarketSummarySettings = EligibilitySettings & {
  thresholds?: { minPercent: number }
}

function storedPrice(specs: string): string | undefined {
  try {
    return (JSON.parse(specs) as { price?: string }).price
  } catch {
    return undefined
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

function latest(values: Array<string | null | undefined>): string | null {
  let result: string | null = null
  for (const value of values)
    if (value && (!result || value > result)) result = value
  return result
}

/**
 * One market summary per knife that has enabled store links, keyed by knife
 * id, for collection cards, the table column and the `market=` filter. Only
 * enabled, not-removed sources count, matching what monitoring checks.
 * Nothing here writes.
 */
export function buildMarketSummaries(
  database: Database.Database,
  settings: MarketSummarySettings,
  now = Date.now(),
): Record<string, KnifeMarketSummary> {
  const sources = database
    .prepare(
      `SELECT id, knife_id, last_price_minor, last_currency,
              last_availability, last_checked_at
       FROM price_sources
       WHERE removed_at IS NULL AND enabled = 1 AND variant_search IS NULL`,
    )
    .all() as SourceRow[]
  if (!sources.length) return {}

  const sourcesByKnife = new Map<string, SourceRow[]>()
  for (const source of sources) {
    const list = sourcesByKnife.get(source.knife_id) ?? []
    list.push(source)
    sourcesByKnife.set(source.knife_id, list)
  }

  const knives = new Map(
    (
      database
        .prepare(
          `SELECT k.id, k.specs, k.sold, COALESCE(w.mode, 'auto') AS mode
           FROM knives k LEFT JOIN price_watch w ON w.knife_id = k.id
           WHERE k.id IN (SELECT knife_id FROM price_sources
                          WHERE removed_at IS NULL AND enabled = 1
                            AND variant_search IS NULL)`,
        )
        .all() as KnifeRow[]
    ).map((row) => [row.id, row]),
  )

  // Each source's price changes inside the drop window, classified like the
  // Price Drops page: moves under the Minimum change and bounces back to an
  // earlier level are no change, and a drop only counts while it stands.
  const dropSince = new Date(
    now - MARKET_DROP_WINDOW_DAYS * DAY_MS,
  ).toISOString()
  const changesBySource = new Map<number, PriceMoveEvent[]>()
  for (const row of database
    .prepare(
      `SELECT id, source_id, previous_price_minor, price_minor, currency,
              occurred_at
       FROM price_change_events WHERE occurred_at >= ?
       ORDER BY occurred_at ASC, id ASC`,
    )
    .all(dropSince) as ChangeRow[]) {
    if (row.previous_price_minor === null || row.price_minor === null) continue
    const list = changesBySource.get(row.source_id) ?? []
    list.push({
      id: row.id,
      previousPriceMinor: row.previous_price_minor,
      priceMinor: row.price_minor,
      currency: row.currency,
      occurredAt: row.occurred_at,
    })
    changesBySource.set(row.source_id, list)
  }
  const minPercent = settings.thresholds?.minPercent ?? 0
  const moveFor = (source: SourceRow): PriceMoveClass | null => {
    const events = changesBySource.get(source.id)
    return events
      ? classifyPriceMoves(
          events,
          {
            priceMinor: source.last_price_minor,
            currency: source.last_currency,
          },
          minPercent,
        )
      : null
  }

  const restockSince = new Date(
    now - MARKET_RESTOCK_WINDOW_DAYS * DAY_MS,
  ).toISOString()
  const restockedAt = new Map(
    (
      database
        .prepare(
          `SELECT source_id, MAX(occurred_at) AS at FROM stock_events
           WHERE kind = 'back_in_stock' AND occurred_at >= ?
           GROUP BY source_id`,
        )
        .all(restockSince) as Array<{ source_id: number; at: string }>
    ).map((row) => [row.source_id, row.at]),
  )
  const outOfStockSince = new Map(
    (
      database
        .prepare(
          `SELECT source_id, MAX(occurred_at) AS at FROM stock_events
           WHERE kind = 'out_of_stock' GROUP BY source_id`,
        )
        .all() as Array<{ source_id: number; at: string }>
    ).map((row) => [row.source_id, row.at]),
  )

  // A store that was out of stock on its first check has no stock event;
  // its current snapshot started then.
  const currentSnapshotSince = new Map(
    (
      database
        .prepare(
          `SELECT source_id, observed_at AS at FROM price_snapshots
           WHERE id IN (SELECT MAX(id) FROM price_snapshots GROUP BY source_id)
             AND availability = 'out_of_stock'`,
        )
        .all() as Array<{ source_id: number; at: string }>
    ).map((row) => [row.source_id, row.at]),
  )

  const scoped = withMonitorScope(database, settings)
  const result: Record<string, KnifeMarketSummary> = {}
  for (const [knifeId, list] of sourcesByKnife) {
    const knife = knives.get(knifeId)
    if (!knife) continue
    const purchase = storedPrice(knife.specs)
    const monitored = getEligibility(
      { id: knifeId, sold: knife.sold === 1, specs: { price: purchase } },
      knife.mode,
      list.length,
      scoped,
    ).monitored

    const inStock = list.filter(
      (source) =>
        source.last_checked_at && source.last_availability !== 'out_of_stock',
    )
    const priced = inStock.filter(
      (source) => source.last_price_minor !== null && source.last_currency,
    )
    const currency = mostCommon(priced.map((source) => source.last_currency!))
    const inCurrency = priced.filter(
      (source) => source.last_currency === currency,
    )
    const bestPriceMinor = inCurrency.length
      ? Math.min(...inCurrency.map((source) => source.last_price_minor!))
      : null
    const paid = parseStoredPrice(purchase)
    const paidMinor =
      paid && currency && (paid.currency === currency || !paid.currency)
        ? toMinorUnits(paid.amount, currency)
        : null

    const read = list.filter((source) => source.last_availability !== null)
    const outOfStock =
      read.length > 0 &&
      read.every((source) => source.last_availability === 'out_of_stock')

    // The latest counted drop that still holds on an in-stock source.
    const drop = priced
      .map(moveFor)
      .filter(
        (move): move is PriceMoveClass & { changedAt: string } =>
          move?.result === 'drop' && Boolean(move.changedAt),
      )
      .sort((a, b) => b.changedAt.localeCompare(a.changedAt))[0]

    result[knifeId] = {
      monitored,
      sources: list.length,
      bestPriceMinor,
      currency,
      paidMinor,
      outOfStock,
      outOfStockSince: outOfStock
        ? latest(
            read.map(
              (source) =>
                outOfStockSince.get(source.id) ??
                currentSnapshotSince.get(source.id),
            ),
          )
        : null,
      droppedAt: outOfStock ? null : (drop?.changedAt ?? null),
      dropPct: outOfStock ? null : (drop?.deltaPct ?? null),
      restockedAt: outOfStock
        ? null
        : latest(inStock.map((source) => restockedAt.get(source.id))),
      lastCheckedAt: latest(list.map((source) => source.last_checked_at)),
    }
  }
  return result
}
