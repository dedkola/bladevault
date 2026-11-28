import {
  readAttentionSources,
  syncPriceAttention,
  type AttentionSource,
} from '@/lib/price-monitor/attention'
import type Database from 'better-sqlite3'
import {
  isAttentionStatus,
  suggestAttentionFix,
  type AttentionActionRequest,
  type AttentionActionResult,
  type AttentionFixContext,
  type AttentionItem,
  type AttentionList,
} from '@/lib/price-monitor/attention-filter'
import { clearBrowserState } from '@/lib/price-monitor/browser-state'
import { enabledDiscoveryStores } from '@/lib/price-monitor/discovery'
import { visibleBrowserWindowAvailable } from '@/lib/price-monitor/fetch'
import { MAX_PRICE_SOURCES_PER_KNIFE } from '@/lib/price-monitor/shared'
import {
  readSource,
  setSourcePaused,
  softRemove,
  type SourceRow,
} from '@/lib/price-monitor/store'
import { getPriceMonitorWorker } from '@/lib/price-monitor/worker'
import { getLocalDb } from '@/lib/local-db'
import { reportServerError } from '@/lib/sentry/server'
import { getSettings } from '@/lib/settings'
import { withVaultWrite } from '@/lib/vault-access'

const DAY_MS = 86_400_000

/** Statuses a check can retry: the page could not be read. */
const UNREAD_STATUSES = new Set(['blocked', 'failed', 'price_unavailable'])

/**
 * Whether Other stores could search for the knife now: it has room for
 * another store, and some turned-on store has no finished search for it
 * from the last day (no search yet, or one that failed or met a bot check).
 */
function otherStoresSearchable(
  database: Database.Database,
  knifeId: string,
  stores: readonly string[],
  now: number,
): boolean {
  if (!stores.length) return false
  const { count } = database
    .prepare(
      `SELECT COUNT(*) AS count FROM price_sources
       WHERE knife_id = ? AND removed_at IS NULL AND variant_search IS NULL`,
    )
    .get(knifeId) as { count: number }
  if (count >= MAX_PRICE_SOURCES_PER_KNIFE) return false
  const recent = new Set(
    (
      database
        .prepare(
          `SELECT store FROM price_discovery
           WHERE knife_id = ? AND last_attempt_at > ?
             AND status IN ('found', 'variant', 'not_found', 'rejected')`,
        )
        .all(knifeId, new Date(now - DAY_MS).toISOString()) as Array<{
        store: string
      }>
    ).map((row) => row.store),
  )
  return stores.some((store) => !recent.has(store))
}

export function toAttentionItem(
  source: AttentionSource,
  context?: AttentionFixContext,
): AttentionItem {
  return {
    sourceId: source.sourceId,
    knifeId: source.knifeId,
    knife: [source.brand, source.name].filter(Boolean).join(' '),
    storeName: source.storeName,
    url: source.url,
    status: source.status,
    verdict: source.verdict,
    since: source.attentionSince,
    priceMinor: source.priceMinor,
    currency: source.currency,
    consecutiveFailures: source.consecutiveFailures,
    lastError: source.lastError,
    origin: source.origin,
    review: source.review,
    suggestion: context
      ? suggestAttentionFix(
          {
            status: source.status,
            storeName: source.storeName,
            consecutiveFailures: source.consecutiveFailures,
          },
          context,
        )
      : null,
  }
}

/** Needs attention first, then snoozed, then quiet; newest problem first. */
export function readAttentionList(now = Date.now()): AttentionList {
  const database = getLocalDb()
  const settings = getSettings().priceMonitoring
  const sources = readAttentionSources(database, settings, now)
  const stores = enabledDiscoveryStores(settings)
  const solveAvailable = visibleBrowserWindowAvailable()
  const searchable = new Map<string, boolean>()
  const contextFor = (source: AttentionSource): AttentionFixContext => {
    if (!searchable.has(source.knifeId))
      searchable.set(
        source.knifeId,
        otherStoresSearchable(database, source.knifeId, stores, now),
      )
    return {
      solveAvailable,
      otherStoresActive: stores.length > 0,
      otherStoresSearchable: searchable.get(source.knifeId) ?? false,
    }
  }
  const order = { attention: 0, snoozed: 1, quiet: 2 } as const
  const items = sources
    .map((source) =>
      toAttentionItem(
        source,
        // Only pages that need the user get a suggestion.
        source.verdict.class === 'attention' ? contextFor(source) : undefined,
      ),
    )
    .sort(
      (a, b) =>
        order[a.verdict.class] - order[b.verdict.class] ||
        (b.since ?? '').localeCompare(a.since ?? ''),
    )
  const count = (kind: keyof typeof order) =>
    items.filter((item) => item.verdict.class === kind).length
  return {
    items,
    counts: {
      attention: count('attention'),
      quiet: count('quiet'),
      snoozed: count('snoozed'),
    },
  }
}

