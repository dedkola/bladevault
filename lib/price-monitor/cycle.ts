import type { MonitorTier } from '@/lib/price-monitor/shared'

/**
 * The check cycle, pure logic. A cycle lasts the check interval (6, 12 or
 * 24 hours). Every store works on its own and at the same time as the
 * others, one request at a time with its own gap (60 seconds by default),
 * and takes its next task in this order:
 *
 * 1. links moved forward (watched closely, Check first, the supervisor's
 *    Retry with AI), at most every other task so they never stall the rest;
 * 2. What to monitor (the Wishlist) not checked in this cycle, in its order;
 * 3. links never checked;
 * 4. checks the store asked to wait for (rate limits, time-outs, bot
 *    checks), again 10–15 minutes later, at most one per store that often;
 * 5. the rest of the collection, oldest check first, spread evenly over the
 *    cycle minus its last tenth (Check all does not spread it).
 *
 * Pages that answered without a usable price are problems: AI looks at them
 * one at a time once every link of the cycle was checked, one try per link
 * and cycle. Other stores searches run at each store between its checks, at
 * most every 5 minutes there. What does not fit in a cycle goes first in the
 * next one, since it is then the oldest. The worker runs the tasks;
 * round-store.ts keeps the state.
 */
const MINUTE_MS = 60 * 1000

/** The cycle's last share left for AI on problem pages. */
export const AI_RESERVE_SHARE = 0.1
/** A check the store asked to wait for runs again this long after. */
export const DEFER_MIN_MS = 10 * MINUTE_MS
export const DEFER_MAX_MS = 15 * MINUTE_MS
/** Tries in one cycle before a deferred check becomes a problem for AI. */
export const DEFER_MAX_TRIES = 3
/** Checks and searches running at once (each browser is its own process). */
export const MAX_PARALLEL_TASKS = 7
/** AI's time on one problem page. */
export const FIX_BUDGET_MS = 3 * MINUTE_MS

/** A scheduled store link of one store, as the cycle sees it. */
export type CycleLink = {
  sourceId: number
  knifeId: string
  laneKey: string
  /** scope: What to monitor (the Wishlist); collection: the rest. */
  tier: MonitorTier
  /** The knife's place in the cycle's order (Wishlist order first). */
  order: number
  lastCheckedAt: number | null
  /** Watched closely and due, or moved forward (a new link, Check first). */
  priority: boolean
  /** Out of stock for weeks and checked within its slower pace. */
  resting: boolean
}

/** A link on the retry list. */
export type CycleRetry = {
  sourceId: number
  laneKey: string
  /** When a deferred check runs again; null: a problem waiting for AI. */
  dueAt: number | null
  /** The supervisor's Retry with AI: runs with AI as soon as it is due. */
  supervisor: boolean
}

export type CheckGroup = 'priority' | 'wishlist' | 'new' | 'deferred' | 'rest'

export type LaneCheck = {
  sourceId: number
  group: CheckGroup
  /** Runs with AI (the supervisor's Retry with AI). */
  fix: boolean
}

/** Checked since the cycle started (a failed check counts too). */
export function linkDone(link: CycleLink, cycleStart: number): boolean {
  return link.lastCheckedAt !== null && link.lastCheckedAt >= cycleStart
}

/** Still to check in this cycle. */
export function linkPending(link: CycleLink, cycleStart: number): boolean {
  return !link.resting && !linkDone(link, cycleStart)
}

const byOrder = (a: CycleLink, b: CycleLink) =>
  a.order - b.order || a.sourceId - b.sourceId
const byOldest = (a: CycleLink, b: CycleLink) =>
  (a.lastCheckedAt ?? -Infinity) - (b.lastCheckedAt ?? -Infinity) ||
  a.sourceId - b.sourceId

/**
 * A store's next check, or null with when to look again. `links` and
 * `retries` are this store's only.
 */
export function pickLaneCheck(input: {
  now: number
  cycleStart: number
  links: readonly CycleLink[]
  retries: readonly CycleRetry[]
  /** The store's last task was moved forward: an ordinary one goes next. */
  lastWasPriority: boolean
  /** When the next rest-of-collection link may start (the even spread). */
  restReadyAt: number
  /** When the next deferred check may start at this store. */
  deferredReadyAt: number
}): { pick: LaneCheck | null; wakeAt: number | null } {
  const { now, cycleStart } = input
  const pending = input.links.filter((link) => linkPending(link, cycleStart))
  const wishlist = pending.filter((link) => link.tier === 'scope').sort(byOrder)
  const collection = pending.filter((link) => link.tier !== 'scope')
  const fresh = collection
    .filter((link) => link.lastCheckedAt === null)
    .sort(byOrder)
  const rest = collection
    .filter((link) => link.lastCheckedAt !== null)
    .sort(byOldest)
  const due = (retry: CycleRetry) => retry.dueAt !== null && retry.dueAt <= now
  const deferred = input.retries
    .filter((retry) => !retry.supervisor && due(retry))
    .sort((a, b) => a.dueAt! - b.dueAt! || a.sourceId - b.sourceId)

  const priority: LaneCheck[] = [
    ...input.retries
      .filter((retry) => retry.supervisor && due(retry))
      .map((retry) => ({
        sourceId: retry.sourceId,
        group: 'priority' as const,
        fix: true,
      })),
    ...input.links
      .filter((link) => link.priority)
      .sort(byOrder)
      .map((link) => ({
        sourceId: link.sourceId,
        group: 'priority' as const,
        fix: false,
      })),
  ]
  const check = (link: CycleLink | undefined, group: CheckGroup) =>
    link ? { sourceId: link.sourceId, group, fix: false } : null
  const ordinary: LaneCheck | null =
    check(wishlist[0], 'wishlist') ??
    check(fresh[0], 'new') ??
    (deferred[0] && now >= input.deferredReadyAt
      ? { sourceId: deferred[0].sourceId, group: 'deferred', fix: false }
      : null) ??
    (now >= input.restReadyAt ? check(rest[0], 'rest') : null)

  if (priority.length && (!input.lastWasPriority || !ordinary))
    return { pick: priority[0], wakeAt: null }
  if (ordinary) return { pick: ordinary, wakeAt: null }

  const waits: number[] = []
  if (rest.length) waits.push(input.restReadyAt)
  if (deferred.length) waits.push(input.deferredReadyAt)
  for (const retry of input.retries)
    if (retry.dueAt !== null && retry.dueAt > now)
      waits.push(
        retry.supervisor
          ? retry.dueAt
          : Math.max(retry.dueAt, input.deferredReadyAt),
      )
  return { pick: null, wakeAt: waits.length ? Math.min(...waits) : null }
}

