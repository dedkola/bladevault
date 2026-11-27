import type Database from 'better-sqlite3'
import { getLocalDb } from '@/lib/local-db'
import { getEligibility } from '@/lib/price-monitor/eligibility'
import { retryKey, type RetryReason } from '@/lib/price-monitor/rounds'
import { withMonitorScope } from '@/lib/price-monitor/scope'
import type { PriceWatchMode } from '@/lib/price-monitor/shared'
import type {
  OtherStoreId,
  PriceMonitoringSettings,
} from '@/lib/settings-shared'
import { assertVaultGeneration, withVaultWrite } from '@/lib/vault-access'

/**
 * Check cycles and the retry list in SQLite (price_rounds, price_retry_tasks).
 * A cycle is a price_rounds row: what it checked is every link checked since
 * it started, so a restart carries on where it was. The retry list holds
 * checks set aside: deferred ones (a due time) and problems for AI (none).
 * See cycle.ts.
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
  /** Unused since cycles replaced rounds (kept in the table). */
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

/** The cycle in progress, if any. */
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

/** The latest cycle, running or finished. */
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
 * The knives a cycle goes through, in order: What to monitor first (the
 * Wishlist: Next, Saving, Someday, each in its own order), then the rest of
 * the collection by when it was added. A knife counts when monitoring
 * covers it (What to monitor or the collection pass, its watch mode, a
 * regular price) and it has an enabled store link, or Other stores can
 * look for it.
 */
export function readCycleKnifeIds(
  database: Database.Database,
  settings: PriceMonitoringSettings,
  options: { searches: boolean },
): string[] {
  const rows = database
    .prepare(
      `SELECT k.id, k.specs, k.sold, COALESCE(pw.mode, 'auto') AS mode,
              (SELECT COUNT(*) FROM price_sources s
               WHERE s.knife_id = k.id AND s.removed_at IS NULL
                 AND s.enabled = 1) AS sources
       FROM knives k
       LEFT JOIN wishlist_items w ON w.knife_id = k.id
       LEFT JOIN price_watch pw ON pw.knife_id = k.id
       ORDER BY ${WISHLIST_ORDER}, w.position, k.added_at, k.id`,
    )
    .all() as Array<{
    id: string
    specs: string
    sold: number
    mode: PriceWatchMode
    sources: number
  }>
  const scoped = withMonitorScope(database, settings)
  const tiers = { scope: [] as string[], collection: [] as string[] }
  for (const row of rows) {
    if (!row.sources && !options.searches) continue
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
    if (eligibility.monitored) tiers[eligibility.tier].push(row.id)
  }
  return [...tiers.scope, ...tiers.collection]
}

/**
 * Starts a cycle and saves its knives in order. Check all now (`replace`)
 * ends the running cycle first; a scheduled start returns null while one
 * runs.
 */
