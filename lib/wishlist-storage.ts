import type Database from 'better-sqlite3'
import { getLocalDb } from '@/lib/local-db'
import { readKnifeStores } from '@/lib/price-monitor/knife-stores'
import { getSettings } from '@/lib/settings'
import { withVaultWriteSync } from '@/lib/vault-access'
import {
  WISHLIST_LANES,
  type WishlistBudget,
  type WishlistCommand,
  type WishlistItem,
  type PriceTrends,
  type WishlistLane,
  type WishlistResponse,
  type WishlistTrend,
} from '@/lib/wishlist'

const DAY_MS = 24 * 60 * 60 * 1000
export const WISHLIST_TREND_DAYS = 30
export const WISHLIST_LOW_DAYS = 90
const BUDGET_KEY = 'monthly_budget'

export class WishlistError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message)
  }
}

type ItemRow = {
  knife_id: string
  lane: WishlistLane
  position: number
  target_minor: number | null
  target_currency: string | null
  added_at: string
}

function readItems(db: Database.Database): WishlistItem[] {
  const rows = db
    .prepare(
      `SELECT w.knife_id, w.lane, w.position, p.target_price_minor AS target_minor,
         p.target_currency, w.added_at
       FROM wishlist_items w JOIN knives k ON k.id = w.knife_id
       LEFT JOIN price_watch p ON p.knife_id = w.knife_id
       ORDER BY w.lane, w.position, w.added_at`,
    )
    .all() as ItemRow[]
  return rows.map((row) => ({
    knifeId: row.knife_id,
    lane: row.lane,
    position: row.position,
    targetMinor: row.target_minor,
    targetCurrency: row.target_currency,
    addedAt: row.added_at,
  }))
}

function readBudget(db: Database.Database): WishlistBudget {
  const row = db
    .prepare('SELECT value FROM wishlist_meta WHERE key = ?')
    .get(BUDGET_KEY) as { value: string } | undefined
  if (!row) return { amountMinor: null, currency: null }
  try {
    const parsed = JSON.parse(row.value) as Partial<WishlistBudget>
    return {
      amountMinor:
        typeof parsed.amountMinor === 'number' ? parsed.amountMinor : null,
      currency: typeof parsed.currency === 'string' ? parsed.currency : null,
    }
  } catch {
    return { amountMinor: null, currency: null }
  }
}

type SnapshotRow = {
  knife_id: string
  source_id: number
  price_minor: number | null
  currency: string | null
  availability: string
  observed_at: string
}

/**
 * Daily best in-stock price over the last 30 days and the 90-day low and
 * high, from price snapshots (oldest first) of one or more store links. A
 * snapshot holds its price until the next snapshot of the same store
 * replaces it. Null when nothing was in stock in the window.
 */
function trendFromSnapshots(
  rows: readonly SnapshotRow[],
  now: number,
): WishlistTrend | null {
  const priced = rows.filter(
    (row) =>
      row.price_minor !== null &&
      row.currency &&
      row.availability !== 'out_of_stock',
  )
  if (!priced.length) return null
  const counts = new Map<string, number>()
  for (const row of priced)
    counts.set(row.currency!, (counts.get(row.currency!) ?? 0) + 1)
  const currency = [...counts].sort((a, b) => b[1] - a[1])[0][0]
  const inCurrency = (row: SnapshotRow) =>
    row.price_minor !== null &&
    row.currency === currency &&
    row.availability !== 'out_of_stock'

  const bySource = new Map<number, SnapshotRow[]>()
  for (const row of rows) {
    const list = bySource.get(row.source_id) ?? []
    list.push(row)
    bySource.set(row.source_id, list)
  }
  /** Best in-stock price across the stores as of `end` (an ISO time). */
  const bestAt = (end: string) => {
    let best: number | null = null
    for (const list of bySource.values()) {
      let latest: SnapshotRow | undefined
      for (const row of list) {
        if (row.observed_at > end) break
        latest = row
      }
      if (latest && inCurrency(latest))
        best =
          best === null
            ? latest.price_minor!
            : Math.min(best, latest.price_minor!)
    }
    return best
  }
  const daily: Array<number | null> = []
  for (let day = WISHLIST_TREND_DAYS - 1; day >= 0; day--)
    daily.push(bestAt(new Date(now - day * DAY_MS).toISOString()))

  // The chart starts when tracking began, or 30 days ago if earlier, and
  // steps at every snapshot after that where the best price changed.
  const windowStart = now - WISHLIST_TREND_DAYS * DAY_MS
  const first = Date.parse(rows[0].observed_at)
  const chartStart = Math.max(first, windowStart)
  const steps: WishlistTrend['steps'] = []
  const times = new Set([chartStart])
  for (const row of rows) {
    const at = Date.parse(row.observed_at)
    if (at > chartStart && at <= now) times.add(at)
  }
  for (const at of [...times].sort((a, b) => a - b)) {
    const price = bestAt(new Date(at).toISOString())
    if (!steps.length || steps[steps.length - 1].price !== price)
      steps.push({ at, price })
  }
  const prices = priced.filter(inCurrency).map((row) => row.price_minor!)
  return {
    currency,
    daily,
    steps,
    since: chartStart,
    until: now,
    lowMinor: Math.min(...prices),
    highMinor: Math.max(...prices),
  }
}

