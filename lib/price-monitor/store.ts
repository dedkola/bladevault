import type Database from 'better-sqlite3'
import type { Knife } from '@/lib/data'
import { getLocalDb } from '@/lib/local-db'
import {
  detectChange,
  type DetectResult,
  type Observation,
  type SnapshotState,
} from '@/lib/price-monitor/detect'
import {
  DEFAULT_ELIGIBILITY_SETTINGS,
  getEligibility,
  planAutoSource,
  type EligibilitySettings,
} from '@/lib/price-monitor/eligibility'
import {
  laneKeyForUrl,
  MAX_PRICE_SOURCES_PER_KNIFE,
  normalizeSourceUrl,
  providerForUrl,
  storeNameForUrl,
  type Availability,
  type FetchOverride,
  type PriceProvider,
  type PriceSourceOrigin,
  type PriceSourceStatus,
  type PriceSourceView,
  type PriceWatchMode,
  type PriceWatchUpdate,
  type PriceWatchView,
} from '@/lib/price-monitor/shared'
import type { LaneState } from '@/lib/price-monitor/lanes'
import { assertVaultGeneration, withVaultWrite } from '@/lib/vault-access'

export type SourceRow = {
  id: number
  knife_id: string
  url: string
  normalized_url: string
  provider: PriceProvider
  lane_key: string
  store_name: string
  origin: PriceSourceOrigin
  enabled: number
  fetch_override: FetchOverride
  status: PriceSourceStatus
  last_checked_at: string | null
  last_success_at: string | null
  last_price_minor: number | null
  last_currency: string | null
  last_availability: Availability | null
  last_error_code: string | null
  last_error: string | null
  consecutive_failures: number
  next_check_at: string | null
  last_ai_at: string | null
  priority: number
  created_at: string
  updated_at: string
  removed_at: string | null
}

type SnapshotRow = {
  id: number
  price_minor: number | null
  currency: string | null
  availability: Availability
}

export type HostStrategy = 'auto' | 'http_first' | 'browser_first'

/** What the engine learns about fetching a store; pacing lives in LaneState. */
export type HostState = {
  laneKey: string
  strategy: HostStrategy
  strategyUntil: string | null
  httpMatchStreak: number
}

export class PriceWatchError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'PriceWatchError'
  }
}

function db(): Database.Database {
  return getLocalDb()
}

// ---------------------------------------------------------------- reads

export function readWatchMode(
  database: Database.Database,
  knifeId: string,
): PriceWatchMode {
  const row = database
    .prepare('SELECT mode FROM price_watch WHERE knife_id = ?')
    .get(knifeId) as { mode: PriceWatchMode } | undefined
  return row?.mode ?? 'auto'
}

export function readActiveSources(
  database: Database.Database,
  knifeId: string,
): SourceRow[] {
  return database
    .prepare(
      `SELECT * FROM price_sources
       WHERE knife_id = ? AND removed_at IS NULL
       ORDER BY CASE origin WHEN 'auto' THEN 0 ELSE 1 END, id`,
    )
    .all(knifeId) as SourceRow[]
}

export function readSource(
  database: Database.Database,
  sourceId: number,
): SourceRow | undefined {
  return database
    .prepare('SELECT * FROM price_sources WHERE id = ?')
    .get(sourceId) as SourceRow | undefined
}

function toSnapshotState(row: SnapshotRow | undefined): SnapshotState | null {
  if (!row) return null
  return {
    id: row.id,
    priceMinor: row.price_minor,
    currency: row.currency,
    availability: row.availability,
  }
}

export function readLatestSnapshot(
  database: Database.Database,
  sourceId: number,
): SnapshotState | null {
  return toSnapshotState(
    database
      .prepare(
        `SELECT id, price_minor, currency, availability FROM price_snapshots
         WHERE source_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(sourceId) as SnapshotRow | undefined,
  )
}

export function readLatestPricedSnapshot(
  database: Database.Database,
  sourceId: number,
): SnapshotState | null {
  return toSnapshotState(
    database
      .prepare(
        `SELECT id, price_minor, currency, availability FROM price_snapshots
         WHERE source_id = ? AND price_minor IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
      )
      .get(sourceId) as SnapshotRow | undefined,
  )
}

