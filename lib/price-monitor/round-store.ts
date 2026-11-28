import type Database from 'better-sqlite3'
import { getLocalDb } from '@/lib/local-db'
import { readDiscoveryQueue } from '@/lib/price-monitor/discovery-store'
import { DISCOVERY_STORES } from '@/lib/price-monitor/discovery-stores'
import { getEligibility } from '@/lib/price-monitor/eligibility'
import { retryKey, type RetryReason } from '@/lib/price-monitor/rounds'
import { withMonitorScope } from '@/lib/price-monitor/scope'
import type { MonitorTier, PriceWatchMode } from '@/lib/price-monitor/shared'
import {
  OTHER_STORE_IDS,
  type OtherStoreId,
  type PriceMonitoringSettings,
} from '@/lib/settings-shared'
import { assertVaultGeneration, withVaultWrite } from '@/lib/vault-access'

/**
 * Rounds and the retry list in SQLite (price_rounds, price_retry_tasks), so a
 * restart resumes a round at the knife it was on. See rounds.ts.
 */
const DAY_MS = 24 * 60 * 60 * 1000
/** Finished rounds are kept this long (Price Drops shows the latest). */
const ROUND_HISTORY_MS = 30 * DAY_MS

export type RoundTrigger = 'scheduled' | 'manual'

export type Round = {
  id: number
  trigger: RoundTrigger
  startedAt: number
  finishedAt: number | null
  intervalMs: number
  knifeIds: string[]
  /** Index of the next knife to check. */
  cursor: number
}

type RoundRow = {
  id: number
  trigger: string
  started_at: string
  finished_at: string | null
  interval_ms: number
  knife_ids: string
  cursor: number
}

export type RetryTask = {
  key: string
  kind: 'check' | 'search'
  knifeId: string
  sourceId: number | null
  store: OtherStoreId | null
  laneKey: string
  reason: RetryReason
  attempts: number
  dueAt: number | null
  lastError: string | null
}

type RetryRow = {
  task_key: string
  kind: 'check' | 'search'
  knife_id: string
  source_id: number | null
  store: string | null
  lane_key: string
  reason: string
  attempts: number
  due_at: string | null
  last_error: string | null
}

const iso = (value: number) => new Date(value).toISOString()
const time = (value: string | null) => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function toRound(row: RoundRow | undefined): Round | null {
  if (!row) return null
  let knifeIds: string[] = []
  try {
    const parsed = JSON.parse(row.knife_ids) as unknown
    if (Array.isArray(parsed))
      knifeIds = parsed.filter((id): id is string => typeof id === 'string')
  } catch {
    knifeIds = []
  }
  return {
    id: row.id,
    trigger: row.trigger === 'manual' ? 'manual' : 'scheduled',
    startedAt: time(row.started_at) ?? 0,
    finishedAt: time(row.finished_at),
    intervalMs: row.interval_ms,
    knifeIds,
    cursor: row.cursor,
  }
}

function toRetry(row: RetryRow): RetryTask {
  return {
    key: row.task_key,
    kind: row.kind,
    knifeId: row.knife_id,
    sourceId: row.source_id,
    store: row.store as OtherStoreId | null,
    laneKey: row.lane_key,
    reason: row.reason as RetryReason,
    attempts: row.attempts,
    dueAt: time(row.due_at),
    lastError: row.last_error,
  }
}

/** The round in progress, if any. */
export function readCurrentRound(database: Database.Database): Round | null {
  return toRound(
    database
      .prepare(
        `SELECT * FROM price_rounds WHERE finished_at IS NULL
         ORDER BY id DESC LIMIT 1`,
      )
      .get() as RoundRow | undefined,
  )
}

/** The latest round, running or finished. */
export function readLastRound(database: Database.Database): Round | null {
  return toRound(
    database
      .prepare('SELECT * FROM price_rounds ORDER BY id DESC LIMIT 1')
      .get() as RoundRow | undefined,
  )
}

