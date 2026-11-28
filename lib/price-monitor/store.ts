import type Database from 'better-sqlite3'
import type { Knife } from '@/lib/data'
import pkg from '@/package.json'
import { getLocalDb } from '@/lib/local-db'
import { pruneAiCalls } from '@/lib/price-monitor/ai-journal'
import { withMonitorScope } from '@/lib/price-monitor/scope'
import {
  detectChange,
  detectStockChange,
  STOCK_HISTORY_LIMIT,
  type DetectResult,
  type Observation,
  type SnapshotState,
  type StockSnapshot,
} from '@/lib/price-monitor/detect'
import {
  DEFAULT_ELIGIBILITY_SETTINGS,
  getEligibility,
  isIgnoredOfficialOutOfStock,
  planAutoSource,
  type EligibilitySettings,
} from '@/lib/price-monitor/eligibility'
import { recordNewStoreEvent } from '@/lib/price-monitor/new-store'
import {
  ATTENTION_STATUS_LIST,
  FOCUS_MIN_EVERY_HOURS,
  laneKeyForUrl,
  MAX_PRICE_SOURCES_PER_KNIFE,
  normalizeSourceUrl,
  providerForUrl,
  storeNameForUrl,
  type Availability,
  type FetchOverride,
  type MonitorTier,
  type PriceProvider,
  type PriceSourceOrigin,
  type PriceSourceStatus,
  type PriceSourceView,
  type PriceWatchEligibility,
  type PriceWatchFocus,
  type PriceWatchMode,
  type PriceWatchUpdate,
  type PriceWatchView,
} from '@/lib/price-monitor/shared'
import type { LaneState } from '@/lib/price-monitor/lanes'
import {
  planPriceNotifications,
  type PriceNotificationEvent,
  type PriceNotificationSettings,
} from '@/lib/price-monitor/notifications'
import {
  readMissingPageSourceIds,
  readOutOfStockSince,
  retireHintFor,
} from '@/lib/price-monitor/insights'
import {
  readKnifePaid,
  readPriceAlertContext,
  readPriceAlertRules,
  readPriceNotifications,
  writePriceNotificationChanges,
} from '@/lib/price-monitor/notification-store'
import { toMinorUnits } from '@/lib/price-monitor/money'
import { DEFAULT_PRICE_MONITORING } from '@/lib/settings-shared'
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
  notify_muted_until: string | null
  /** The variant this source tracks (JSON ExpectedVariant), once learned. */
  expected_variant: string | null
  /** The supervisor asked AI to look for this product's new link. */
  find_page_at: string | null
  /**
   * Other stores: the search (store:marketplace) that keeps this listing of
   * another variant of the model; null for the knife's own product.
   */
  variant_search: string | null
  variant_title: string | null
  /** When the source ran into its current problem (attention statuses). */
  attention_since: string | null
  /** The user put the problem off until then (Later in Needs attention). */
  attention_snoozed_until: string | null
  /** When the daily Needs attention summary last raised it. */
  attention_reported_at: string | null
  /** A price the user confirmed over AI's doubt: not doubted again. */
  accepted_price_minor: number | null
  accepted_currency: string | null
  /** Why it is paused: manual, missing_page or auto_attention. */
  paused_reason: PausedReason | null
  paused_at: string | null
}

export type PausedReason = 'manual' | 'missing_page' | 'auto_attention'

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
  /** JSON steps the AI problem solver found work for this store. */
  solverRecipe: string | null
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

/**
 * The AI supervisor's close watch on a knife while it lasts: its sources
 * are checked at least every `intervalMs` until `until`.
 */
export function readKnifeFocus(
  database: Database.Database,
  knifeId: string,
  now = Date.now(),
): PriceWatchFocus | null {
  const row = database
    .prepare(
      `SELECT focus_until, focus_interval_ms, focus_reason
       FROM price_watch WHERE knife_id = ?`,
    )
    .get(knifeId) as
    | {
        focus_until: string | null
        focus_interval_ms: number | null
        focus_reason: string | null
      }
    | undefined
  return activeFocus(row, now)
}

/**
 * Starts (or replaces) a close watch on a knife and brings its next checks
 * forward to the new interval; blocked sources keep their bot-check
 * backoff. Must run inside the caller's vault write. Returns whether the
 * watch was stored.
 */
export function startKnifeFocus(
  database: Database.Database,
  knifeId: string,
  watch: { hours: number; everyHours: number; reason: string },
  now: number,
): boolean {
  const nowIso = new Date(now).toISOString()
  const intervalMs = Math.round(watch.everyHours * 3_600_000)
  const next = new Date(now + intervalMs).toISOString()
  // A row made only for the watch keeps the default Auto mode.
  const { changes } = database
    .prepare(
      `INSERT INTO price_watch
         (knife_id, mode, updated_at, focus_until, focus_interval_ms,
          focus_reason)
       VALUES (?, 'auto', ?, ?, ?, ?)
       ON CONFLICT(knife_id) DO UPDATE SET
         updated_at = excluded.updated_at,
         focus_until = excluded.focus_until,
         focus_interval_ms = excluded.focus_interval_ms,
         focus_reason = excluded.focus_reason`,
    )
    .run(
      knifeId,
      nowIso,
      new Date(now + watch.hours * 3_600_000).toISOString(),
      intervalMs,
      watch.reason,
    )
  database
    .prepare(
      `UPDATE price_sources SET next_check_at = ?, updated_at = ?
       WHERE knife_id = ? AND removed_at IS NULL AND enabled = 1
         AND status <> 'blocked' AND next_check_at > ?`,
    )
    .run(next, nowIso, knifeId, next)
  return changes > 0
}

function activeFocus(
  row:
    | {
        focus_until: string | null
        focus_interval_ms: number | null
        focus_reason: string | null
      }
    | undefined,
  now: number,
): PriceWatchFocus | null {
  if (!row?.focus_until || !row.focus_interval_ms) return null
  const until = Date.parse(row.focus_until)
  if (!Number.isFinite(until) || until <= now || row.focus_interval_ms <= 0)
    return null
  return {
    until: row.focus_until,
    intervalMs: Math.max(
      row.focus_interval_ms,
      FOCUS_MIN_EVERY_HOURS * 3_600_000,
    ),
    reason: row.focus_reason ?? '',
  }
}

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