const SNAPSHOT_COLUMNS =
  's.knife_id, s.source_id, s.price_minor, s.currency, s.availability, s.observed_at'

/** Best-price trends of each knife across its active store links. */
export function buildWishlistTrends(
  db: Database.Database,
  knifeIds: readonly string[],
  now = Date.now(),
): Record<string, WishlistTrend> {
  const trends: Record<string, WishlistTrend> = {}
  if (!knifeIds.length) return trends
  const since = new Date(now - WISHLIST_LOW_DAYS * DAY_MS).toISOString()
  const statement = db.prepare(
    `SELECT ${SNAPSHOT_COLUMNS}
     FROM price_snapshots s JOIN price_sources p ON p.id = s.source_id
     WHERE s.knife_id = ? AND p.removed_at IS NULL AND s.last_seen_at >= ?
       AND p.variant_search IS NULL
     ORDER BY s.observed_at, s.id`,
  )
  for (const knifeId of knifeIds) {
    const trend = trendFromSnapshots(
      statement.all(knifeId, since) as SnapshotRow[],
      now,
    )
    if (trend) trends[knifeId] = trend
  }
  return trends
}

/**
 * Trends for the Price Drops table, from one read of the last 90 days of
 * snapshots: each knife's best price across its enabled store links (paused
 * ones are not in the table either), and each enabled link on its own.
 */
export function buildPriceTrends(
  db: Database.Database,
  now = Date.now(),
): PriceTrends {
  const since = new Date(now - WISHLIST_LOW_DAYS * DAY_MS).toISOString()
  const rows = db
    .prepare(
      `SELECT ${SNAPSHOT_COLUMNS}
       FROM price_snapshots s JOIN price_sources p ON p.id = s.source_id
       WHERE p.removed_at IS NULL AND p.enabled = 1 AND s.last_seen_at >= ?
         AND p.variant_search IS NULL
       ORDER BY s.observed_at, s.id`,
    )
    .all(since) as SnapshotRow[]
  const byKnife = new Map<string, SnapshotRow[]>()
  const bySource = new Map<number, SnapshotRow[]>()
  const add = <K>(groups: Map<K, SnapshotRow[]>, key: K, row: SnapshotRow) => {
    const list = groups.get(key)
    if (list) list.push(row)
    else groups.set(key, [row])
  }
  for (const row of rows) {
    add(byKnife, row.knife_id, row)
    add(bySource, row.source_id, row)
  }
  const build = <K>(groups: Map<K, SnapshotRow[]>) => {
    const trends: Record<string, WishlistTrend> = {}
    for (const [key, list] of groups) {
      const trend = trendFromSnapshots(list, now)
      if (trend) trends[String(key)] = trend
    }
    return trends
  }
  return { knives: build(byKnife), sources: build(bySource) }
}

export function getWishlist(now = Date.now()): WishlistResponse {
  const db = getLocalDb()
  const items = readItems(db)
  const knifeIds = items.map((item) => item.knifeId)
  return {
    items,
    trends: buildWishlistTrends(db, knifeIds, now),
    budget: readBudget(db),
    stores: Object.fromEntries(
      readKnifeStores(db, knifeIds, getSettings().priceMonitoring),
    ),
  }
}

