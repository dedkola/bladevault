import {
  readAttentionSources,
  syncPriceAttention,
  type AttentionSource,
} from '@/lib/price-monitor/attention'
import {
  isAttentionStatus,
  type AttentionActionRequest,
  type AttentionActionResult,
  type AttentionItem,
  type AttentionList,
} from '@/lib/price-monitor/attention-filter'
import {
  readSource,
  setSourcePaused,
  softRemove,
  type SourceRow,
} from '@/lib/price-monitor/store'
import { getLocalDb } from '@/lib/local-db'
import { reportServerError } from '@/lib/sentry/server'
import { getSettings } from '@/lib/settings'
import { withVaultWrite } from '@/lib/vault-access'

const DAY_MS = 86_400_000

export function toAttentionItem(source: AttentionSource): AttentionItem {
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
  }
}

/** Needs attention first, then snoozed, then quiet; newest problem first. */
export function readAttentionList(now = Date.now()): AttentionList {
  const sources = readAttentionSources(
    getLocalDb(),
    getSettings().priceMonitoring,
    now,
  )
  const order = { attention: 0, snoozed: 1, quiet: 2 } as const
  const items = sources
    .map(toAttentionItem)
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
        }
      }
    })()
  })
  await syncPriceAttention().catch((error: unknown) => {
    if (error instanceof Error && error.name === 'VaultAccessError') throw error
    reportServerError(error, 'price-monitor/attention')
  })
  return result
}