/**
 * The gap before a store's next rest-of-collection link: what is left of
 * the cycle before its AI share, divided by the links still to check, and
 * never shorter than the store's own gap. Past that point (a cycle that
 * runs late) the rest goes at the store's gap.
 */
export function restPaceMs(input: {
  now: number
  cycleStart: number
  cycleMs: number
  remaining: number
  floorMs: number
}): number {
  const end = input.cycleStart + input.cycleMs * (1 - AI_RESERVE_SHARE)
  if (input.remaining <= 0 || end <= input.now) return input.floorMs
  return Math.max(input.floorMs, (end - input.now) / input.remaining)
}

/**
 * The knife to search for next at an Other store: knives in What to
 * monitor first, in the cycle's order, then the store's own queue order
 * (never searched first, then the longest waiting).
 */
export function pickLaneSearch(
  due: readonly string[],
  order: ReadonlyMap<string, number>,
): string | null {
  let best: string | null = null
  let bestOrder = Infinity
  for (const knifeId of due) {
    const position = order.get(knifeId)
    if (position !== undefined && position < bestOrder) {
      best = knifeId
      bestOrder = position
    }
  }
  return best ?? due[0] ?? null
}

/** Error codes of a store that could not answer now: try again later. */
const TRANSIENT_CODES = new Set([
  'network',
  'timeout',
  'cancelled',
  'browser',
  'challenge',
])

export type CheckVerdict =
  /** The page was read: off the retry list. */
  | 'ok'
  /** The store asked to wait or could not answer: try again later. */
  | 'defer'
  /** The page answered without a usable price: AI looks at it later. */
  | 'problem'
  /** Nothing happened (asleep, offline, read-only): checked again later. */
  | 'none'

/** What a finished check means for the retry list; null when it threw. */
export function classifyCheck(
  summary:
    | { status: 'skipped' | 'deferred' }
    | {
        status: 'done'
        outcome: 'ok' | 'no_price' | 'failed' | 'blocked'
        laneOutcome: string
        errorCode: string | null
      }
    | null,
): CheckVerdict {
  if (!summary) return 'defer'
  if (summary.status !== 'done') return 'none'
  if (summary.outcome === 'ok') return 'ok'
  if (
    summary.outcome === 'blocked' ||
    summary.laneOutcome === 'throttled' ||
    summary.laneOutcome === 'blocked' ||
    (summary.errorCode !== null && TRANSIENT_CODES.has(summary.errorCode))
  )
    return 'defer'
  return 'problem'
}

/** When a deferred check runs again: 10 to 15 minutes from now. */
export function deferredDueAt(now: number, random: () => number): number {
  return Math.round(
    now + DEFER_MIN_MS + random() * (DEFER_MAX_MS - DEFER_MIN_MS),
  )
}

/** When the next cycle starts: one interval after this one started. */
export function cycleEndsAt(cycle: { startedAt: number; intervalMs: number }) {
  return cycle.startedAt + cycle.intervalMs
}

/**
 * Planned check times for the UI's "next check": per store, What to monitor
 * and never-checked links one store gap apart from the start, then the rest
 * spread evenly until the cycle's AI share. Links moved forward keep theirs;
 * the caller leaves out links of knives watched closely.
 */
export function plannedCheckTimes(input: {
  links: readonly CycleLink[]
  /** Plans start here (a restart plans what is left of the cycle). */
  now: number
  cycleStart: number
  cycleMs: number
  floorMs: number
  /** Check all: the rest goes at the store's gap too. */
  spread: boolean
}): Map<number, number> {
  const planned = new Map<number, number>()
  const byLane = new Map<string, CycleLink[]>()
  for (const link of input.links) {
    if (link.priority || !linkPending(link, input.cycleStart)) continue
    const list = byLane.get(link.laneKey)
    if (list) list.push(link)
    else byLane.set(link.laneKey, [link])
  }
  for (const links of byLane.values()) {
    const first = [
      ...links.filter((link) => link.tier === 'scope').sort(byOrder),
      ...links
        .filter((link) => link.tier !== 'scope' && link.lastCheckedAt === null)
        .sort(byOrder),
    ]
    const rest = links
      .filter((link) => link.tier !== 'scope' && link.lastCheckedAt !== null)
      .sort(byOldest)
    let at = Math.max(input.now, input.cycleStart)
    for (const link of first) {
      planned.set(link.sourceId, at)
      at += input.floorMs
    }
    const pace = input.spread
      ? restPaceMs({
          now: at,
          cycleStart: input.cycleStart,
          cycleMs: input.cycleMs,
          remaining: rest.length,
          floorMs: input.floorMs,
        })
      : input.floorMs
    for (const link of rest) {
      planned.set(link.sourceId, at)
      at += pace
    }
  }
  return planned
}