/**
 * Sources that count toward MAX_PRICE_SOURCES_PER_KNIFE: the knife's own
 * product, not the listings of other variants Other stores keeps.
 */
export function countOwnSources(
  sources: readonly Pick<SourceRow, 'variant_search'>[],
): number {
  return sources.filter((source) => source.variant_search === null).length
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

/**
 * Readings AI could not confirm (ai_review = 'unconfirmed') are kept in the
 * history but never become the baseline later readings are compared with:
 * a repeat of the same doubtful price is checked again, and the true price
 * coming back is not reported as a change.
 */
const TRUSTED = "(ai_review IS NULL OR ai_review <> 'unconfirmed')"

export function readLatestSnapshot(
  database: Database.Database,
  sourceId: number,
): SnapshotState | null {
  return toSnapshotState(
    database
      .prepare(
        `SELECT id, price_minor, currency, availability FROM price_snapshots
         WHERE source_id = ? AND ${TRUSTED} ORDER BY id DESC LIMIT 1`,
      )
      .get(sourceId) as SnapshotRow | undefined,
  )
}

/** Trusted snapshots' stock status, newest first, for detectStockChange. */
export function readStockHistory(
  database: Database.Database,
  sourceId: number,
): StockSnapshot[] {
  return database
    .prepare(
      `SELECT id, availability, observations FROM price_snapshots
       WHERE source_id = ? AND ${TRUSTED} ORDER BY id DESC LIMIT ?`,
    )
    .all(sourceId, STOCK_HISTORY_LIMIT) as StockSnapshot[]
}

/** Whether the source has any reading at all, trusted or not. */
export function hasAnySnapshot(
  database: Database.Database,
  sourceId: number,
): boolean {
  return Boolean(
    database
      .prepare('SELECT 1 FROM price_snapshots WHERE source_id = ? LIMIT 1')
      .get(sourceId),
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
         WHERE source_id = ? AND price_minor IS NOT NULL AND ${TRUSTED}
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
           AND ${TRUSTED}
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
        solver_recipe: string | null
      }
    | undefined
  return {
    laneKey,
    strategy: row?.strategy ?? 'auto',
    strategyUntil: row?.strategy_until ?? null,
    httpMatchStreak: row?.http_match_streak ?? 0,
    solverRecipe: row?.solver_recipe ?? null,
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
    notifyMutedUntil:
      row.notify_muted_until && Date.parse(row.notify_muted_until) > Date.now()
        ? row.notify_muted_until
        : null,
    ...(row.variant_search !== null
      ? { variantTitle: row.variant_title || row.store_name }
      : {}),
  }
}

export function buildPriceWatchView(
  knife: Knife,
  settings: EligibilitySettings = DEFAULT_ELIGIBILITY_SETTINGS,
): PriceWatchView {
  const database = db()
  const scoped = withMonitorScope(database, settings)
  const mode = readWatchMode(database, knife.id)
  const sources = readActiveSources(database, knife.id)
  const found = readDiscoveredSourceIds(database, knife.id)
  const outOfStockSince = readOutOfStockSince(database)
  const missingPages = readMissingPageSourceIds(database)
  const now = Date.now()
  const withHints = (source: SourceRow): PriceSourceView => {
    const since =
      source.last_availability === 'out_of_stock'
        ? (outOfStockSince.get(source.id) ?? null)
        : null
    return {
      ...toSourceView(source),
      outOfStockSince: since,
      retireHint: retireHintFor({
        outOfStockSince: since,
        pageGone: missingPages.has(source.id),
        now,
      }),
      ...(found.has(source.id) ? { foundByAi: true } : {}),
      ...(isIgnoredOfficialOutOfStock(
        { origin: source.origin, availability: source.last_availability },
        settings,
      )
        ? { stockAlertsOff: true }
        : {}),
    }
  }
  return {
    knifeId: knife.id,
    mode,
    eligibility: getEligibility(
      knife,
      mode,
      sources.filter((source) => source.enabled === 1).length,
      scoped,
    ),
    sources: sources.map(withHints),
    maxSources: MAX_PRICE_SOURCES_PER_KNIFE,
    // Check now waits as priority 2 until its store's next free slot.
    queuedSourceIds: sources
      .filter((source) => source.priority >= 2 || source.status === 'checking')
      .map((source) => source.id),
    alerts: readPriceAlertRules(database, knife.id),
    paid: readKnifePaid(database, knife.id),
    focus: readKnifeFocus(database, knife.id, now),
  }
}

/** Sources that Other stores added (AI found and confirmed them). */
export function readDiscoveredSourceIds(
  database: Database.Database,
  knifeId: string,
): Set<number> {
  return new Set(
    (
      database
        .prepare(
          `SELECT source_id FROM price_discovery
           WHERE knife_id = ? AND source_id IS NOT NULL`,
        )
        .all(knifeId) as Array<{ source_id: number }>
    ).map((row) => row.source_id),
  )
}

// --------------------------------------------------------------- writes

export function insertSource(
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

/**
 * A variant listing becomes one of the knife's own stores: you added its
 * link, or Other stores found it as the knife's own product. Its history
 * stays; from now on it counts toward the knife's price and alerts.
 */
export function promoteVariantSource(
  database: Database.Database,
  sourceId: number,
  storeName: string | undefined,
  now: string,
) {
  database
    .prepare(
      `UPDATE price_sources
       SET variant_search = NULL, variant_title = NULL, enabled = 1,
           store_name = COALESCE(?, store_name), updated_at = ?
       WHERE id = ?`,
    )
    .run(storeName || null, now, sourceId)
}

/**
 * Pauses or resumes one source and records why. A resumed source starts
 * Needs attention afresh: its problem counts from its next check.
 */
export function setSourcePaused(
  database: Database.Database,
  sourceId: number,
  paused: boolean,
  reason: PausedReason,
  now: string,
) {
  database
    .prepare(
      paused
        ? `UPDATE price_sources
           SET enabled = 0, paused_reason = ?, paused_at = ?, updated_at = ?
           WHERE id = ?`
        : `UPDATE price_sources
           SET enabled = 1, paused_reason = NULL, paused_at = NULL,
               attention_since = NULL, attention_snoozed_until = NULL,
               attention_reported_at = NULL, updated_at = ?
           WHERE id = ?`,
    )
    .run(...(paused ? [reason, now, now, sourceId] : [now, sourceId]))
}

export function softRemove(
  database: Database.Database,
  ids: number[],
  now: string,
) {
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
    if (countOwnSources(active) >= MAX_PRICE_SOURCES_PER_KNIFE) return
    if (!restoreAutoSource(database, knife.id, plan.add, now))
      insertSource(database, knife.id, plan.add, 'auto', undefined, now)
  }
}

/**
 * Brings back the knife's removed auto source for the same link, with its
 * price history, instead of starting a new one. Auto sources are only ever
 * removed by the app (the product link changed, or Amazon was left out of
 * Price Drops for a while), never by the person. It is checked again soon.
 */
function restoreAutoSource(
  database: Database.Database,
  knifeId: string,
  url: string,
  now: string,
): boolean {
  const normalized = normalizeSourceUrl(url)
  if (!normalized) return false
  const removed = database
    .prepare(
      `SELECT id FROM price_sources
       WHERE knife_id = ? AND origin = 'auto' AND normalized_url = ?
         AND removed_at IS NOT NULL
       ORDER BY removed_at DESC, id DESC LIMIT 1`,
    )
    .get(knifeId, normalized) as { id: number } | undefined
  if (!removed) return false
  database
    .prepare(
      `UPDATE price_sources
       SET removed_at = NULL, url = ?, provider = ?, lane_key = ?,
           status = 'pending', next_check_at = NULL, updated_at = ?
       WHERE id = ?`,
    )
    .run(url, providerForUrl(url), laneKeyForUrl(url), now, removed.id)
  return true
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

      if (update.stopWatching)
        database
          .prepare(
            `UPDATE price_watch SET focus_until = NULL,
               focus_interval_ms = NULL, focus_reason = NULL, updated_at = ?
             WHERE knife_id = ?`,
          )
          .run(now, knife.id)

      if (update.alerts) {
        const current = readPriceAlertRules(database, knife.id)
        const { alerts } = update
        const target =
          alerts.targetPrice === undefined
            ? current.targetPrice
            : alerts.targetPrice === null
              ? null
              : {
                  minor: toMinorUnits(
                    alerts.targetPrice.amount,
                    alerts.targetPrice.currency,
                  ),
                  currency: alerts.targetPrice.currency,
                }
        // A row made only for alert rules keeps the default Auto mode.
        database
          .prepare(
            `INSERT INTO price_watch
               (knife_id, mode, updated_at, target_price_minor,
                target_currency, notify_below_paid, notify_muted)
             VALUES (?, 'auto', ?, ?, ?, ?, ?)
             ON CONFLICT(knife_id) DO UPDATE SET
               updated_at = excluded.updated_at,
               target_price_minor = excluded.target_price_minor,
               target_currency = excluded.target_currency,
               notify_below_paid = excluded.notify_below_paid,
               notify_muted = excluded.notify_muted`,
          )
          .run(
            knife.id,
            now,
            target?.minor ?? null,
            target?.currency ?? null,
            (alerts.belowPaid ?? current.belowPaid) ? 1 : 0,
            (alerts.muted ?? current.muted) ? 1 : 0,
          )
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
        // A variant listing you remove stays paused, so a later search of
        // its store does not bring it back.
        if (source.variant_search !== null)
          database
            .prepare('UPDATE price_sources SET enabled = 0 WHERE id = ?')
            .run(id)
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
        const enabled =
          change.enabled === undefined ? source.enabled : change.enabled ? 1 : 0
        if (enabled !== source.enabled)
          setSourcePaused(database, source.id, enabled === 0, 'manual', now)
        database
          .prepare(
            `UPDATE price_sources
             SET store_name = ?, enabled = ?, fetch_override = ?,
                 notify_muted_until = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            storeName,
            enabled,
            change.fetchOverride ?? source.fetch_override,
            change.muteDays === undefined
              ? source.notify_muted_until
              : change.muteDays === 0
                ? null
                : new Date(
                    Date.parse(now) + change.muteDays * 86_400_000,
                  ).toISOString(),
            now,
            change.id,
          )
      }

      for (const item of update.add ?? []) {
        const normalized = normalizeSourceUrl(item.url)
        const active = readActiveSources(database, knife.id)
        const same = active.find(
          (source) => source.normalized_url === normalized,
        )
        if (same && same.variant_search === null)
          throw new PriceWatchError('This URL is already monitored.', 409)
        if (countOwnSources(active) >= MAX_PRICE_SOURCES_PER_KNIFE)
          throw new PriceWatchError(
            `A knife can have at most ${MAX_PRICE_SOURCES_PER_KNIFE} price sources.`,
          )
        // A variant listing you add yourself becomes one of the knife's own
        // stores, with the history it has.
        if (same) {
          promoteVariantSource(database, same.id, item.storeName, now)
          continue
        }
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

/**
 * A check the computer's sleep or a local network outage cut short: the
 * source gets its previous status back and runs again at `nextCheckAt`.
 * No check log row, rollup, failure count, store state or AI pause: the
 * store did nothing wrong. A Check now request stays queued.
 */
export async function deferSourceCheck(
  sourceId: number,
  generation: string,
  input: { status: PriceSourceStatus; nextCheckAt: string },
): Promise<void> {
  await withVaultWrite(async () => {
    assertVaultGeneration(generation)
    db()
      .prepare(
        `UPDATE price_sources SET status = ?, next_check_at = ?, updated_at = ?
         WHERE id = ? AND removed_at IS NULL`,
      )
      .run(
        input.status === 'checking' ? 'pending' : input.status,
        input.nextCheckAt,
        new Date().toISOString(),
        sourceId,
      )
  })
}

export type CheckOutcomeKind = 'ok' | 'no_price' | 'failed' | 'blocked'

export type RecordedObservation = Observation & {
  extractionStatus: 'ok' | 'ai' | 'no_price'
  extractionMethod: string
}

export type HostPatch = Partial<
  Pick<
    HostState,
    'strategy' | 'strategyUntil' | 'httpMatchStreak' | 'solverRecipe'
  >
>

export type CheckRecord = {
  generation: string
  sourceId: number
  trigger: 'scheduled' | 'manual' | 'retry' | 'probe'
  startedAt: string
  durationMs: number
  outcome: CheckOutcomeKind
  /**
   * 'ai': the price was read by the AI fallback from the fetched page.
   * 'solver': the AI problem solver (or a store recipe it found) got it.
   */
  method: 'http' | 'browser' | 'headed' | 'ai' | 'solver' | null
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
  /** The AI fallback was asked (successful or not): starts its 24 h pause. */
  aiUsed?: boolean
  /** What the AI problem solver did on the page, for the check history. */
  solverSteps?: ReadonlyArray<{
    action: string
    detail: string
    result: string
  }> | null
  /** Inbox categories and thresholds; the defaults when left out. */
  notifications?: PriceNotificationSettings
  /**
   * What AI said when it checked the reading against the page
   * (price-monitor/verify). An 'unconfirmed' reading is stored apart: no
   * price or stock events, no notifications, the source keeps its last
   * price, and later readings are not compared with it.
   */
  aiReview?: 'confirmed' | 'unconfirmed' | null
  /** AI doubts the page parser's reading: the source needs review. */
  needsReview?: boolean
  /** The variant the source tracks, learned on this check (JSON). */
  expectedVariant?: string | null
  /** Forget the learned variant: the next good reading learns it again. */
  forgetVariant?: boolean
  /**
   * What AI recovery did, for the weekly numbers: "kind:result", e.g.
   * "relink:asked" or "variant:fixed" (see RECOVERY_KINDS).
   */
  recovery?: string | null
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
  observation:
    Pick<Observation, 'priceMinor' | 'availability'> | null | undefined,
  needsReview = false,
): PriceSourceStatus {
  if (outcome === 'failed') return 'failed'
  if (outcome === 'blocked') return 'blocked'
  if (needsReview) return 'needs_review'
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
         http_match_streak, solver_recipe, last_outcome, updated_at)
       VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(lane_key) DO UPDATE SET
         strategy = excluded.strategy,
         strategy_until = excluded.strategy_until,
         http_match_streak = excluded.http_match_streak,
         solver_recipe = excluded.solver_recipe,
         last_outcome = excluded.last_outcome,
         updated_at = excluded.updated_at`,
    )
    .run(
      laneKey,
      now,
      next.strategy,
      next.strategyUntil,
      next.httpMatchStreak,
      next.solverRecipe,
      outcome,
      now,
    )
}

/**
 * Stores one finished check in a single transaction: the check log, the
 * snapshot (extended when nothing changed), price and stock events with
 * their Inbox notifications, the source's cached state, the daily rollup and the store's lane state.
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
               outcome, method, attempt, http_status, error_code, error_message,
               solver_steps, recovery)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            record.solverSteps?.length
              ? JSON.stringify(record.solverSteps)
              : null,
            record.recovery ?? null,
          ).lastInsertRowid,
      )

      let detection: DetectResult | null = null
      let snapshotId: number | null = null
      const events: PriceNotificationEvent[] = []
      const unconfirmed = Boolean(
        observation && record.aiReview === 'unconfirmed',
      )
      if (observation && unconfirmed) {
        // A repeat of the same doubtful reading extends its snapshot.
        const last = database
          .prepare(
            `SELECT id, price_minor, currency, availability, ai_review
             FROM price_snapshots WHERE source_id = ?
             ORDER BY id DESC LIMIT 1`,
          )
          .get(source.id) as
          (SnapshotRow & { ai_review: string | null }) | undefined
        if (
          last &&
          last.ai_review === 'unconfirmed' &&
          last.price_minor === observation.priceMinor &&
          last.currency === observation.currency &&
          last.availability === observation.availability
        ) {
          snapshotId = last.id
          database
            .prepare(
              `UPDATE price_snapshots
               SET last_seen_at = ?, observations = observations + 1
               WHERE id = ?`,
            )
            .run(now, last.id)
        } else {
          snapshotId = Number(
            database
              .prepare(
                `INSERT INTO price_snapshots
                  (knife_id, source_id, price_minor, currency, availability,
                   extraction_status, extraction_method, observed_at,
                   last_seen_at, check_log_id, ai_review)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unconfirmed')`,
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
      } else if (observation) {
        const latest = readLatestSnapshot(database, source.id)
        detection = detectChange(
          latest,
          readLatestPricedSnapshot(database, source.id),
          observation,
        )
        const stockHistory = readStockHistory(database, source.id)
        const stock = detectStockChange(stockHistory, observation.availability)
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
                   last_seen_at, check_log_id, ai_review)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                record.aiReview ?? null,
              ).lastInsertRowid,
          )
        }
        const price = detection.priceChange
        if (price) {
          const eventId = Number(
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
              ).lastInsertRowid,
          )
          events.push({
            kind: price.direction,
            eventId,
            knifeId: source.knife_id,
            sourceId: source.id,
            currency: price.currency,
            deltaMinor: price.deltaMinor,
            deltaPct: price.deltaPct,
            priceMinor: price.priceMinor,
          })
        }
        if (stock) {
          // Dated when the new status was first read, not when confirmed.
          const changedAt =
            (
              database
                .prepare('SELECT observed_at FROM price_snapshots WHERE id = ?')
                .get(stock.toSnapshotId) as { observed_at: string } | undefined
            )?.observed_at ?? now
          const eventId = Number(
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
                stock.toSnapshotId,
                source.url,
                source.store_name,
                changedAt,
              ).lastInsertRowid,
          )
          events.push({
            kind: stock.kind,
            eventId,
            knifeId: source.knife_id,
            sourceId: source.id,
          })
        }
        // A store's first reading is news for the knife when it sells it
        // cheaper than its other stores, or while they are out of stock.
        // A listing of another variant is not the knife's own store.
        const variant = source.variant_search !== null
        if (!variant && !stockHistory.length && snapshotId !== null) {
          const knifeEvent = recordNewStoreEvent(database, {
            knifeId: source.knife_id,
            sourceId: source.id,
            sourceUrl: source.url,
            storeName: source.store_name,
            snapshotId,
            reading: observation,
            extractionMethod: observation.extractionMethod,
            occurredAt: now,
          })
          if (knifeEvent) events.push(knifeEvent)
        }
        const notifications = record.notifications ?? DEFAULT_PRICE_MONITORING
        // Out of stock on an ignored official link stays in history only,
        // and so does every change of another variant's listing.
        const notifiable = variant
          ? []
          : events.filter(
              (event) =>
                event.kind !== 'out_of_stock' ||
                !isIgnoredOfficialOutOfStock(
                  { origin: source.origin, availability: 'out_of_stock' },
                  notifications,
                ),
            )
        if (notifiable.length) {
          const alertContext = readPriceAlertContext(database, {
            knifeId: source.knife_id,
            sourceId: source.id,
            currency: observation.currency,
            excludeSnapshotId: snapshotId,
            settings: notifications,
          })
          writePriceNotificationChanges(
            database,
            planPriceNotifications(
              notifiable,
              // The knife's rows: back in stock anywhere closes them all.
              readPriceNotifications(database, { knifeId: source.knife_id }),
              notifications,
              new Date(now),
              () => alertContext,
            ),
          )
        }
      }

      const succeeded = record.outcome === 'ok' || record.outcome === 'no_price'
      // The source keeps its last trusted price over a doubtful reading.
      const cached = unconfirmed ? null : observation
      const status = sourceStatusFor(
        record.outcome,
        unconfirmed
          ? {
              priceMinor: source.last_price_minor,
              availability: source.last_availability ?? 'unknown',
            }
          : observation,
        record.needsReview,
      )
      // Needs attention: a problem keeps the time it started; a page that
      // reads fine again forgets it, its put-off and its last report.
      const inTrouble = (ATTENTION_STATUS_LIST as readonly string[]).includes(
        status,
      )
      database
        .prepare(
          `UPDATE price_sources SET
             attention_since = CASE WHEN ? THEN COALESCE(attention_since, ?)
               ELSE NULL END,
             attention_snoozed_until = CASE WHEN ? THEN attention_snoozed_until
               ELSE NULL END,
             attention_reported_at = CASE WHEN ? THEN attention_reported_at
               ELSE NULL END,
             paused_reason = CASE WHEN ? THEN 'missing_page' ELSE paused_reason END,
             paused_at = CASE WHEN ? THEN ? ELSE paused_at END
           WHERE id = ?`,
        )
        .run(
          inTrouble ? 1 : 0,
          now,
          inTrouble ? 1 : 0,
          inTrouble ? 1 : 0,
          record.disable ? 1 : 0,
          record.disable ? 1 : 0,
          now,
          source.id,
        )
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
             last_ai_at = CASE WHEN ? THEN ? ELSE last_ai_at END,
             expected_variant = CASE WHEN ? THEN NULL
               ELSE COALESCE(?, expected_variant) END,
             find_page_at = NULL,
             updated_at = ?
           WHERE id = ?`,
        )
        .run(
          status,
          record.provider ?? source.provider,
          now,
          succeeded ? 1 : 0,
          now,
          cached?.priceMinor ?? null,
          cached?.priceMinor !== null && cached?.priceMinor !== undefined
            ? cached.currency
            : null,
          cached?.availability ?? null,
          record.errorCode ?? null,
          record.errorMessage ?? null,
          succeeded ? 1 : 0,
          record.nextCheckAt,
          record.disable ? 1 : 0,
          record.aiUsed ? 1 : 0,
          now,
          record.forgetVariant ? 1 : 0,
          record.expectedVariant ?? null,
          now,
          source.id,
        )

      database
        .prepare(
          `INSERT INTO price_monitor_daily
            (day, lane_key, checks, ok, no_price, failed, blocked, ai_used,
             total_ms)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(day, lane_key) DO UPDATE SET
             checks = checks + 1,
             ok = ok + excluded.ok,
             no_price = no_price + excluded.no_price,
             failed = failed + excluded.failed,
             blocked = blocked + excluded.blocked,
             ai_used = ai_used + excluded.ai_used,
             total_ms = total_ms + excluded.total_ms`,
        )
        .run(
          localDay(record.startedAt),
          source.lane_key,
          record.outcome === 'ok' ? 1 : 0,
          record.outcome === 'no_price' ? 1 : 0,
          record.outcome === 'failed' ? 1 : 0,
          record.outcome === 'blocked' ? 1 : 0,
          record.aiUsed ? 1 : 0,
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
  paused_at: string | null
  soft_fail_streak: number | null
  typical_ms: number | null
  duration_samples: number | null
  robots_delay_ms: number | null
  open_reason: string | null
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
): Map<
  string,
  LaneState & { strategy: HostStrategy; pausedAt: number | null }
> {
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
        softFailStreak: row.soft_fail_streak ?? 0,
        typicalMs: row.typical_ms,
        durationSamples: row.duration_samples ?? 0,
        robotsDelayMs: row.robots_delay_ms,
        openReason: row.open_reason === 'soft_block' ? 'soft_block' : null,
        strategy: row.strategy,
        pausedAt: parseTime(row.paused_at),
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
           success_streak, failure_streak, last_request_at, soft_fail_streak,
           typical_ms, duration_samples, open_reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(lane_key) DO UPDATE SET
           min_gap_ms = excluded.min_gap_ms,
           ready_at = excluded.ready_at,
           circuit = excluded.circuit,
           cooldown_until = excluded.cooldown_until,
           open_count = excluded.open_count,
           success_streak = excluded.success_streak,
           failure_streak = excluded.failure_streak,
           last_request_at = excluded.last_request_at,
           soft_fail_streak = excluded.soft_fail_streak,
           typical_ms = excluded.typical_ms,
           duration_samples = excluded.duration_samples,
           open_reason = excluded.open_reason,
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
        lane.softFailStreak ?? 0,
        lane.typicalMs === null || lane.typicalMs === undefined
          ? null
          : Math.round(lane.typicalMs),
        lane.durationSamples ?? 0,
        lane.openReason ?? null,
        now,
      )
  })
}

/** What happened at one store over a time window (price_check_log). */
export type LaneHealth = {
  checks: number
  ok: number
  noPrice: number
  /** The store asked us to slow down (HTTP 429 or 503). */
  throttled: number
  /** Bot checks and other refusals (403). */
  blocked: number
  /** Network errors, timeouts and other failures. */
  failed: number
}

export function emptyLaneHealth(): LaneHealth {
  return { checks: 0, ok: 0, noPrice: 0, throttled: 0, blocked: 0, failed: 0 }
}

/** Each store's checks since `since` (epoch ms), by what happened. */
export function readLaneHealth(
  database: Database.Database,
  since: number,
): Map<string, LaneHealth> {
  const rows = database
    .prepare(
      `SELECT lane_key AS laneKey,
              COUNT(*) AS checks,
              SUM(outcome = 'ok') AS ok,
              SUM(outcome = 'no_price') AS noPrice,
              SUM(outcome IN ('failed', 'blocked')
                  AND http_status IN (429, 503)) AS throttled,
              SUM(outcome = 'blocked'
                  AND COALESCE(http_status, 0) NOT IN (429, 503)) AS blocked,
              SUM(outcome = 'failed'
                  AND COALESCE(http_status, 0) NOT IN (429, 503)) AS failed
       FROM price_check_log
       WHERE started_at >= ?
       GROUP BY lane_key`,
    )
    .all(new Date(since).toISOString()) as Array<
    { laneKey: string } & Record<keyof LaneHealth, number | null>
  >
  return new Map(
    rows.map((row) => [
      row.laneKey,
      {
        checks: row.checks ?? 0,
        ok: row.ok ?? 0,
        noPrice: row.noPrice ?? 0,
        throttled: row.throttled ?? 0,
        blocked: row.blocked ?? 0,
        failed: row.failed ?? 0,
      },
    ]),
  )
}

/** Stores whose robots.txt was not read in this long are read again. */
export const ROBOTS_REFRESH_MS = 24 * 60 * 60 * 1000

/**
 * Stores with active sources whose robots.txt is due for a read, with one
 * of their links (its origin is where robots.txt lives). Stores the user
 * paused, or cooling down after a block, are left alone.
 */
export function readRobotsDue(
  database: Database.Database,
  now: number,
): Array<{ laneKey: string; url: string }> {
  return database
    .prepare(
      `SELECT s.lane_key AS laneKey, MIN(s.url) AS url
       FROM price_sources s
       LEFT JOIN price_host_state h ON h.lane_key = s.lane_key
       WHERE s.removed_at IS NULL AND s.enabled = 1
         AND h.paused_at IS NULL
         AND COALESCE(h.circuit, 'closed') = 'closed'
         AND (h.robots_checked_at IS NULL OR h.robots_checked_at < ?)
       GROUP BY s.lane_key
       ORDER BY s.lane_key`,
    )
    .all(new Date(now - ROBOTS_REFRESH_MS).toISOString()) as Array<{
    laneKey: string
    url: string
  }>
}

/** Stores a store's robots.txt Crawl-delay (null: none or unreadable). */
export async function writeRobotsDelay(
  laneKey: string,
  delayMs: number | null,
  generation: string,
): Promise<void> {
  await withVaultWrite(async () => {
    assertVaultGeneration(generation)
    const now = new Date().toISOString()
    db()
      .prepare(
        `INSERT INTO price_host_state
          (lane_key, min_gap_ms, ready_at, robots_delay_ms, robots_checked_at,
           updated_at)
         VALUES (?, 0, ?, ?, ?, ?)
         ON CONFLICT(lane_key) DO UPDATE SET
           robots_delay_ms = excluded.robots_delay_ms,
           robots_checked_at = excluded.robots_checked_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        laneKey,
        now,
        delayMs === null ? null : Math.round(delayMs),
        now,
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
  covered: boolean
  /** The user paused the whole store in Settings → Stores. */
  storePaused: boolean
  /**
   * Covered and its store not paused: scheduled checks run. Out of stock
   * never stops them; the official-site setting only quiets alerts.
   */
  scheduled: boolean
  /** Start of the current out-of-stock run (epoch ms), or null. */
  outOfStockSince: number | null
  /** Never checked yet: its first reading skips the store's spread. */
  firstReading: boolean
  /** Last check (epoch ms), or null when never checked. */
  lastCheckedAt: number | null
  /** The knife is watched closely: at most this long between checks. */
  focusIntervalMs: number | null
  /**
   * scope: in What to monitor (the rounds); collection: the rest of the
   * collection, checked by the collection pass in free time.
   */
  tier: MonitorTier
  /**
   * A listing of another variant of the model (Other stores): checked like
   * the rest, kept out of the knife's price, alerts and summaries.
   */
  variant: boolean
}

/**
 * Every source the queue might check: Check now requests regardless of mode
 * or pause, plus enabled sources of eligible knives.
 */
export function readQueueCandidates(
  database: Database.Database,
  settings: EligibilitySettings,
  now = Date.now(),
): CandidateRow[] {
  const rows = database
    .prepare(
      `SELECT s.id, s.knife_id, s.lane_key, s.priority, s.next_check_at,
              s.enabled, s.origin, s.last_availability, s.last_checked_at,
              k.specs, k.sold, COALESCE(w.mode, 'auto') AS mode,
              w.focus_until, w.focus_interval_ms, w.focus_reason,
              h.paused_at IS NOT NULL AS store_paused,
              s.variant_search IS NOT NULL AS variant
       FROM price_sources s
       JOIN knives k ON k.id = s.knife_id
       LEFT JOIN price_watch w ON w.knife_id = s.knife_id
       LEFT JOIN price_host_state h ON h.lane_key = s.lane_key
       WHERE s.removed_at IS NULL AND (s.priority >= 2 OR s.enabled = 1)`,
    )
    .all() as Array<{
    id: number
    knife_id: string
    lane_key: string
    priority: number
    next_check_at: string | null
    enabled: number
    origin: PriceSourceOrigin
    last_availability: Availability | null
    last_checked_at: string | null
    specs: string
    sold: number
    mode: PriceWatchMode
    focus_until: string | null
    focus_interval_ms: number | null
    focus_reason: string | null
    store_paused: number
    variant: number
  }>
  const outOfStockSince = readOutOfStockSince(database)
  const scoped = withMonitorScope(database, settings)
  const eligible = new Map<string, PriceWatchEligibility>()
  return rows.map((row) => {
    let eligibility = eligible.get(row.knife_id)
    if (eligibility === undefined) {
      let price: string | undefined
      try {
        price = (JSON.parse(row.specs) as { price?: string }).price
      } catch {
        price = undefined
      }
      eligibility = getEligibility(
        { id: row.knife_id, sold: row.sold === 1, specs: { price } },
        row.mode,
        1,
        scoped,
      )
      eligible.set(row.knife_id, eligibility)
    }
    const covered = eligibility.monitored && row.enabled === 1
    const storePaused = row.store_paused === 1
    return {
      sourceId: row.id,
      knifeId: row.knife_id,
      laneKey: row.lane_key,
      priority: row.priority,
      nextCheckAt: parseTime(row.next_check_at),
      covered,
      storePaused,
      scheduled: covered && !storePaused,
      outOfStockSince: parseTime(outOfStockSince.get(row.id) ?? null),
      firstReading: row.last_checked_at === null,
      lastCheckedAt: parseTime(row.last_checked_at),
      focusIntervalMs: activeFocus(row, now)?.intervalMs ?? null,
      tier: eligibility.tier,
      variant: row.variant === 1,
    }
  })
}

/**
 * Knives scheduled monitoring covers right now: in What to monitor, eligible
 * (watch mode, regular price, sold) and with an enabled source. Price Drops
 * and the AI supervisor leave everything else out.
 */
export function readCoveredKnifeIds(
  database: Database.Database,
  settings: EligibilitySettings,
  now = Date.now(),
): Set<string> {
  return new Set(
    readQueueCandidates(database, settings, now)
      .filter((candidate) => candidate.covered)
      .map((candidate) => candidate.knifeId),
  )
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
 * An older build stands down for this long after a newer one last held
 * the lease, so a server left running from before an update cannot take
 * monitoring back when the new one quits or sleeps.
 */
export const NEWER_BUILD_PRECEDENCE_MS = 24 * 60 * 60 * 1000

/** The app version this server runs; stored with the lease. */
export const WORKER_BUILD: string = pkg.version

/**
 * Compares app versions ("2.5.11") part by part, numerically. A missing
 * version (a lease written before versions were stored) is the oldest.
 */
export function compareBuilds(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  if (!left || !right) return left ? 1 : right ? -1 : 0
  const parts = (value: string) =>
    value
      .split(/[.+-]/)
      .map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index] ?? 0
    const y = b[index] ?? 0
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1
    return String(x) < String(y) ? -1 : 1
  }
  return 0
}

type WorkerLeaseRow = {
  owner: string
  heartbeat_at: string
  build: string | null
  released_at: string | null
}

function readWorkerLease(
  database: Database.Database,
): WorkerLeaseRow | undefined {
  return database
    .prepare(
      `SELECT owner, heartbeat_at, build, released_at
       FROM price_worker_lease WHERE id = 1`,
    )
    .get() as WorkerLeaseRow | undefined
}

/**
 * One worker per vault. Takes or renews the lease when it is free, ours,
 * released, or its heartbeat is older than three minutes. A newer build
 * takes it over at once; an older build never takes it while a newer one
 * holds it or held it within the last day.
 */
export async function acquireWorkerLease(
  owner: string,
  now = Date.now(),
  build: string = WORKER_BUILD,
): Promise<boolean> {
  return withVaultWrite(async () => {
    const database = db()
    const row = readWorkerLease(database)
    const heartbeat = row ? (parseTime(row.heartbeat_at) ?? 0) : 0
    const order = row ? compareBuilds(build, row.build) : 1
    if (order < 0 && now - heartbeat < NEWER_BUILD_PRECEDENCE_MS) return false
    const free =
      !row ||
      row.owner === owner ||
      order > 0 ||
      row.released_at !== null ||
      now - heartbeat > WORKER_LEASE_STALE_MS
    if (!free) return false
    database
      .prepare(
        `INSERT INTO price_worker_lease
           (id, owner, heartbeat_at, build, released_at)
         VALUES (1, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           owner = excluded.owner, heartbeat_at = excluded.heartbeat_at,
           build = excluded.build, released_at = NULL`,
      )
      .run(owner, new Date(now).toISOString(), build)
    return true
  })
}

/**
 * Whether this worker still holds the lease. In-flight work (a check, a
 * search, an AI run) asks before it writes, so work that was running when
 * the lease moved to another process (after sleep, or a newer build)
 * cannot keep writing.
 */
export function ownsWorkerLease(owner: string): boolean {
  const row = readWorkerLease(db())
  return row !== undefined && row.owner === owner && row.released_at === null
}

/**
 * Gives the lease up. The row stays with its version and last heartbeat,
 * so an older build still knows a newer one held it.
 */
export async function releaseWorkerLease(
  owner: string,
  now = Date.now(),
): Promise<void> {
  await withVaultWrite(async () => {
    db()
      .prepare(
        `UPDATE price_worker_lease SET released_at = ?
         WHERE id = 1 AND owner = ? AND released_at IS NULL`,
      )
      .run(new Date(now).toISOString(), owner)
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

/** A source's last check outcomes, newest first (for the AI troubleshooter). */
export function readRecentSourceChecks(
  database: Database.Database,
  sourceId: number,
  limit = 5,
): Array<{ outcome: CheckOutcomeKind; errorCode: string | null; at: string }> {
  return (
    database
      .prepare(
        `SELECT outcome, error_code, started_at FROM price_check_log
         WHERE source_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(sourceId, limit) as Array<{
      outcome: CheckOutcomeKind
      error_code: string | null
      started_at: string
    }>
  ).map((row) => ({
    outcome: row.outcome,
    errorCode: row.error_code,
    at: row.started_at,
  }))
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
    pruneAiCalls(db(), now)
  })
}

// ------------------------------------------------------- store actions

/**
 * Throws a 404 PriceWatchError unless some source or lane state uses the store;
 * returns its key as stored.
 */
export function assertStoreKnown(
  laneKey: string,
  database: Database.Database = db(),
): string {
  const known = database
    .prepare(
      `SELECT lane_key FROM price_sources
       WHERE lane_key = ? AND removed_at IS NULL
       UNION SELECT lane_key FROM price_host_state WHERE lane_key = ? LIMIT 1`,
    )
    .get(laneKey, laneKey) as { lane_key: string } | undefined
  if (!known) throw new PriceWatchError('Store not found', 404)
  // The key as stored, not as the request spelled it.
  return known.lane_key
}

/**
 * Resume now: ends a store's bot-check cooldown so its next check may start
 * right away. The breaker's escalation is kept, so a store that blocks
 * again pauses for longer.
 */
export async function resumeStoreNow(
  laneKey: string,
  now = Date.now(),
): Promise<void> {
  await withVaultWrite(async () => {
    const database = db()
    assertStoreKnown(laneKey, database)
    const iso = new Date(now).toISOString()
    database
      .prepare(
        `UPDATE price_host_state
         SET circuit = 'closed', cooldown_until = NULL, ready_at = ?,
             failure_streak = 0, updated_at = ?
         WHERE lane_key = ?`,
      )
      .run(iso, iso, laneKey)
  })
}

/**
 * Pauses or resumes scheduled checks at a whole store. Check now on a knife
 * still works while a store is paused.
 */
export async function setStorePaused(
  laneKey: string,
  paused: boolean,
  now = Date.now(),
): Promise<void> {
  await withVaultWrite(async () => {
    const database = db()
    assertStoreKnown(laneKey, database)
    const iso = new Date(now).toISOString()
    database
      .prepare(
        `INSERT INTO price_host_state (lane_key, min_gap_ms, ready_at, paused_at,
                                       updated_at)
         VALUES (?, 0, ?, ?, ?)
         ON CONFLICT(lane_key) DO UPDATE SET
           paused_at = excluded.paused_at, updated_at = excluded.updated_at`,
      )
      .run(laneKey, iso, paused ? iso : null, iso)
  })
}

/**
 * Check this store now: every source scheduled monitoring covers at the
 * store (also while the store is paused) becomes a Check now request; its
 * minimum gap and bot-check cooldown still apply. Returns the queued ids.
 */
export async function requestStoreChecks(
  laneKey: string,
  settings: EligibilitySettings,
): Promise<number[]> {
  const database = db()
  assertStoreKnown(laneKey, database)
  const ids = readQueueCandidates(database, settings)
    .filter((candidate) => candidate.laneKey === laneKey && candidate.covered)
    .map((candidate) => candidate.sourceId)
  return ids.length ? requestSourceChecks(ids) : []
}

/**
 * Moves a source to its product's new link on the same store, keeping its
 * price history, and checks it soon. False when the link is not usable or
 * another active source of the knife already has it.
 */
export function relinkSourceRow(
  database: Database.Database,
  sourceId: number,
  url: string,
  now: string,
): boolean {
  const source = readSource(database, sourceId)
  const normalized = normalizeSourceUrl(url)
  if (!source || source.removed_at || !normalized) return false
  if (laneKeyForUrl(url) !== source.lane_key) return false
  if (normalized === source.normalized_url) return true
  const taken = readActiveSources(database, source.knife_id).some(
    (other) => other.id !== source.id && other.normalized_url === normalized,
  )
  if (taken) return false
  database
    .prepare(
      `UPDATE price_sources
       SET url = ?, normalized_url = ?, enabled = 1, status = 'pending',
           consecutive_failures = 0, last_error_code = NULL,
           last_error = NULL, expected_variant = NULL, find_page_at = NULL,
           attention_since = NULL, attention_snoozed_until = NULL,
           attention_reported_at = NULL, paused_reason = NULL,
           paused_at = NULL, accepted_price_minor = NULL,
           accepted_currency = NULL,
           next_check_at = ?, priority = 1, updated_at = ?
       WHERE id = ?`,
    )
    .run(url, normalized, now, now, sourceId)
  return true
}

/** The kinds of AI recovery counted in the weekly numbers. */
export const RECOVERY_KINDS = [
  'unreadable',
  'relink',
  'variant',
  'blocked',
  'doubt',
] as const
export type RecoveryKind = (typeof RECOVERY_KINDS)[number]

export type RecoveryStats = Array<{
  kind: RecoveryKind
  /** Checks where AI recovery ran. */
  tried: number
  /** It got a price (or applied a new link) on its own. */
  fixed: number
  /** It left a question or a step for the collector. */
  asked: number
}>

/** What AI recovery did in the last `days` days, per kind. */
export function readRecoveryStats(
  database: Database.Database,
  now = Date.now(),
  days = 7,
): RecoveryStats {
  const rows = database
    .prepare(
      `SELECT recovery, COUNT(*) AS count FROM price_check_log
       WHERE recovery IS NOT NULL AND started_at >= ?
       GROUP BY recovery`,
    )
    .all(new Date(now - days * 86_400_000).toISOString()) as Array<{
    recovery: string
    count: number
  }>
  return RECOVERY_KINDS.map((kind) => {
    let tried = 0
    let fixed = 0
    let asked = 0
    for (const row of rows) {
      const [rowKind, result] = row.recovery.split(':')
      if (rowKind !== kind) continue
      tried += row.count
      if (result === 'fixed') fixed += row.count
      if (result === 'asked') asked += row.count
    }
    return { kind, tried, fixed, asked }
  })
}
