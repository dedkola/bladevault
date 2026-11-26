import type Database from 'better-sqlite3'
import { startOfLocalDay } from '@/lib/price-monitor/ai-journal'
import {
  ATTENTION_AUTO_PAUSE_MS,
  classifyAttentionRows,
  type AttentionVerdict,
} from '@/lib/price-monitor/attention-filter'
import type { EligibilitySettings } from '@/lib/price-monitor/eligibility'
import { toMinorUnits } from '@/lib/price-monitor/money'
import { readKnifePaid } from '@/lib/price-monitor/notification-store'
import {
  ATTENTION_STATUS_LIST,
  type PriceSourceOrigin,
  type PriceSourceStatus,
} from '@/lib/price-monitor/shared'
import { readQueueCandidates, setSourcePaused } from '@/lib/price-monitor/store'
import { getLocalDb } from '@/lib/local-db'
import { reportServerError } from '@/lib/sentry/server'
import { getSettings } from '@/lib/settings'
import {
  readSystemMessages,
  refreshSystemMessage,
  reportSystemMessage,
  resolveSystemMessages,
} from '@/lib/system-message-store'
import { assertVaultGeneration, withVaultWrite } from '@/lib/vault-access'

/**
 * Needs attention: store pages whose checks failed, hit a bot check, found
 * no price, or whose price AI doubts. `classifyAttention` keeps the noise
 * out (a first failure, a doubted price another store agrees with, a broken
 * store of a knife other stores still read). What is left is summed up in
 * the Inbox once a day: the message is raised (unread, on top) only in the
 * morning and only when a problem is new since the last summary. Between
 * summaries it is updated quietly and closes once nothing needs attention.
 * Sources scheduled monitoring does not cover (watch mode Off, a knife
 * without a regular price, a sold knife) are left out.
 */
export const ATTENTION_STATUSES: ReadonlySet<PriceSourceStatus> = new Set(
  ATTENTION_STATUS_LIST,
)
const LISTED = 3
/** No summary before this local hour. */
export const ATTENTION_SUMMARY_HOUR = 9
const SUMMARY_CHECK_EVERY_MS = 10 * 60 * 1000

export type AttentionRow = {
  brand: string
  name: string
  storeName: string
  status: PriceSourceStatus
}

/** A covered store page in an attention status, with its verdict. */
export type AttentionSource = AttentionRow & {
  sourceId: number
  knifeId: string
  url: string
  origin: PriceSourceOrigin
  consecutiveFailures: number
  attentionSince: string | null
  reportedAt: string | null
  lastCheckedAt: string | null
  lastError: string | null
  priceMinor: number | null
  currency: string | null
  verdict: AttentionVerdict
}

type ProblemRow = {
  id: number
  knife_id: string
  brand: string
  name: string
  store_name: string
  url: string
  origin: PriceSourceOrigin
  status: PriceSourceStatus
  consecutive_failures: number
  attention_since: string | null
  attention_snoozed_until: string | null
  attention_reported_at: string | null
  last_checked_at: string | null
  last_error: string | null
  last_price_minor: number | null
  last_currency: string | null
}

/**
 * Every covered store page in an attention status, classified. Quiet and
 * snoozed ones are included so Price Drops can mark them; callers that
 * only want what needs the user filter on `verdict.class`.
 */