/** Recent prices of a source in one currency, newest first. */
export function readRecentPrices(
  database: Database.Database,
  sourceId: number,
  currency: string,
  limit = 5,
): number[] {
  return (
    database
      .prepare(
        `SELECT price_minor FROM price_snapshots
         WHERE source_id = ? AND currency = ? AND price_minor IS NOT NULL
         ORDER BY id DESC LIMIT ?`,
      )
      .all(sourceId, currency, limit) as Array<{ price_minor: number }>
  ).map((row) => row.price_minor)
}

export function readHostState(
  database: Database.Database,
  laneKey: string,
): HostState {
  const row = database
    .prepare('SELECT * FROM price_host_state WHERE lane_key = ?')
    .get(laneKey) as
    | {
        strategy: HostStrategy
        strategy_until: string | null
        http_match_streak: number
      }
    | undefined
  return {
    laneKey,
    strategy: row?.strategy ?? 'auto',
    strategyUntil: row?.strategy_until ?? null,
    httpMatchStreak: row?.http_match_streak ?? 0,
  }
}

export function toSourceView(row: SourceRow): PriceSourceView {
  return {
    id: row.id,
    url: row.url,
    storeName: row.store_name,
    laneKey: row.lane_key,
    provider: row.provider,
    origin: row.origin,
    enabled: row.enabled === 1,
    fetchOverride: row.fetch_override,
    status: row.status,
    lastCheckedAt: row.last_checked_at,
    lastSuccessAt: row.last_success_at,
    lastPriceMinor: row.last_price_minor,
    lastCurrency: row.last_currency,
    lastAvailability: row.last_availability,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
    createdAt: row.created_at,
  }
}

export function buildPriceWatchView(
  knife: Knife,
  settings: EligibilitySettings = DEFAULT_ELIGIBILITY_SETTINGS,
): PriceWatchView {
  const database = db()
  const mode = readWatchMode(database, knife.id)
  const sources = readActiveSources(database, knife.id)
  return {
    knifeId: knife.id,
    mode,
    eligibility: getEligibility(
      knife,
      mode,
      sources.filter((source) => source.enabled === 1).length,
      settings,
    ),
    sources: sources.map(toSourceView),
    maxSources: MAX_PRICE_SOURCES_PER_KNIFE,
    // Check now waits as priority 2 until its store's next free slot.
    queuedSourceIds: sources
      .filter((source) => source.priority >= 2 || source.status === 'checking')
      .map((source) => source.id),
  }
}

// --------------------------------------------------------------- writes