const WISHLIST_ORDER = `CASE w.lane WHEN 'next' THEN 0 WHEN 'saving' THEN 1
  WHEN 'someday' THEN 2 ELSE 3 END`

/**
 * The knives a round goes through, in order (see orderKnives). A knife
 * counts when monitoring covers it (What to monitor, its watch mode, a
 * regular price) and it has an enabled store link, or Other stores can look
 * for it. Knives of the collection pass are left out.
 */
export function readRoundKnifeIds(
  database: Database.Database,
  settings: PriceMonitoringSettings,
  options: KnifeListOptions,
): string[] {
  return readTierKnifeIds(database, settings, options, 'scope')
}

type KnifeListOptions = {
  /** Other stores searches run in this round or pass. */
  searches: boolean
  now?: number
}

type KnifeOrderRow = {
  id: string
  onWishlist: boolean
  /** An enabled store link that was never checked. */
  neverChecked: boolean
  /** Never searched at one of the Other stores that would search for it. */
  neverSearched: boolean
  /** The knife's least recent check (epoch ms), null when none ran. */
  oldestCheck: number | null
  addedAt: string
}

function orderGroup(row: KnifeOrderRow): number {
  if (row.onWishlist) return 0
  if (row.neverChecked) return 1
  if (row.neverSearched) return 2
  return 3
}

/**
 * The order knives are checked in: the Wishlist first (Next, Saving,
 * Someday, each in its own order), then knives with a store link never
 * checked, then knives never searched in Other stores, then the rest by
 * their oldest check, so the knife that waited longest always comes next.
 * `rows` arrive in Wishlist order; the sort keeps it within the Wishlist.
 */
export function orderKnives(rows: readonly KnifeOrderRow[]): string[] {
  return rows
    .map((row, index) => ({ row, index, group: orderGroup(row) }))
    .sort((a, b) => {
      if (a.group !== b.group) return a.group - b.group
      if (a.group === 0) return a.index - b.index
      if (a.group === 3) {
        const at = a.row.oldestCheck ?? -Infinity
        const bt = b.row.oldestCheck ?? -Infinity
        if (at !== bt) return at - bt
      }
      if (a.row.addedAt !== b.row.addedAt)
        return a.row.addedAt < b.row.addedAt ? -1 : 1
      return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0
    })
    .map(({ row }) => row.id)
}

/** Knives never searched at any Other store that would search for them. */
function readNeverSearchedKnifeIds(
  database: Database.Database,
  settings: PriceMonitoringSettings,
  now: number,
): Set<string> {
  const ids = new Set<string>()
  for (const store of OTHER_STORE_IDS) {
    if (!settings.otherStores.stores[store]) continue
    const config = DISCOVERY_STORES[store]
    for (const id of readDiscoveryQueue(database, {
      settings,
      store,
      marketplace: config.marketplace,
      laneKey: config.laneKey,
      now,
      limit: Infinity,
      neverSearched: true,
    }))
      ids.add(id)
  }
  return ids
}

