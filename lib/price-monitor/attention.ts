import type Database from 'better-sqlite3'
import { getLocalDb } from '@/lib/local-db'
import type { PriceSourceStatus } from '@/lib/price-monitor/shared'
import {
  reportSystemMessage,
  resolveSystemMessages,
} from '@/lib/system-message-store'

/**
 * The Inbox message for store pages that need attention: checks that failed,
 * were blocked by a bot check, or found no price. One message lists them all.
 * It is reported (unread, on top) when a source newly runs into a problem,
 * and resolved once every monitored source reads fine again; a source that
 * stays in trouble does not notify again.
 */
export const ATTENTION_STATUSES: ReadonlySet<PriceSourceStatus> = new Set([
  'failed',
  'blocked',
  'price_unavailable',
])
const LISTED = 3

export type AttentionRow = {
  brand: string
  name: string
  storeName: string
  status: PriceSourceStatus
}

export function readAttentionRows(database: Database.Database): AttentionRow[] {
  return database
    .prepare(
      `SELECT k.brand AS brand, k.name AS name, s.store_name AS storeName,
              s.status AS status
       FROM price_sources s JOIN knives k ON k.id = s.knife_id
       WHERE s.removed_at IS NULL AND s.enabled = 1
         AND s.status IN ('failed', 'blocked', 'price_unavailable')
       ORDER BY s.last_checked_at DESC, s.id DESC`,
    )
    .all() as AttentionRow[]
}

const PROBLEM: Record<string, string> = {
  blocked: 'bot check',
  failed: 'check failed',
  price_unavailable: 'no price found',
}

/** Title and detail for the Inbox message. Pure. */
export function attentionMessage(rows: readonly AttentionRow[]): {
  title: string
  detail: string
} {
  const blocked = rows.filter((row) => row.status === 'blocked').length
  const title =
    rows.length === 1
      ? 'A price check needs attention'
      : `${rows.length} price checks need attention`
  const listed = rows
    .slice(0, LISTED)
    .map(
      (row) =>
        `${[row.brand, row.name].filter(Boolean).join(' ')} at ${row.storeName} (${PROBLEM[row.status] ?? row.status})`,
    )
  const more = rows.length > LISTED ? ` and ${rows.length - LISTED} more` : ''
  const hint = blocked
    ? ' Open Price Drops and select a Blocked mark to solve the bot check in a browser.'
    : ''
  return { title, detail: `${listed.join('; ')}${more}.${hint}` }
}

/**
 * Updates the Inbox after a check of one source. `previousStatus` is the
 * source's status before the check, `status` after it.
 */
export async function syncPriceAttention(input: {
  previousStatus: PriceSourceStatus
  status: PriceSourceStatus | null
}): Promise<void> {
  const rows = readAttentionRows(getLocalDb())
  if (!rows.length) {
    await resolveSystemMessages('price-attention')
    return
  }
  const newlyInTrouble =
    input.status !== null &&
    ATTENTION_STATUSES.has(input.status) &&
    !ATTENTION_STATUSES.has(input.previousStatus)
  if (newlyInTrouble)
    await reportSystemMessage({
      kind: 'price-attention',
      ...attentionMessage(rows),
    })
}