function insertSource(
  database: Database.Database,
  knifeId: string,
  url: string,
  origin: PriceSourceOrigin,
  storeName: string | undefined,
  now: string,
) {
  const normalized = normalizeSourceUrl(url)
  if (!normalized)
    throw new PriceWatchError(
      'Enter a valid product URL starting with http:// or https://.',
    )
  database
    .prepare(
      `INSERT INTO price_sources
        (knife_id, url, normalized_url, provider, lane_key, store_name, origin,
         priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      knifeId,
      url,
      normalized,
      providerForUrl(url),
      laneKeyForUrl(url),
      storeName || storeNameForUrl(url),
      origin,
      now,
      now,
    )
}

function softRemove(database: Database.Database, ids: number[], now: string) {
  const statement = database.prepare(
    `UPDATE price_sources SET removed_at = ?, updated_at = ?
     WHERE id = ? AND removed_at IS NULL`,
  )
  for (const id of ids) statement.run(now, now, id)
}

function autoSourcePlan(
  database: Database.Database,
  knife: Pick<Knife, 'id' | 'sourceUrl'>,
) {
  return planAutoSource(
    knife.sourceUrl ?? '',
    readActiveSources(database, knife.id).map((source) => ({
      id: source.id,
      origin: source.origin,
      normalizedUrl: source.normalized_url,
    })),
  )
}

function applyAutoSourcePlan(
  database: Database.Database,
  knife: Pick<Knife, 'id' | 'sourceUrl'>,
  now: string,
) {
  const plan = autoSourcePlan(database, knife)
  softRemove(database, plan.removeIds, now)
  if (plan.add) {
    const active = readActiveSources(database, knife.id)
    // A full manual list leaves no room for the auto source.
    if (active.length < MAX_PRICE_SOURCES_PER_KNIFE)
      insertSource(database, knife.id, plan.add, 'auto', undefined, now)
  }
}

/**
 * Brings the knife's auto source in line with its current `sourceUrl`.
 * Writes only when something changes.
 */
export async function syncAutoSource(knife: Knife): Promise<void> {
  const plan = autoSourcePlan(db(), knife)
  if (!plan.add && !plan.removeIds.length) return
  await withVaultWrite(async () => {
    const database = db()
    database.transaction(() =>
      applyAutoSourcePlan(database, knife, new Date().toISOString()),
    )()
  })
}

/** Applies an edit-mode change: mode, added, edited and removed sources. */
export async function applyPriceWatchUpdate(
  knife: Knife,
  update: PriceWatchUpdate,
): Promise<void> {
  await withVaultWrite(async () => {
    const database = db()
    const now = new Date().toISOString()
    database.transaction(() => {
      if (update.mode) {
        database
          .prepare(
            `INSERT INTO price_watch (knife_id, mode, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(knife_id) DO UPDATE
             SET mode = excluded.mode, updated_at = excluded.updated_at`,
          )
          .run(knife.id, update.mode, now)
      }

      const byId = new Map(
        readActiveSources(database, knife.id).map((row) => [row.id, row]),
      )
      for (const id of update.remove ?? []) {
        const source = byId.get(id)
        if (!source) throw new PriceWatchError('Source not found', 404)
        if (source.origin === 'auto')
          throw new PriceWatchError(
            'The source from the knife’s product link can only be paused.',
          )
        softRemove(database, [id], now)
        byId.delete(id)
      }

      for (const change of update.update ?? []) {
        const source = byId.get(change.id)
        if (!source) throw new PriceWatchError('Source not found', 404)
        const storeName =
          change.storeName === undefined
            ? source.store_name
            : change.storeName || storeNameForUrl(source.url)
        database
          .prepare(
            `UPDATE price_sources
             SET store_name = ?, enabled = ?, fetch_override = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            storeName,
            change.enabled === undefined
              ? source.enabled
              : change.enabled
                ? 1
                : 0,
            change.fetchOverride ?? source.fetch_override,
            now,
            change.id,
          )
      }

      for (const item of update.add ?? []) {
        const normalized = normalizeSourceUrl(item.url)
        const active = readActiveSources(database, knife.id)
        if (active.some((source) => source.normalized_url === normalized))
          throw new PriceWatchError('This URL is already monitored.', 409)
        if (active.length >= MAX_PRICE_SOURCES_PER_KNIFE)
          throw new PriceWatchError(
            `A knife can have at most ${MAX_PRICE_SOURCES_PER_KNIFE} price sources.`,
          )
        insertSource(
          database,
          knife.id,
          item.url,
          'manual',
          item.storeName,
          now,
        )
      }

      applyAutoSourcePlan(database, knife, now)
    })()
  })
}

export async function markSourceChecking(
  sourceId: number,
  generation: string,
): Promise<void> {
  await withVaultWrite(async () => {
    assertVaultGeneration(generation)
    db()
      .prepare(
        `UPDATE price_sources SET status = 'checking', updated_at = ?
         WHERE id = ? AND removed_at IS NULL`,
      )
      .run(new Date().toISOString(), sourceId)
  })
}

export type CheckOutcomeKind = 'ok' | 'no_price' | 'failed' | 'blocked'

export type RecordedObservation = Observation & {
  extractionStatus: 'ok' | 'ai' | 'no_price'
  extractionMethod: string
}

export type HostPatch = Partial<
  Pick<HostState, 'strategy' | 'strategyUntil' | 'httpMatchStreak'>
>

export type CheckRecord = {
  generation: string
  sourceId: number
  trigger: 'scheduled' | 'manual' | 'retry' | 'probe'
  startedAt: string
  durationMs: number
  outcome: CheckOutcomeKind
  method: 'http' | 'browser' | 'headed' | null
  attempt?: number
  httpStatus?: number | null
  errorCode?: string | null
  errorMessage?: string | null
  observation?: RecordedObservation | null
  provider?: PriceProvider
  nextCheckAt: string | null
  host?: HostPatch
  /** Pause the source, e.g. after its page was missing three times. */
  disable?: boolean
}