export function readAttentionSources(
  database: Database.Database,
  settings: EligibilitySettings = getSettings().priceMonitoring,
  now = Date.now(),
): AttentionSource[] {
  const covered = new Set(
    readQueueCandidates(database, settings, now)
      .filter((candidate) => candidate.covered)
      .map((candidate) => candidate.sourceId),
  )
  const rows = (
    database
      .prepare(
        `SELECT s.id, s.knife_id, k.brand, k.name, s.store_name, s.url,
                s.origin, s.status, s.consecutive_failures,
                s.attention_since, s.attention_snoozed_until,
                s.attention_reported_at, s.last_checked_at, s.last_error,
                s.last_price_minor, s.last_currency
         FROM price_sources s JOIN knives k ON k.id = s.knife_id
         WHERE s.removed_at IS NULL AND s.enabled = 1
           AND s.variant_search IS NULL
           AND s.status IN ('failed', 'blocked', 'price_unavailable',
                            'needs_review')
         ORDER BY s.last_checked_at DESC, s.id DESC`,
      )
      .all() as ProblemRow[]
  ).filter((row) => covered.has(row.id))
  if (!rows.length) return []

  const knifeIds = [...new Set(rows.map((row) => row.knife_id))]
  const healthy = database
    .prepare(
      `SELECT id, knife_id, status, last_price_minor, last_currency
       FROM price_sources
       WHERE removed_at IS NULL AND enabled = 1 AND variant_search IS NULL
         AND status IN ('ok', 'out_of_stock')
         AND knife_id IN (${knifeIds.map(() => '?').join(', ')})`,
    )
    .all(...knifeIds) as Array<{
    id: number
    knife_id: string
    status: PriceSourceStatus
    last_price_minor: number | null
    last_currency: string | null
  }>
  const paid = new Map(
    knifeIds.map((id) => [id, readKnifePaid(database, id)] as const),
  )
  const verdicts = classifyAttentionRows(
    [
      ...rows.map((row) => ({
        id: row.id,
        knifeId: row.knife_id,
        status: row.status,
        consecutiveFailures: row.consecutive_failures,
        attentionSince: row.attention_since,
        snoozedUntil: row.attention_snoozed_until,
        priceMinor: row.last_price_minor,
        currency: row.last_currency,
      })),
      ...healthy.map((row) => ({
        id: row.id,
        knifeId: row.knife_id,
        status: row.status,
        consecutiveFailures: 0,
        attentionSince: null,
        snoozedUntil: null,
        priceMinor: row.last_price_minor,
        currency: row.last_currency,
      })),
    ],
    (knifeId, currency) => {
      const knifePaid = paid.get(knifeId)
      const inCurrency = knifePaid?.currency || currency
      return knifePaid && inCurrency
        ? {
            minor: toMinorUnits(knifePaid.amount, inCurrency),
            currency: inCurrency,
          }
        : null
    },
    now,
  )

  return rows.map((row) => {
    const verdict = verdicts.get(row.id) ?? { class: 'attention' as const }
    return {
      sourceId: row.id,
      knifeId: row.knife_id,
      brand: row.brand,
      name: row.name,
      storeName: row.store_name,
      url: row.url,
      origin: row.origin,
      status: row.status,
      consecutiveFailures: row.consecutive_failures,
      attentionSince: row.attention_since,
      reportedAt: row.attention_reported_at,
      lastCheckedAt: row.last_checked_at,
      lastError: row.last_error,
      priceMinor: row.last_price_minor,
      currency: row.last_currency,
      verdict,
    }
  })
}

/** Store pages that need the user now (no quiet or snoozed ones). */
export function readAttentionRows(
  database: Database.Database,
  settings: EligibilitySettings = getSettings().priceMonitoring,
  now = Date.now(),
): AttentionRow[] {
  return readAttentionSources(database, settings, now)
    .filter((row) => row.verdict.class === 'attention')
    .map(({ brand, name, storeName, status }) => ({
      brand,
      name,
      storeName,
      status,
    }))
}

const PROBLEM: Record<string, string> = {
  blocked: 'bot check',
  failed: 'check failed',
  price_unavailable: 'no price found',
  needs_review: 'AI doubts the price',
}

/** Title and detail for the Inbox message. Pure. */
export function attentionMessage(
  rows: readonly AttentionRow[],
  extra: { fresh?: number; autoPaused?: readonly AttentionRow[] } = {},
): {
  title: string
  detail: string
} {
  const blocked = rows.filter((row) => row.status === 'blocked').length
  const fresh = extra.fresh ? ` · ${extra.fresh} new` : ''
  const title = rows.length
    ? rows.length === 1
      ? `A store page needs a look${fresh}`
      : `${rows.length} store pages need a look${fresh}`
    : 'Paused store pages that stayed broken'
  const label = (row: AttentionRow) =>
    `${[row.brand, row.name].filter(Boolean).join(' ')} at ${row.storeName}`
  const listed = rows
    .slice(0, LISTED)
    .map((row) => `${label(row)} (${PROBLEM[row.status] ?? row.status})`)
  const more = rows.length > LISTED ? ` and ${rows.length - LISTED} more` : ''
  const hint = blocked
    ? ' Select a Blocked mark in Price Drops to solve the bot check in a browser.'
    : ''
  const paused = extra.autoPaused?.length
    ? ` Paused after ${ATTENTION_AUTO_PAUSE_MS / 86_400_000} days without a fix: ${extra.autoPaused.map(label).join('; ')}; resume them in each knife's edit mode.`
    : ''
  const list = listed.length ? `${listed.join('; ')}${more}.` : ''
  return { title, detail: `${list}${hint}${paused}`.trim() }
}

/**
 * Updates the Inbox after a check or an action: closes the message when
 * nothing needs attention, otherwise refreshes its text quietly (no unread,
 * no move to the top, a dismissed one stays dismissed). Raising it is the
 * daily summary's job.
 */
