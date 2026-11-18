import type Database from 'better-sqlite3'
import { getLocalDb } from '@/lib/local-db'
import type {
  ActiveLaneAdvice,
  AdvisorInput,
  AdvisorTrigger,
  AppliedAdvice,
  AppliedLaneAdvice,
} from '@/lib/price-monitor/advisor'
import { redactSecretsDeep } from '@/lib/price-monitor/secret-registry'
import type { ActiveHours } from '@/lib/settings-shared'
import { assertVaultGeneration, withVaultWrite } from '@/lib/vault-access'

/**
 * SQLite side of the AI pacing advisor: the statistics it reads, its history
 * in price_regulator_advice and the advice currently applied per store
 * (price_host_state.advice_id / advice_expires_at / quiet_hours).
 */
export type AdvisorRows = {
  daily: Array<{
    laneKey: string
    checks: number
    ok: number
    noPrice: number
    failed: number
    blocked: number
    aiUsed: number
  }>
  checks: Array<{
    laneKey: string
    startedAt: string
    durationMs: number
    outcome: string
    errorCode: string | null
  }>
  /** Active, enabled sources per store. */
  sources: Map<string, number>
}

function localDay(time: number): string {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Store-level rows only: no URLs, knives or check messages. */
export function readAdvisorRows(
  database: Database.Database,
  since: number,
): AdvisorRows {
  const daily = database
    .prepare(
      `SELECT lane_key AS laneKey, SUM(checks) AS checks, SUM(ok) AS ok,
              SUM(no_price) AS noPrice, SUM(failed) AS failed,
              SUM(blocked) AS blocked, SUM(ai_used) AS aiUsed
       FROM price_monitor_daily WHERE day >= ? GROUP BY lane_key`,
    )
    .all(localDay(since)) as AdvisorRows['daily']
  const checks = database
    .prepare(
      `SELECT lane_key AS laneKey, started_at AS startedAt,
              duration_ms AS durationMs, outcome, error_code AS errorCode
       FROM price_check_log WHERE started_at >= ?
       ORDER BY started_at DESC LIMIT 20000`,
    )
    .all(new Date(since).toISOString()) as AdvisorRows['checks']
  const sources = new Map(
    (
      database
        .prepare(
          `SELECT lane_key AS laneKey, COUNT(*) AS count FROM price_sources
           WHERE removed_at IS NULL AND enabled = 1 GROUP BY lane_key`,
        )
        .all() as Array<{ laneKey: string; count: number }>
    ).map((row) => [row.laneKey, row.count]),
  )
  return { daily, checks, sources }
}

export function readLastAdviceAt(database: Database.Database): number | null {
  const row = database
    .prepare('SELECT MAX(created_at) AS createdAt FROM price_regulator_advice')
    .get() as { createdAt: string | null } | undefined
  const time = row?.createdAt ? Date.parse(row.createdAt) : Number.NaN
  return Number.isFinite(time) ? time : null
}

/**
 * Stores one advisor run. A successful run replaces the advice of every
 * store: stores it does not mention fall back to the algorithm. A failed
 * run is only logged and leaves the current advice in place. Nothing is
 * written into a vault restored since the run started.
 */
export async function recordAdvice(entry: {
  generation: string
  createdAt: string
  trigger: AdvisorTrigger
  model: string
  input: AdvisorInput
  output?: unknown
  applied?: AppliedAdvice
  error?: string
}): Promise<number | null> {
  return withVaultWrite(async () => {
    assertVaultGeneration(entry.generation)
    const database = getLocalDb()
    return database.transaction(() => {
      const adviceId = Number(
        database
          .prepare(
            `INSERT INTO price_regulator_advice
              (created_at, trigger, model, input, output, applied, expires_at, error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            entry.createdAt,
            entry.trigger,
            entry.model,
            JSON.stringify(entry.input),
            entry.output === undefined
              ? null
              : JSON.stringify(redactSecretsDeep(entry.output)),
            entry.applied ? JSON.stringify(entry.applied) : null,
            entry.applied?.expiresAt ?? null,
            entry.error ?? null,
          ).lastInsertRowid,
      )
      if (!entry.applied) return adviceId
      database
        .prepare(
          `UPDATE price_host_state
           SET advice_id = NULL, advice_expires_at = NULL, quiet_hours = NULL
           WHERE advice_id IS NOT NULL`,
        )
        .run()
      const upsert = database.prepare(
        `INSERT INTO price_host_state
          (lane_key, min_gap_ms, ready_at, advice_id, advice_expires_at,
           quiet_hours, strategy, strategy_until, updated_at)
         VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(lane_key) DO UPDATE SET
           advice_id = excluded.advice_id,
           advice_expires_at = excluded.advice_expires_at,
           quiet_hours = excluded.quiet_hours,
           strategy = CASE WHEN ? THEN 'browser_first' ELSE strategy END,
           strategy_until = CASE WHEN ? THEN excluded.strategy_until
                                 ELSE strategy_until END,
           updated_at = excluded.updated_at`,
      )
      for (const lane of entry.applied.lanes) {
        const pin = lane.strategy === 'browser_first'
        upsert.run(
          lane.laneKey,
          entry.createdAt,
          adviceId,
          entry.applied.expiresAt,
          lane.quietHours ? JSON.stringify(lane.quietHours) : null,
          pin ? 'browser_first' : 'auto',
          pin ? entry.applied.expiresAt : null,
          entry.createdAt,
          pin ? 1 : 0,
          pin ? 1 : 0,
        )
      }
      return adviceId
    })()
  })
}

function parseApplied(value: string | null): AppliedAdvice | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as AppliedAdvice
    return Array.isArray(parsed?.lanes) ? parsed : null
  } catch {
    return null
  }
}

function isHours(value: unknown): value is ActiveHours {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((hour) => Number.isInteger(hour))
  )
}

/** Advice in force per store; expired advice is left out. */
export function readActiveAdvice(
  database: Database.Database,
  now: number,
): Map<string, ActiveLaneAdvice> {
  const rows = database
    .prepare(
      `SELECT h.lane_key AS laneKey, h.advice_id AS adviceId,
              h.advice_expires_at AS expiresAt, a.applied AS applied
       FROM price_host_state h
       JOIN price_regulator_advice a ON a.id = h.advice_id
       WHERE h.advice_expires_at > ?`,
    )
    .all(new Date(now).toISOString()) as Array<{
    laneKey: string
    adviceId: number
    expiresAt: string
    applied: string | null
  }>
  const result = new Map<string, ActiveLaneAdvice>()
  for (const row of rows) {
    const lane = parseApplied(row.applied)?.lanes.find(
      (entry: AppliedLaneAdvice) => entry.laneKey === row.laneKey,
    )
    const expiresAt = Date.parse(row.expiresAt)
    if (!lane || !Number.isFinite(expiresAt)) continue
    const pause = lane.pauseUntil ? Date.parse(lane.pauseUntil) : Number.NaN
    result.set(row.laneKey, {
      adviceId: row.adviceId,
      minGapMs:
        typeof lane.minGapMs === 'number' && Number.isFinite(lane.minGapMs)
          ? lane.minGapMs
          : null,
      pauseUntil: Number.isFinite(pause) ? pause : null,
      quietHours: isHours(lane.quietHours) ? lane.quietHours : null,
      reason: typeof lane.reason === 'string' ? lane.reason : '',
      expiresAt,
    })
  }
  return result
}

export type AdviceHistoryEntry = {
  id: number
  createdAt: string
  trigger: AdvisorTrigger
  model: string
  expiresAt: string | null
  error: string | null
  lanes: AppliedLaneAdvice[]
}

/** Recent advisor runs for the UI (without the raw input and output). */
export function readRecentAdvice(
  database: Database.Database,
  limit = 10,
): AdviceHistoryEntry[] {
  const rows = database
    .prepare(
      `SELECT id, created_at AS createdAt, trigger, model,
              expires_at AS expiresAt, error, applied
       FROM price_regulator_advice ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as Array<
    Omit<AdviceHistoryEntry, 'lanes'> & { applied: string | null }
  >
  return rows.map(({ applied, ...row }) => ({
    ...row,
    lanes: parseApplied(applied)?.lanes ?? [],
  }))
}