export type CheckRecordResult = {
  checkLogId: number
  detection: DetectResult | null
  snapshotId: number | null
}

function localDay(iso: string): string {
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function sourceStatusFor(
  outcome: CheckOutcomeKind,
  observation: RecordedObservation | null | undefined,
): PriceSourceStatus {
  if (outcome === 'failed') return 'failed'
  if (outcome === 'blocked') return 'blocked'
  if (observation?.availability === 'out_of_stock') return 'out_of_stock'
  if (outcome === 'no_price' || observation?.priceMinor === null)
    return 'price_unavailable'
  return 'ok'
}

function upsertHostState(
  database: Database.Database,
  laneKey: string,
  patch: HostPatch,
  outcome: CheckOutcomeKind,
  now: string,
) {
  const current = readHostState(database, laneKey)
  const next = { ...current, ...patch }
  database
    .prepare(
      `INSERT INTO price_host_state
        (lane_key, min_gap_ms, ready_at, strategy, strategy_until,
         http_match_streak, last_outcome, updated_at)
       VALUES (?, 0, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(lane_key) DO UPDATE SET
         strategy = excluded.strategy,
         strategy_until = excluded.strategy_until,
         http_match_streak = excluded.http_match_streak,
         last_outcome = excluded.last_outcome,
         updated_at = excluded.updated_at`,
    )
    .run(
      laneKey,
      now,
      next.strategy,
      next.strategyUntil,
      next.httpMatchStreak,
      outcome,
      now,
    )
}

/**
 * Stores one finished check in a single transaction: the check log, the
 * snapshot (extended when nothing changed), price and stock events, the
 * source's cached state, the daily rollup and the store's lane state.
 * Nothing is written into a vault restored since the check started.
 */
export async function recordCheck(
  record: CheckRecord,
): Promise<CheckRecordResult | null> {
  return withVaultWrite(async () => {
    assertVaultGeneration(record.generation)
    const database = db()
    return database.transaction((): CheckRecordResult | null => {
      const source = readSource(database, record.sourceId)
      if (!source || source.removed_at) return null
      const now = new Date(
        Date.parse(record.startedAt) + record.durationMs,
      ).toISOString()
      const observation = record.observation ?? null

      const logId = Number(
        database
          .prepare(
            `INSERT INTO price_check_log
              (lane_key, trigger, source_id, knife_id, started_at, duration_ms,
               outcome, method, attempt, http_status, error_code, error_message)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            source.lane_key,
            record.trigger,
            source.id,
            source.knife_id,
            record.startedAt,
            record.durationMs,
            record.outcome,
            record.method,
            record.attempt ?? 1,
            record.httpStatus ?? null,
            record.errorCode ?? null,
            record.errorMessage ?? null,
          ).lastInsertRowid,
      )

      let detection: DetectResult | null = null
      let snapshotId: number | null = null
      if (observation) {
        const latest = readLatestSnapshot(database, source.id)
        detection = detectChange(
          latest,
          readLatestPricedSnapshot(database, source.id),
          observation,
        )
        if (detection.action === 'touch' && latest) {
          snapshotId = latest.id
          database
            .prepare(
              `UPDATE price_snapshots
               SET last_seen_at = ?, observations = observations + 1
               WHERE id = ?`,
            )
            .run(now, latest.id)
        } else {
          snapshotId = Number(
            database
              .prepare(
                `INSERT INTO price_snapshots
                  (knife_id, source_id, price_minor, currency, availability,
                   extraction_status, extraction_method, observed_at,
                   last_seen_at, check_log_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                source.knife_id,
                source.id,
                observation.priceMinor,
                observation.currency,
                observation.availability,
                observation.extractionStatus,
                observation.extractionMethod,
                now,
                now,
                logId,
              ).lastInsertRowid,
          )
        }
        const price = detection.priceChange
        if (price) {
          database
            .prepare(
              `INSERT INTO price_change_events
                (knife_id, source_id, direction, previous_price_minor,
                 price_minor, currency, delta_minor, delta_pct, availability,
                 from_snapshot_id, to_snapshot_id, source_url, store_name,
                 extraction_method, occurred_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              source.knife_id,
              source.id,
              price.direction,
              price.previousPriceMinor,
              price.priceMinor,
              price.currency,
              price.deltaMinor,
              price.deltaPct,
              observation.availability,
              price.fromSnapshotId,
              snapshotId,
              source.url,
              source.store_name,
              observation.extractionMethod,
              now,
            )
        }
        const stock = detection.stockChange
        if (stock) {
          database
            .prepare(
              `INSERT INTO stock_events
                (knife_id, source_id, kind, previous_availability, availability,
                 price_minor, currency, from_snapshot_id, to_snapshot_id,
                 source_url, store_name, occurred_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              source.knife_id,
              source.id,
              stock.kind,
              stock.previousAvailability,
              stock.availability,
              observation.priceMinor,
              observation.currency,
              stock.fromSnapshotId,
              snapshotId,
              source.url,
              source.store_name,
              now,
            )
        }
      }

      const succeeded = record.outcome === 'ok' || record.outcome === 'no_price'
      database
        .prepare(
          `UPDATE price_sources SET
             status = ?,
             provider = ?,
             last_checked_at = ?,
             last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END,
             last_price_minor = COALESCE(?, last_price_minor),
             last_currency = COALESCE(?, last_currency),
             last_availability = COALESCE(?, last_availability),
             last_error_code = ?,
             last_error = ?,
             consecutive_failures = CASE WHEN ? THEN 0 ELSE consecutive_failures + 1 END,
             next_check_at = ?,
             priority = 0,
             enabled = CASE WHEN ? THEN 0 ELSE enabled END,
             updated_at = ?
           WHERE id = ?`,
        )
        .run(
          sourceStatusFor(record.outcome, observation),
          record.provider ?? source.provider,
          now,
          succeeded ? 1 : 0,
          now,
          observation?.priceMinor ?? null,
          observation?.priceMinor !== null &&
            observation?.priceMinor !== undefined
            ? observation.currency
            : null,
          observation?.availability ?? null,
          record.errorCode ?? null,
          record.errorMessage ?? null,
          succeeded ? 1 : 0,
          record.nextCheckAt,
          record.disable ? 1 : 0,
          now,
          source.id,
        )

      database
        .prepare(
          `INSERT INTO price_monitor_daily
            (day, lane_key, checks, ok, no_price, failed, blocked, total_ms)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?)
           ON CONFLICT(day, lane_key) DO UPDATE SET
             checks = checks + 1,
             ok = ok + excluded.ok,
             no_price = no_price + excluded.no_price,
             failed = failed + excluded.failed,
             blocked = blocked + excluded.blocked,
             total_ms = total_ms + excluded.total_ms`,
        )
        .run(
          localDay(record.startedAt),
          source.lane_key,
          record.outcome === 'ok' ? 1 : 0,
          record.outcome === 'no_price' ? 1 : 0,
          record.outcome === 'failed' ? 1 : 0,
          record.outcome === 'blocked' ? 1 : 0,
          record.durationMs,
        )

      upsertHostState(
        database,
        source.lane_key,
        record.host ?? {},
        record.outcome,
        now,
      )
      return { checkLogId: logId, detection, snapshotId }
    })()
  })
}

// ------------------------------------------------------- queue support

type LaneRow = {
  lane_key: string
  min_gap_ms: number
  ready_at: string
  circuit: string
  cooldown_until: string | null
  open_count: number
  success_streak: number
  failure_streak: number
  last_request_at: string | null
  strategy: HostStrategy
}

const parseTime = (value: string | null): number | null => {
  if (!value) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

const toIso = (value: number | null): string | null =>
  value === null ? null : new Date(value).toISOString()

export function readLaneStates(
  database: Database.Database,
): Map<string, LaneState & { strategy: HostStrategy }> {
  const rows = database
    .prepare('SELECT * FROM price_host_state')
    .all() as LaneRow[]
  return new Map(
    rows.map((row) => [
      row.lane_key,
      {
        laneKey: row.lane_key,
        minGapMs: row.min_gap_ms,
        readyAt: parseTime(row.ready_at) ?? 0,
        circuit: row.circuit === 'open' ? 'open' : 'closed',
        cooldownUntil: parseTime(row.cooldown_until),
        openCount: row.open_count,
        successStreak: row.success_streak,
        failureStreak: row.failure_streak,
        lastRequestAt: parseTime(row.last_request_at),
        strategy: row.strategy,
      },
    ]),
  )
}

/** Stores the pacing side of a lane; the engine owns the strategy columns. */
export async function writeLaneState(
  lane: LaneState,
  generation: string,
): Promise<void> {
  await withVaultWrite(async () => {
    assertVaultGeneration(generation)
    const now = new Date().toISOString()
    db()
      .prepare(
        `INSERT INTO price_host_state
          (lane_key, min_gap_ms, ready_at, circuit, cooldown_until, open_count,
           success_streak, failure_streak, last_request_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(lane_key) DO UPDATE SET
           min_gap_ms = excluded.min_gap_ms,
           ready_at = excluded.ready_at,
           circuit = excluded.circuit,
           cooldown_until = excluded.cooldown_until,
           open_count = excluded.open_count,
           success_streak = excluded.success_streak,
           failure_streak = excluded.failure_streak,
           last_request_at = excluded.last_request_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        lane.laneKey,
        Math.round(lane.minGapMs),
        toIso(lane.readyAt),
        lane.circuit,
        toIso(lane.cooldownUntil),
        lane.openCount,
        lane.successStreak,
        lane.failureStreak,
        toIso(lane.lastRequestAt),
        now,
      )
  })
}

export type CandidateRow = {
  sourceId: number
  knifeId: string
  laneKey: string
  priority: number
  nextCheckAt: number | null
  /** Enabled source of a knife that scheduled monitoring covers. */
  scheduled: boolean
}

/**
 * Every source the queue might check: Check now requests regardless of mode
 * or pause, plus enabled sources of eligible knives.
 */
export function readQueueCandidates(
  database: Database.Database,
  settings: EligibilitySettings,
): CandidateRow[] {
  const rows = database
    .prepare(
      `SELECT s.id, s.knife_id, s.lane_key, s.priority, s.next_check_at,
              s.enabled, k.specs, k.sold, COALESCE(w.mode, 'auto') AS mode
       FROM price_sources s
       JOIN knives k ON k.id = s.knife_id
       LEFT JOIN price_watch w ON w.knife_id = s.knife_id
       WHERE s.removed_at IS NULL AND (s.priority >= 2 OR s.enabled = 1)`,
    )
    .all() as Array<{
    id: number
    knife_id: string
    lane_key: string
    priority: number
    next_check_at: string | null
    enabled: number
    specs: string
    sold: number
    mode: PriceWatchMode
  }>
  const eligible = new Map<string, boolean>()
  return rows.map((row) => {
    let monitored = eligible.get(row.knife_id)
    if (monitored === undefined) {
      let price: string | undefined
      try {
        price = (JSON.parse(row.specs) as { price?: string }).price
      } catch {
        price = undefined
      }
      monitored = getEligibility(
        { sold: row.sold === 1, specs: { price } },
        row.mode,
        1,
        settings,
      ).monitored
      eligible.set(row.knife_id, monitored)
    }
    return {
      sourceId: row.id,
      knifeId: row.knife_id,
      laneKey: row.lane_key,
      priority: row.priority,
      nextCheckAt: parseTime(row.next_check_at),
      scheduled: monitored && row.enabled === 1,
    }
  })
}

/** Marks sources for Check now; the queue runs them at the next free slot. */
export async function requestSourceChecks(
  sourceIds: readonly number[],
): Promise<number[]> {
  return withVaultWrite(async () => {
    const database = db()
    const now = new Date().toISOString()
    const statement = database.prepare(
      `UPDATE price_sources SET priority = 2, updated_at = ?
       WHERE id = ? AND removed_at IS NULL`,
    )
    return database.transaction(() =>
      sourceIds.filter((id) => statement.run(now, id).changes > 0),
    )()
  })
}

/** A server stopped mid-check leaves "checking" behind. */
export async function resetStaleChecking(): Promise<void> {
  await withVaultWrite(async () => {
    db()
      .prepare(
        `UPDATE price_sources SET status = 'pending'
         WHERE status = 'checking' AND removed_at IS NULL`,
      )
      .run()
  })
}

/** Keeps every knife's auto source in line with its product link. */
export async function syncAllAutoSources(): Promise<number> {
  const database = db()
  const knives = database
    .prepare('SELECT id, source_url FROM knives')
    .all() as Array<{ id: string; source_url: string }>
  const plans = knives
    .map((knife) => ({
      knife: { id: knife.id, sourceUrl: knife.source_url },
      plan: autoSourcePlan(database, {
        id: knife.id,
        sourceUrl: knife.source_url,
      }),
    }))
    .filter(({ plan }) => plan.add || plan.removeIds.length)
  if (!plans.length) return 0
  await withVaultWrite(async () => {
    const now = new Date().toISOString()
    database.transaction(() => {
      for (const { knife } of plans) applyAutoSourcePlan(database, knife, now)
    })()
  })
  return plans.length
}

export const WORKER_LEASE_STALE_MS = 3 * 60 * 1000

/**
 * One worker per vault. Takes or renews the lease when it is free, ours, or
 * its heartbeat is older than three minutes.
 */
export async function acquireWorkerLease(
  owner: string,
  now = Date.now(),
): Promise<boolean> {
  return withVaultWrite(async () => {
    const database = db()
    const row = database
      .prepare(
        'SELECT owner, heartbeat_at FROM price_worker_lease WHERE id = 1',
      )
      .get() as { owner: string; heartbeat_at: string } | undefined
    const stale =
      !row ||
      row.owner === owner ||
      now - (parseTime(row.heartbeat_at) ?? 0) > WORKER_LEASE_STALE_MS
    if (!stale) return false
    database
      .prepare(
        `INSERT INTO price_worker_lease (id, owner, heartbeat_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           owner = excluded.owner, heartbeat_at = excluded.heartbeat_at`,
      )
      .run(owner, new Date(now).toISOString())
    return true
  })
}

export async function releaseWorkerLease(owner: string): Promise<void> {
  await withVaultWrite(async () => {
    db()
      .prepare('DELETE FROM price_worker_lease WHERE id = 1 AND owner = ?')
      .run(owner)
  })
}

export type DailyActivity = {
  day: string
  laneKey: string
  checks: number
  ok: number
  noPrice: number
  failed: number
  blocked: number
  totalMs: number
}

export function readDailyActivity(
  database: Database.Database,
  sinceDay: string,
): DailyActivity[] {
  return (
    database
      .prepare(
        `SELECT * FROM price_monitor_daily WHERE day >= ?
         ORDER BY day DESC, lane_key`,
      )
      .all(sinceDay) as Array<{
      day: string
      lane_key: string
      checks: number
      ok: number
      no_price: number
      failed: number
      blocked: number
      total_ms: number
    }>
  ).map((row) => ({
    day: row.day,
    laneKey: row.lane_key,
    checks: row.checks,
    ok: row.ok,
    noPrice: row.no_price,
    failed: row.failed,
    blocked: row.blocked,
    totalMs: row.total_ms,
  }))
}

export type RecentCheckProblem = {
  sourceId: number
  knifeId: string
  laneKey: string
  startedAt: string
  outcome: CheckOutcomeKind
  errorCode: string | null
  errorMessage: string | null
}

export function readRecentProblems(
  database: Database.Database,
  limit = 50,
): RecentCheckProblem[] {
  return (
    database
      .prepare(
        `SELECT source_id, knife_id, lane_key, started_at, outcome, error_code,
                error_message
         FROM price_check_log
         WHERE outcome IN ('failed', 'blocked', 'no_price')
         ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      source_id: number
      knife_id: string
      lane_key: string
      started_at: string
      outcome: CheckOutcomeKind
      error_code: string | null
      error_message: string | null
    }>
  ).map((row) => ({
    sourceId: row.source_id,
    knifeId: row.knife_id,
    laneKey: row.lane_key,
    startedAt: row.started_at,
    outcome: row.outcome,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  }))
}

/** Check log rows are kept 90 days; the daily rollup keeps the totals. */
export async function pruneCheckLog(now = Date.now()): Promise<void> {
  await withVaultWrite(async () => {
    db()
      .prepare('DELETE FROM price_check_log WHERE started_at < ?')
      .run(new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString())
  })
}
