import {
  ATTENTION_STATUS_LIST,
  type PriceSourceStatus,
} from '@/lib/price-monitor/shared'

/**
 * Which store-page problems are worth the user's time. Pure, client-safe:
 * the Inbox summary, Price Drops and MCP all classify with it.
 *
 * - attention: shown in Needs attention and the daily Inbox summary.
 * - quiet: a real status, but nothing to do yet or nothing it changes. It is
 *   marked grey on the store's row and never raises the knife or the Inbox.
 * - snoozed: the user put it off (Later); it comes back when that ends.
 */
export type AttentionClass = 'attention' | 'quiet' | 'snoozed'

/** Why a problem is quiet, for the grey mark's tooltip. */
export type AttentionQuietReason =
  /** A first failure or a fresh no-price page: often gone on the next check. */
  | 'new'
  /** AI doubts a price another store or the regular price agrees with. */
  | 'price_agrees'
  /** Other stores of the knife read fine; this one changes nothing. */
  | 'other_stores'

export type AttentionVerdict =
  | { class: 'attention' }
  | { class: 'quiet'; reason: AttentionQuietReason }
  | { class: 'snoozed'; until: string }

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** A failure counts once it repeated this many times in a row … */
export const ATTENTION_MIN_FAILURES = 3
/** … or the problem has lasted this long. */
export const ATTENTION_PERSIST_MS = DAY_MS
/** A doubted price within this share of another price agrees with it. */
export const ATTENTION_AGREE_TOLERANCE = 0.01
/** A problem nobody fixed for this long pauses the store page. */
export const ATTENTION_AUTO_PAUSE_MS = 7 * DAY_MS
/** Later in Needs attention: put a problem off by this many days. */
export const ATTENTION_SNOOZE_DAYS = [1, 7] as const
export type AttentionSnoozeDays = (typeof ATTENTION_SNOOZE_DAYS)[number]

export function isAttentionStatus(status: PriceSourceStatus): boolean {
  return (ATTENTION_STATUS_LIST as readonly string[]).includes(status)
}

export type AttentionSourceInput = {
  status: PriceSourceStatus
  consecutiveFailures: number
  /** When the current problem started; null counts as just now. */
  attentionSince: string | null
  snoozedUntil: string | null
  priceMinor: number | null
  currency: string | null
}

/** Another enabled store of the same knife that read fine. */
export type HealthySibling = {
  priceMinor: number
  currency: string
  inStock: boolean
}

function agrees(a: number, b: number): boolean {
  return (
    Math.abs(a - b) <= Math.max(1, Math.round(b * ATTENTION_AGREE_TOLERANCE))
  )
}

/**
 * Classifies one store page in an attention status; null for any other
 * status. `siblings` are the knife's other enabled stores whose last check
 * read fine (ok or out of stock) with a price; `paid` is the knife's regular
 * price in minor units, when stored.
 */
export function classifyAttention(
  source: AttentionSourceInput,
  context: {
    siblings: readonly HealthySibling[]
    paid: { minor: number; currency: string } | null
    now: number
  },
): AttentionVerdict | null {
  if (!isAttentionStatus(source.status)) return null
  const { siblings, paid, now } = context

  if (source.snoozedUntil && Date.parse(source.snoozedUntil) > now)
    return { class: 'snoozed', until: source.snoozedUntil }

  if (source.status === 'needs_review') {
    const { priceMinor, currency } = source
    if (priceMinor !== null && currency) {
      const same = (other: { minor: number; currency: string }) =>
        other.currency === currency && agrees(priceMinor, other.minor)
      if (
        siblings.some((sibling) =>
          same({ minor: sibling.priceMinor, currency: sibling.currency }),
        ) ||
        (paid !== null && same(paid))
      )
        return { class: 'quiet', reason: 'price_agrees' }
    }
    // A doubted price only matters when it is the knife's best offer.
    const cheaper = siblings.some(
      (sibling) =>
        sibling.inStock &&
        sibling.currency === currency &&
        priceMinor !== null &&
        sibling.priceMinor <= priceMinor,
    )
    if (cheaper) return { class: 'quiet', reason: 'other_stores' }
    return { class: 'attention' }
  }

  const since = source.attentionSince ? Date.parse(source.attentionSince) : now
  const lasting =
    source.consecutiveFailures >= ATTENTION_MIN_FAILURES ||
    now - (Number.isFinite(since) ? since : now) >= ATTENTION_PERSIST_MS
  if (!lasting) return { class: 'quiet', reason: 'new' }
  if (siblings.length) return { class: 'quiet', reason: 'other_stores' }
  return { class: 'attention' }
}

/** One enabled own store page of a knife, as classifyAttentionRows reads it. */
export type AttentionInputRow = AttentionSourceInput & {
  id: number
  knifeId: string
}

