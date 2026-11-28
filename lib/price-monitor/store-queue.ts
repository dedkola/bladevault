/**
 * Scheduled price checks, store by store (pure logic). Every store works
 * through its own queue at its own pace, in parallel with the others: a slow
 * store never holds up a fast one. Inside a store the next link is, in
 * order: a link moved forward (a new link, the supervisor's Check first or
 * Cross-check), a link never checked, a knife watched closely (at most one
 * pick in three, so watched knives cannot starve the rest), What to monitor,
 * then the rest of the collection; inside each group the link that is most
 * overdue for its own interval goes first.
 *
 * Each link also has a fixed slot in its interval (its place among the
 * store's links), and its next check is aligned to that slot, so a store's
 * checks spread evenly over the day instead of coming in bursts.
 */
import type { MonitorTier } from '@/lib/price-monitor/shared'

/** A link the scheduler may check, as the queue sees it. */
export type StoreLink = {
  sourceId: number
  knifeId: string
  laneKey: string
  /** 1: moved forward (a new link, Check first, Cross-check). */
  priority: number
  /** Epoch ms; null when never scheduled (due now). */
  nextCheckAt: number | null
  lastCheckedAt: number | null
  /** The link's own interval: focus, tier and slow out-of-stock included. */
  intervalMs: number
  tier: MonitorTier
  /** The knife is watched closely by the AI supervisor. */
  focus: boolean
}

/** What a store did on its last picks, newest last (for the focus share). */
export type PickKind = 'focus' | 'other' | 'search'

/** Watched knives get at most one of this many picks while others wait. */
export const FOCUS_SHARE = 3

export function isDue(link: StoreLink, now: number): boolean {
  return link.nextCheckAt === null || link.nextCheckAt <= now
}

/** A link's group: lower goes first. */
export function linkGroup(link: StoreLink): number {
  if (link.priority >= 1) return 0
  if (link.lastCheckedAt === null) return 1
  if (link.focus) return 2
  return link.tier === 'scope' ? 3 : 4
}

/** How overdue a link is, in parts of its interval (never scheduled: most). */
function lateness(link: StoreLink, now: number): number {
  if (link.nextCheckAt === null) return Number.POSITIVE_INFINITY
  return (now - link.nextCheckAt) / Math.max(1, link.intervalMs)
}

/** Queue order inside one store: group, then most overdue, then oldest id. */
export function byQueueOrder(now: number) {
  return (a: StoreLink, b: StoreLink): number => {
    const group = linkGroup(a) - linkGroup(b)
    if (group) return group
    const lateA = lateness(a, now)
    const lateB = lateness(b, now)
    if (lateA !== lateB) return lateA > lateB ? -1 : 1
    return a.sourceId - b.sourceId
  }
}

/** True when a watched knife may take this pick at its store. */
export function focusAllowed(recent: readonly PickKind[]): boolean {
  return !recent
    .filter((kind) => kind !== 'search')
    .slice(-(FOCUS_SHARE - 1))
    .includes('focus')
}

/**
 * The store's next link to check now, or null when none is due. A watched
 * knife waits its turn when it already had its share of the recent picks
 * and other links are due.
 */
export function pickForStore<T extends StoreLink>(
  links: readonly T[],
  now: number,
  recent: readonly PickKind[] = [],
): T | null {
  const due = links.filter((link) => isDue(link, now))
  if (!due.length) return null
  due.sort(byQueueOrder(now))
  if (focusAllowed(recent)) return due[0]
  return due.find((link) => linkGroup(link) !== 2) ?? due[0]
}

/**
 * Each link's place in its store's interval (0 ≤ fraction < 1), by id so it
 * stays put from day to day: a store with N links gets one slot every
 * interval ÷ N.
 */
export function slotFractions(
  links: ReadonlyArray<Pick<StoreLink, 'sourceId' | 'laneKey'>>,
): Map<number, number> {
  const byLane = new Map<string, number[]>()
  for (const link of links)
    byLane.set(link.laneKey, [
      ...(byLane.get(link.laneKey) ?? []),
      link.sourceId,
    ])
  const fractions = new Map<number, number>()
  for (const ids of byLane.values()) {
    const sorted = [...new Set(ids)].sort((a, b) => a - b)
    sorted.forEach((id, index) => fractions.set(id, index / sorted.length))
  }
  return fractions
}

/**
 * The link's next check after one at `now`: about one interval later,
 * moved to the link's slot (at most half an interval either way), so the
 * store's checks spread over the interval.
 */
export function alignToSlot(input: {
  now: number
  intervalMs: number
  fraction: number
}): number {
  const { now, intervalMs, fraction } = input
  const target = now + intervalMs
  const phase = fraction * intervalMs
  const base =
    target - ((((target - phase) % intervalMs) + intervalMs) % intervalMs)
  // `base` is the latest slot at or before target; the nearer of it and the
  // next one wins.
  return target - base <= intervalMs / 2 ? base : base + intervalMs
}

export type StoreCapacity = {
  laneKey: string
  links: number
  gapMs: number
  /** How long the store needs to check every link once at its pace. */
  cycleMs: number
}

/**
 * Stores that cannot check all their links within the interval at their
 * current pace, slowest first. Their links are checked as often as the
 * store allows: about every `cycleMs`.
 */
export function slowStores(
  stores: ReadonlyArray<{ laneKey: string; links: number; gapMs: number }>,
  intervalMs: number,
): StoreCapacity[] {
  return stores
    .map((store) => ({ ...store, cycleMs: store.links * store.gapMs }))
    .filter((store) => store.links > 0 && store.cycleMs > intervalMs)
    .sort((a, b) => b.cycleMs - a.cycleMs)
}

/**
 * When each due link is expected to be checked: one store at a time, in
 * queue order, one per store gap from when the store is next ready. Links
 * not due keep their own time. For the timeline and the supervisor.
 */
export function projectChecks(input: {
  links: readonly StoreLink[]
  now: number
  /** When each store may start its next check, and its gap. */
  stores: ReadonlyMap<string, { readyAt: number; gapMs: number }>
}): Map<number, { at: number; ahead: number }> {
  const byLane = new Map<string, StoreLink[]>()
  for (const link of input.links)
    if (isDue(link, input.now))
      byLane.set(link.laneKey, [...(byLane.get(link.laneKey) ?? []), link])
  const plan = new Map<number, { at: number; ahead: number }>()
  for (const [laneKey, due] of byLane) {
    const store = input.stores.get(laneKey)
    const start = Math.max(input.now, store?.readyAt ?? input.now)
    const gapMs = store?.gapMs ?? 0
    due
      .sort(byQueueOrder(input.now))
      .forEach((link, index) =>
        plan.set(link.sourceId, { at: start + index * gapMs, ahead: index }),
      )
  }
  return plan
}

/**
 * Check all now: the knives still waiting for a check. Check all made each
 * of their links due at its start; a check (or a failed try) moves a link's
 * next check past it.
 */
export function checkAllPending(
  round: { knifeIds: readonly string[]; startedAt: number },
  links: ReadonlyArray<Pick<StoreLink, 'knifeId' | 'nextCheckAt'>>,
): Set<string> {
  const inRound = new Set(round.knifeIds)
  const pending = new Set<string>()
  for (const link of links)
    if (
      inRound.has(link.knifeId) &&
      (link.nextCheckAt === null || link.nextCheckAt <= round.startedAt)
    )
      pending.add(link.knifeId)
  return pending
}