function readTierKnifeIds(
  database: Database.Database,
  settings: PriceMonitoringSettings,
  options: KnifeListOptions,
  tier: MonitorTier,
): string[] {
  const rows = database
    .prepare(
      `SELECT k.id, k.specs, k.sold, k.added_at,
              COALESCE(pw.mode, 'auto') AS mode,
              w.knife_id IS NOT NULL AS on_wishlist,
              (SELECT COUNT(*) FROM price_sources s
               WHERE s.knife_id = k.id AND s.removed_at IS NULL
                 AND s.enabled = 1) AS sources,
              EXISTS (SELECT 1 FROM price_sources s
                      WHERE s.knife_id = k.id AND s.removed_at IS NULL
                        AND s.enabled = 1
                        AND s.last_checked_at IS NULL) AS never_checked,
              (SELECT MIN(s.last_checked_at) FROM price_sources s
               WHERE s.knife_id = k.id AND s.removed_at IS NULL
                 AND s.enabled = 1) AS oldest_check,
              (SELECT MIN(d.last_attempt_at) FROM price_discovery d
               WHERE d.knife_id = k.id) AS oldest_search
       FROM knives k
       LEFT JOIN wishlist_items w ON w.knife_id = k.id
       LEFT JOIN price_watch pw ON pw.knife_id = k.id
       ORDER BY ${WISHLIST_ORDER}, w.position, k.added_at, k.id`,
    )
    .all() as Array<{
    id: string
    specs: string
    sold: number
    added_at: string
    mode: PriceWatchMode
    on_wishlist: number
    sources: number
    never_checked: number
    oldest_check: string | null
    oldest_search: string | null
  }>
  const scoped = withMonitorScope(database, settings)
  const neverSearched = options.searches
    ? readNeverSearchedKnifeIds(database, scoped, options.now ?? Date.now())
    : new Set<string>()
  const eligible = rows.filter((row) => {
    if (!row.sources && !options.searches) return false
    let price: string | undefined
    try {
      price = (JSON.parse(row.specs) as { price?: string }).price
    } catch {
      price = undefined
    }
    const eligibility = getEligibility(
      { id: row.id, sold: row.sold === 1, specs: { price } },
      row.mode,
      // A knife without a store link is what Other stores looks for.
      1,
      scoped,
    )
    return eligibility.monitored && eligibility.tier === tier
  })
  return orderKnives(
    eligible.map((row) => ({
      id: row.id,
      onWishlist: row.on_wishlist === 1,
      neverChecked: row.never_checked === 1,
      neverSearched: neverSearched.has(row.id),
      // A knife without store links is as old as its last search.
      oldestCheck: time(row.sources ? row.oldest_check : row.oldest_search),
      addedAt: row.added_at,
    })),
  )
}

/**
 * Check all now, unless one is running: saves its knives in order and makes
 * every link of theirs due now, earliest for the first knife, so each
 * store's queue takes them in that order. The round ends once every one of
 * its links was checked (or tried). Returns the new round, or null when one
 * was already running.
 */
export async function startRound(input: {
  settings: PriceMonitoringSettings
  trigger: RoundTrigger
  intervalMs: number
  searches: boolean
  now: number
  generation?: string
}): Promise<Round | null> {
  return withVaultWrite(async () => {
    if (input.generation) assertVaultGeneration(input.generation)
    const database = getLocalDb()
    return database.transaction(() => {
      if (readCurrentRound(database)) return null
      const knifeIds = readRoundKnifeIds(database, input.settings, {
        searches: input.searches,
        now: input.now,
      })
      const startedAt = iso(input.now)
      const id = Number(
        database
          .prepare(
            `INSERT INTO price_rounds
               (trigger, started_at, interval_ms, knife_ids, cursor)
             VALUES (?, ?, ?, ?, 0)`,
          )
          .run(
            input.trigger,
            startedAt,
            Math.round(input.intervalMs),
            JSON.stringify(knifeIds),
          ).lastInsertRowid,
      )
      const due = database.prepare(
        `UPDATE price_sources SET next_check_at = ?
         WHERE knife_id = ? AND removed_at IS NULL AND enabled = 1
           AND priority = 0`,
      )
      // A second apart, so a store's queue keeps the knives' order.
      knifeIds.forEach((knifeId, index) =>
        due.run(iso(input.now - (knifeIds.length - index) * 1000), knifeId),
      )
      return {
        id,
        trigger: input.trigger,
        startedAt: input.now,
        finishedAt: null,
        intervalMs: input.intervalMs,
        knifeIds,
        cursor: 0,
      }
    })()
  })
}

/** Check all is done: every link of its knives was checked or tried. */
export async function endRound(input: {
  roundId: number
  now: number
  generation: string
}): Promise<void> {
  await withVaultWrite(async () => {
    assertVaultGeneration(input.generation)
    getLocalDb()
      .prepare(
        `UPDATE price_rounds SET finished_at = ?, cursor = json_array_length(knife_ids)
         WHERE id = ? AND finished_at IS NULL`,
      )
      .run(iso(input.now), input.roundId)
  })
}