export async function syncPriceAttention(): Promise<void> {
  const rows = readAttentionRows(getLocalDb())
  if (!rows.length) {
    await resolveSystemMessages('price-attention')
    return
  }
  await refreshSystemMessage('price-attention', attentionMessage(rows))
}

/** Due once per local day from ATTENTION_SUMMARY_HOUR on. Pure. */
export function attentionSummaryDue(
  lastRaisedAt: string | null,
  now: number,
): boolean {
  if (new Date(now).getHours() < ATTENTION_SUMMARY_HOUR) return false
  if (!lastRaisedAt) return true
  const last = Date.parse(lastRaisedAt)
  return !Number.isFinite(last) || last < startOfLocalDay(now)
}

/** When the summary last raised the Inbox message. */
function readLastRaisedAt(database: Database.Database): string | null {
  return (
    readSystemMessages(database)
      .filter((message) => message.kind === 'price-attention')
      .map((message) => message.occurredAt)
      .sort()
      .at(-1) ?? null
  )
}

export type AttentionSummaryResult =
  | { status: 'skipped'; reason: 'not_due' | 'nothing_new' }
  | { status: 'raised'; attention: number; fresh: number; autoPaused: number }

/**
 * The daily summary: pauses store pages nobody fixed in a week, then raises
 * the Inbox message when something is new since the last summary (a new
 * problem, one whose Later ran out, or an automatic pause). Otherwise the
 * message keeps its read or dismissed state.
 */
export async function runAttentionSummary(input: {
  generation: string
  now?: number
}): Promise<AttentionSummaryResult> {
  const now = input.now ?? Date.now()
  const database = getLocalDb()
  const lastRaisedAt = readLastRaisedAt(database)
  if (!attentionSummaryDue(lastRaisedAt, now))
    return { status: 'skipped', reason: 'not_due' }

  const sources = readAttentionSources(
    database,
    getSettings().priceMonitoring,
    now,
  )
  const stale = sources.filter(
    (row) =>
      row.verdict.class === 'attention' &&
      row.attentionSince !== null &&
      now - Date.parse(row.attentionSince) >= ATTENTION_AUTO_PAUSE_MS,
  )
  const attention = sources.filter(
    (row) =>
      row.verdict.class === 'attention' &&
      !stale.some((paused) => paused.sourceId === row.sourceId),
  )
  // New: never raised in this run of trouble. Later and a fixed page clear
  // the mark, so a problem back after either counts as new again.
  const fresh = attention.filter((row) => row.reportedAt === null)
  if (!fresh.length && !stale.length)
    return { status: 'skipped', reason: 'nothing_new' }

  const nowIso = new Date(now).toISOString()
  await withVaultWrite(async () => {
    assertVaultGeneration(input.generation)
    database.transaction(() => {
      for (const row of stale)
        setSourcePaused(database, row.sourceId, true, 'auto_attention', nowIso)
      const mark = database.prepare(
        'UPDATE price_sources SET attention_reported_at = ? WHERE id = ?',
      )
      for (const row of attention) mark.run(nowIso, row.sourceId)
    })()
  })
  if (attention.length || stale.length)
    await reportSystemMessage(
      {
        kind: 'price-attention',
        ...attentionMessage(attention, {
          fresh: attention.length > fresh.length ? fresh.length : 0,
          autoPaused: stale,
        }),
      },
      new Date(now),
    )
  return {
    status: 'raised',
    attention: attention.length,
    fresh: fresh.length,
    autoPaused: stale.length,
  }
}

const summaryState = { lastCheck: 0, running: null as Promise<unknown> | null }

/**
 * The worker's hook: runs the summary in the background at most every 10
 * minutes. No AI: it works with AI off. Never blocks the caller.
 */
export function startAttentionSummaryIfDue(
  generation: string,
  now = Date.now(),
): Promise<AttentionSummaryResult> | null {
  if (
    summaryState.running ||
    now - summaryState.lastCheck < SUMMARY_CHECK_EVERY_MS
  )
    return null
  summaryState.lastCheck = now
  const running = runAttentionSummary({ generation, now })
    .catch((error: unknown) => {
      if (!(error instanceof Error && error.name === 'VaultAccessError'))
        reportServerError(error, 'price-monitor/attention-summary')
      return { status: 'skipped', reason: 'not_due' } as const
    })
    .finally(() => {
      summaryState.running = null
    })
  summaryState.running = running
  return running
}

/** Forgets the summary hook's pacing; for tests. */
export function resetAttentionSummaryState() {
  summaryState.lastCheck = 0
  summaryState.running = null
}