/** Renumbers a lane 0..n in the given order. */
function writeLaneOrder(
  db: Database.Database,
  lane: WishlistLane,
  knifeIds: readonly string[],
  now: string,
) {
  const update = db.prepare(
    'UPDATE wishlist_items SET lane = ?, position = ?, updated_at = ? WHERE knife_id = ?',
  )
  knifeIds.forEach((id, index) => update.run(lane, index, now, id))
}

function laneIds(db: Database.Database, lane: WishlistLane): string[] {
  return (
    db
      .prepare(
        'SELECT knife_id FROM wishlist_items WHERE lane = ? ORDER BY position, added_at',
      )
      .all(lane) as Array<{ knife_id: string }>
  ).map((row) => row.knife_id)
}

export function mutateWishlist(command: WishlistCommand): WishlistResponse {
  return withVaultWriteSync(() => {
    const db = getLocalDb()
    const undo = db.transaction((): WishlistCommand | undefined => {
      const now = new Date().toISOString()
      const before = readItems(db)
      const byId = new Map(before.map((item) => [item.knifeId, item]))
      switch (command.action) {
        case 'add': {
          const known = new Set(
            (
              db
                .prepare(
                  `SELECT id FROM knives WHERE id IN (${command.knifeIds.map(() => '?').join(',')})`,
                )
                .all(...command.knifeIds) as Array<{ id: string }>
            ).map((row) => row.id),
          )
          const fresh = [...new Set(command.knifeIds)].filter(
            (id) => known.has(id) && !byId.has(id),
          )
          if (!known.size)
            throw new WishlistError(
              'This knife is no longer in your vault.',
              404,
            )
          const start = laneIds(db, command.lane).length
          const insert = db.prepare(
            `INSERT INTO wishlist_items (knife_id, lane, position, added_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          fresh.forEach((id, index) =>
            insert.run(id, command.lane, start + index, now, now),
          )
          return fresh.length
            ? { action: 'remove', knifeIds: fresh }
            : undefined
        }
        case 'remove': {
          const removed = command.knifeIds
            .map((id) => byId.get(id))
            .filter((item): item is WishlistItem => Boolean(item))
          const remove = db.prepare(
            'DELETE FROM wishlist_items WHERE knife_id = ?',
          )
          for (const item of removed) remove.run(item.knifeId)
          return removed.length
            ? { action: 'restore', items: removed }
            : undefined
        }
        case 'move': {
          const item = byId.get(command.knifeId)
          if (!item)
            throw new WishlistError('This knife is not on your wishlist.', 404)
          const from = laneIds(db, item.lane).filter(
            (id) => id !== command.knifeId,
          )
          if (item.lane !== command.lane)
            writeLaneOrder(db, item.lane, from, now)
          const target =
            item.lane === command.lane
              ? from
              : laneIds(db, command.lane).filter((id) => id !== command.knifeId)
          const at =
            command.beforeKnifeId && target.includes(command.beforeKnifeId)
              ? target.indexOf(command.beforeKnifeId)
              : target.length
          target.splice(at, 0, command.knifeId)
          writeLaneOrder(db, command.lane, target, now)
          return undefined
        }
        case 'budget': {
          if (!command.amountMinor)
            db.prepare('DELETE FROM wishlist_meta WHERE key = ?').run(
              BUDGET_KEY,
            )
          else
            db.prepare(
              `INSERT INTO wishlist_meta (key, value) VALUES (?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            ).run(
              BUDGET_KEY,
              JSON.stringify({
                amountMinor: command.amountMinor,
                currency: command.currency,
              }),
            )
          return undefined
        }
        case 'restore': {
          const insert = db.prepare(
            `INSERT OR REPLACE INTO wishlist_items
               (knife_id, lane, position, added_at, updated_at)
             SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM knives WHERE id = ?)`,
          )
          const lanes = new Set<WishlistLane>()
          for (const item of command.items) {
            insert.run(
              item.knifeId,
              item.lane,
              item.position,
              item.addedAt,
              now,
              item.knifeId,
            )
            lanes.add(item.lane)
          }
          // Keep restored knives at their old places among the rest.
          for (const lane of WISHLIST_LANES)
            if (lanes.has(lane))
              writeLaneOrder(db, lane, laneIds(db, lane), now)
          return undefined
        }
      }
    })()
    return { ...getWishlist(), ...(undo ? { undo } : {}) }
  })
}