/** Retry list items whose time has come, earliest first. */
export function readDueRetries(
  database: Database.Database,
  now: number,
): RetryTask[] {
  return (
    database
      .prepare(
        `SELECT * FROM price_retry_tasks
         WHERE due_at IS NOT NULL AND due_at <= ?
         ORDER BY due_at, task_key`,
      )
      .all(iso(now)) as RetryRow[]
  ).map(toRetry)
}

/** Every item on the retry list (Price Drops, the supervisor). */
export function readRetryTasks(database: Database.Database): RetryTask[] {
  return (
    database
      .prepare(
        `SELECT * FROM price_retry_tasks
         ORDER BY due_at IS NULL, due_at, created_at, task_key`,
      )
      .all() as RetryRow[]
  ).map(toRetry)
}

/**
 * A retry ran: it leaves the list either way. What failed again comes back
 * on the source's own retry delays, in its store's queue.
 */
export async function finishRetry(input: {
  key: string
  generation: string
}): Promise<void> {
  await withVaultWrite(async () => {
    assertVaultGeneration(input.generation)
    getLocalDb()
      .prepare('DELETE FROM price_retry_tasks WHERE task_key = ?')
      .run(input.key)
  })
}

/**
 * The supervisor's Retry with AI: the source joins the retry list, due now.
 * Runs inside the caller's write and transaction.
 */
export function queueRetryNow(
  database: Database.Database,
  input: { sourceId: number; now: number },
): boolean {
  const source = database
    .prepare(
      `SELECT knife_id, lane_key FROM price_sources
       WHERE id = ? AND removed_at IS NULL AND enabled = 1`,
    )
    .get(input.sourceId) as { knife_id: string; lane_key: string } | undefined
  if (!source) return false
  const now = iso(input.now)
  database
    .prepare(
      `INSERT INTO price_retry_tasks
         (task_key, kind, knife_id, source_id, store, lane_key, reason,
          attempts, round_id, due_at, last_error, created_at, updated_at)
       VALUES (?, 'check', ?, ?, NULL, ?, 'supervisor', 0, NULL, ?, NULL, ?, ?)
       ON CONFLICT(task_key) DO UPDATE SET
         reason = 'supervisor', due_at = excluded.due_at,
         updated_at = excluded.updated_at`,
    )
    .run(
      retryKey({ kind: 'check', sourceId: input.sourceId }),
      source.knife_id,
      input.sourceId,
      source.lane_key,
      now,
      now,
      now,
    )
  return true
}

/**
 * Drops retry list items that no longer apply: a removed or paused source,
 * a deleted knife, a store that now has a listing for the knife, or an
 * item the old rounds left (failed checks now come back on their own retry
 * delays; only the supervisor's Retry with AI uses the list).
 */
export async function dropStaleRetries(generation: string): Promise<number> {
  return withVaultWrite(async () => {
    assertVaultGeneration(generation)
    return getLocalDb()
      .prepare(
        `DELETE FROM price_retry_tasks
         WHERE reason <> 'supervisor'
            OR (kind = 'check' AND NOT EXISTS (
                  SELECT 1 FROM price_sources s
                  WHERE s.id = price_retry_tasks.source_id
                    AND s.removed_at IS NULL AND s.enabled = 1))
            OR (kind = 'search' AND (
                  NOT EXISTS (SELECT 1 FROM knives k
                              WHERE k.id = price_retry_tasks.knife_id)
               OR EXISTS (SELECT 1 FROM price_sources s
                          WHERE s.knife_id = price_retry_tasks.knife_id
                            AND s.lane_key = price_retry_tasks.lane_key
                            AND s.removed_at IS NULL)))`,
      )
      .run().changes
  })
}

/** Finished rounds and collection passes older than a month. */
export function pruneRounds(database: Database.Database, now: number): void {
  for (const table of ['price_rounds', 'price_collection_passes'])
    database
      .prepare(
        `DELETE FROM ${table}
         WHERE finished_at IS NOT NULL AND finished_at < ?`,
      )
      .run(iso(now - ROUND_HISTORY_MS))
}