export async function startCycle(input: {
  settings: PriceMonitoringSettings
  trigger: RoundTrigger
  intervalMs: number
  searches: boolean
  now: number
  replace?: boolean
  generation?: string
}): Promise<Round | null> {
  return withVaultWrite(async () => {
    if (input.generation) assertVaultGeneration(input.generation)
    const database = getLocalDb()
    return database.transaction(() => {
      const current = readCurrentRound(database)
      if (current && !input.replace) return null
      const startedAt = iso(input.now)
      if (current)
        database
          .prepare('UPDATE price_rounds SET finished_at = ? WHERE id = ?')
          .run(startedAt, current.id)
      const knifeIds = readCycleKnifeIds(database, input.settings, {
        searches: input.searches,
      })
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

/** Ends a cycle (its time is up, or Check all checked everything). */
export async function finishCycle(input: {
  roundId: number
  now: number
  generation: string
}): Promise<void> {
  await withVaultWrite(async () => {
    assertVaultGeneration(input.generation)
    getLocalDb()
      .prepare(
        `UPDATE price_rounds SET finished_at = ?
         WHERE id = ? AND finished_at IS NULL`,
      )
      .run(iso(input.now), input.roundId)
  })
}

/**
 * Planned check times for "next check" in the UI (cycle.ts,
 * plannedCheckTimes). Links moved forward keep theirs.
 */
export async function planCheckTimes(input: {
  planned: ReadonlyMap<number, number>
  generation: string
}): Promise<void> {
  if (!input.planned.size) return
  await withVaultWrite(async () => {
    assertVaultGeneration(input.generation)
    const database = getLocalDb()
    const plan = database.prepare(
      `UPDATE price_sources SET next_check_at = ?
       WHERE id = ? AND removed_at IS NULL AND priority = 0`,
    )
    database.transaction(() => {
      for (const [sourceId, at] of input.planned) plan.run(iso(at), sourceId)
    })()
  })
}

/**
 * What a check means for the retry list (cycle.ts, classifyCheck). Read:
 * off the list. Deferred: again at `dueAt`, until its third try in this
 * cycle; then, like a problem, it waits for AI (no due time). Its next
 * check shows the retry time.
 */
export async function recordCheckVerdict(input: {
  sourceId: number
  knifeId: string
  laneKey: string
  cycleId: number | null
  verdict: 'ok' | 'defer' | 'problem'
  reason: RetryReason
  error: string | null
  dueAt: number | null
  maxTries: number
  now: number
  generation: string
}): Promise<void> {
  await withVaultWrite(async () => {
    assertVaultGeneration(input.generation)
    const database = getLocalDb()
    const key = retryKey({ kind: 'check', sourceId: input.sourceId })
    database.transaction(() => {
      if (input.verdict === 'ok') {
        database
          .prepare('DELETE FROM price_retry_tasks WHERE task_key = ?')
          .run(key)
        return
      }
      const existing = database
        .prepare(
          'SELECT attempts, round_id FROM price_retry_tasks WHERE task_key = ?',
        )
        .get(key) as { attempts: number; round_id: number | null } | undefined
      const attempts =
        existing && existing.round_id === input.cycleId
          ? existing.attempts + 1
          : 1
      const dueAt =
        input.verdict === 'defer' &&
        input.dueAt !== null &&
        attempts < input.maxTries
          ? iso(input.dueAt)
          : null
      const now = iso(input.now)
      database
        .prepare(
          `INSERT INTO price_retry_tasks
             (task_key, kind, knife_id, source_id, store, lane_key, reason,
              attempts, round_id, due_at, last_error, created_at, updated_at)
           VALUES (?, 'check', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_key) DO UPDATE SET
             reason = excluded.reason,
             attempts = excluded.attempts,
             round_id = excluded.round_id,
             due_at = excluded.due_at,
             last_error = excluded.last_error,
             updated_at = excluded.updated_at`,
        )
        .run(
          key,
          input.knifeId,
          input.sourceId,
          input.laneKey,
          input.reason,
          attempts,
          input.cycleId,
          dueAt,
          input.error,
          now,
          now,
        )
      if (dueAt)
        database
          .prepare(
            `UPDATE price_sources SET next_check_at = ?
             WHERE id = ? AND removed_at IS NULL`,
          )
          .run(dueAt, input.sourceId)
    })()
  })
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
 * Drops retry list items that no longer apply: a removed or paused source.
 * Searches are no longer on the list (Other stores has its own retry
 * times), so older search items go too.
 */
export async function dropStaleRetries(generation: string): Promise<number> {
  return withVaultWrite(async () => {
    assertVaultGeneration(generation)
    return getLocalDb()
      .prepare(
        `DELETE FROM price_retry_tasks
         WHERE kind = 'search'
            OR (kind = 'check' AND NOT EXISTS (
                  SELECT 1 FROM price_sources s
                  WHERE s.id = price_retry_tasks.source_id
                    AND s.removed_at IS NULL AND s.enabled = 1))`,
      )
      .run().changes
  })
}

/** Finished cycles (and old collection passes) older than a month. */
export function pruneRounds(database: Database.Database, now: number): void {
  for (const table of ['price_rounds', 'price_collection_passes'])
    database
      .prepare(
        `DELETE FROM ${table}
         WHERE finished_at IS NOT NULL AND finished_at < ?`,
      )
      .run(iso(now - ROUND_HISTORY_MS))
}