/**
 * Classifies every attention-status row among `rows`. Pass all enabled own
 * store pages of the knives involved: the rest serve as healthy siblings.
 * `paidFor` gives the knife's regular price in a currency, in minor units.
 */
export function classifyAttentionRows(
  rows: readonly AttentionInputRow[],
  paidFor: (
    knifeId: string,
    currency: string | null,
  ) => { minor: number; currency: string } | null,
  now: number,
): Map<number, AttentionVerdict> {
  const healthy = new Map<string, Array<HealthySibling & { id: number }>>()
  for (const row of rows) {
    if (
      (row.status !== 'ok' && row.status !== 'out_of_stock') ||
      row.priceMinor === null ||
      !row.currency
    )
      continue
    const list = healthy.get(row.knifeId) ?? []
    list.push({
      id: row.id,
      priceMinor: row.priceMinor,
      currency: row.currency,
      inStock: row.status === 'ok',
    })
    healthy.set(row.knifeId, list)
  }
  const verdicts = new Map<number, AttentionVerdict>()
  for (const row of rows) {
    const verdict = classifyAttention(row, {
      siblings: (healthy.get(row.knifeId) ?? []).filter(
        (sibling) => sibling.id !== row.id,
      ),
      paid: paidFor(row.knifeId, row.currency),
      now,
    })
    if (verdict) verdicts.set(row.id, verdict)
  }
  return verdicts
}

/** What the Inbox and Price Drops list for one store page. */
export type AttentionItem = {
  sourceId: number
  knifeId: string
  /** Brand and name. */
  knife: string
  storeName: string
  url: string
  status: PriceSourceStatus
  verdict: AttentionVerdict
  /** When the problem started. */
  since: string | null
  priceMinor: number | null
  currency: string | null
  consecutiveFailures: number
  lastError: string | null
}

export type AttentionList = {
  items: AttentionItem[]
  counts: { attention: number; quiet: number; snoozed: number }
}

export const ATTENTION_ACTIONS = [
  'snooze',
  'unsnooze',
  'accept',
  'wrong_page',
  'pause',
  'remove',
] as const
export type AttentionAction = (typeof ATTENTION_ACTIONS)[number]

export type AttentionActionRequest = {
  action: AttentionAction
  sourceIds: number[]
  /** Snooze only. */
  days?: AttentionSnoozeDays
}

export type AttentionActionResult = {
  /** Store pages the action changed. */
  applied: number
  /** Not in a state the action applies to (e.g. Accept on a failed page). */
  skipped: number
  /** Remove or Wrong page on the knife's own product link pauses it. */
  pausedInstead: number
}

export const MAX_ATTENTION_ACTION_IDS = 500

/** Validates a POST body; throws an Error with a user-facing message. */
export function parseAttentionActionRequest(
  body: unknown,
): AttentionActionRequest {
  if (!body || typeof body !== 'object') throw new Error('Expected an object.')
  const { action, sourceIds, days } = body as Record<string, unknown>
  if (!(ATTENTION_ACTIONS as readonly unknown[]).includes(action))
    throw new Error(`action must be one of ${ATTENTION_ACTIONS.join(', ')}.`)
  if (
    !Array.isArray(sourceIds) ||
    sourceIds.length === 0 ||
    sourceIds.length > MAX_ATTENTION_ACTION_IDS ||
    !sourceIds.every((id) => Number.isSafeInteger(id) && id > 0)
  )
    throw new Error(
      `sourceIds must list 1 to ${MAX_ATTENTION_ACTION_IDS} store page ids.`,
    )
  if (action === 'snooze') {
    if (!(ATTENTION_SNOOZE_DAYS as readonly unknown[]).includes(days))
      throw new Error(`days must be ${ATTENTION_SNOOZE_DAYS.join(' or ')}.`)
    return {
      action,
      sourceIds: [...new Set(sourceIds as number[])],
      days: days as AttentionSnoozeDays,
    }
  }
  return {
    action: action as AttentionAction,
    sourceIds: [...new Set(sourceIds as number[])],
  }
}

/** The problem in a few words, as badges and the Inbox list show it. */
export const ATTENTION_PROBLEM_LABEL: Record<string, string> = {
  blocked: 'Bot check',
  failed: 'Check failed',
  price_unavailable: 'No price found',
  needs_review: 'AI doubts the price',
}

/** Short words for a quiet problem, for tooltips and MCP. */
export const QUIET_REASON_TEXT: Record<AttentionQuietReason, string> = {
  new: 'Just started; it often clears on the next check.',
  price_agrees: 'AI doubted it, but another store or the regular price agrees.',
  other_stores: 'Other stores of this knife read fine, so nothing is missing.',
}