/**
 * Later, Price is right, Same knife, Wrong page, Pause and Remove for store pages in
 * Needs attention, one or many at once. Pages not in a state the action
 * fits are skipped. The knife's own product link cannot be removed, so
 * Remove and Wrong page pause it instead. The Inbox message is refreshed
 * quietly afterwards and closes once nothing is left.
 */
export async function applyAttentionAction(
  request: AttentionActionRequest,
  now = Date.now(),
): Promise<AttentionActionResult> {
  const nowIso = new Date(now).toISOString()
  const result: AttentionActionResult = {
    applied: 0,
    skipped: 0,
    pausedInstead: 0,
  }
  const otherStores = enabledDiscoveryStores(getSettings().priceMonitoring)
  /** Stores whose cookies a retry after a bot check resets. */
  const resetLanes = new Set<string>()
  const retried: number[] = []
  const searchKnives = new Set<string>()
  await withVaultWrite(async () => {
    const database = getLocalDb()
    database.transaction(() => {
      const fits = (source: SourceRow) => {
        switch (request.action) {
          case 'snooze':
            return isAttentionStatus(source.status) && source.enabled === 1
          case 'unsnooze':
            return source.attention_snoozed_until !== null
          case 'accept':
          case 'same_product':
          case 'wrong_page':
            return source.status === 'needs_review'
          case 'pause':
            return source.enabled === 1
          case 'remove':
            return true
          case 'retry':
            return UNREAD_STATUSES.has(source.status) && source.enabled === 1
          case 'find_other_stores':
            return otherStores.length > 0 && source.enabled === 1
        }
      }
      for (const id of request.sourceIds) {
        const source = readSource(database, id)
        if (!source || source.removed_at || !fits(source)) {
          result.skipped += 1
          continue
        }
        result.applied += 1
        switch (request.action) {
          case 'snooze': {
            const until = new Date(
              now + (request.days ?? 1) * DAY_MS,
            ).toISOString()
            // Checked again when Later runs out; a problem still there then
            // is new for the next summary.
            database
              .prepare(
                `UPDATE price_sources
                 SET attention_snoozed_until = ?, attention_reported_at = NULL,
                     next_check_at = ?, updated_at = ?
                 WHERE id = ?`,
              )
              .run(until, until, nowIso, id)
            break
          }
          case 'unsnooze':
            database
              .prepare(
                `UPDATE price_sources
                 SET attention_snoozed_until = NULL, updated_at = ?
                 WHERE id = ?`,
              )
              .run(nowIso, id)
            break
          case 'accept':
          case 'same_product':
            database
              .prepare(
                `UPDATE price_sources
                 SET status = CASE WHEN last_availability = 'out_of_stock'
                                THEN 'out_of_stock' ELSE 'ok' END,
                     accepted_price_minor = last_price_minor,
                     accepted_currency = last_currency,
                     last_error_code = NULL, last_error = NULL,
                     review_detail = NULL,
                     product_confirmed_at = CASE WHEN ? THEN ?
                       ELSE product_confirmed_at END,
                     attention_since = NULL, attention_snoozed_until = NULL,
                     attention_reported_at = NULL, updated_at = ?
                 WHERE id = ?`,
              )
              .run(
                request.action === 'same_product' ? 1 : 0,
                nowIso,
                nowIso,
                id,
              )
            break
          case 'pause':
            setSourcePaused(database, id, true, 'manual', nowIso)
            break
          case 'wrong_page':
          case 'remove':
            if (source.origin === 'auto') {
              setSourcePaused(database, id, true, 'manual', nowIso)
              result.pausedInstead += 1
            } else softRemove(database, [id], nowIso)
            break
          case 'retry':
            // Check now (priority 2), and take it off Later if it was put off.
            database
              .prepare(
                `UPDATE price_sources
                 SET priority = 2, attention_snoozed_until = NULL,
                     updated_at = ?
                 WHERE id = ?`,
              )
              .run(nowIso, id)
            if (source.status === 'blocked') resetLanes.add(source.lane_key)
            retried.push(id)
            break
          case 'find_other_stores': {
            // Due now at every turned-on store that has not found it.
            const due = database.prepare(
              `UPDATE price_discovery SET next_attempt_at = ?
               WHERE knife_id = ? AND store = ? AND status <> 'found'`,
            )
            for (const store of otherStores)
              due.run(nowIso, source.knife_id, store)
            searchKnives.add(source.knife_id)
            break
          }
        }
      }
    })()
    // A bot check that keeps coming back may stick to old cookies.
    for (const lane of resetLanes)
      await clearBrowserState(lane).catch((error: unknown) =>
        reportServerError(error, 'price-monitor/attention'),
      )
  })
  if (retried.length) getPriceMonitorWorker().start({ scheduled: false })
  if (searchKnives.size) getPriceMonitorWorker().resetDiscoveryPause()
  await syncPriceAttention().catch((error: unknown) => {
    if (error instanceof Error && error.name === 'VaultAccessError') throw error
    reportServerError(error, 'price-monitor/attention')
  })
  return result
}
