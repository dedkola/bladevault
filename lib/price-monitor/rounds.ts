import type { DiscoveryStatus } from '@/lib/price-monitor/discovery-store'
import type { LaneAvailability } from '@/lib/price-monitor/lanes'
import type { CheckOutcomeKind } from '@/lib/price-monitor/store'
import type { OtherStoreId } from '@/lib/settings-shared'

/**
 * Price checks in rounds, pure logic. A round goes through every monitored
 * knife in order: one knife's stores are all checked (and searched) at the
 * same time, then a pause, then the next knife. What fails, or finds its
 * store not ready, goes on the retry list, which runs at random times
 * between the end of the round and the next one. The worker runs the steps;
 * round-store.ts keeps the state.
 */
const MINUTE_MS = 60 * 1000

/** Retries are spread up to this long before the next round starts. */
export const RETRY_END_MARGIN_MS = 10 * MINUTE_MS
/**
 * A store that will be ready within this time is waited for inside a
 * knife's step; one that needs longer is skipped and goes on the retry list.
 */
export const LANE_WAIT_MS = 2 * MINUTE_MS
/** About how long one knife's step takes, before the pause (planned times). */
export const STEP_ESTIMATE_MS = MINUTE_MS

export type RoundTiming = {
  startedAt: number
  finishedAt: number | null
}

/**
 * When the next round starts: one interval after the last one started, or
 * when it finished if it ran longer (rounds never overlap). Null while a
 * round is running; now when no round ran yet.
 */
export function nextRoundAt(
  last: RoundTiming | null,
  intervalMs: number,
  now: number,
): number | null {
  if (!last) return now
  if (last.finishedAt === null) return null
  return Math.max(last.startedAt + intervalMs, last.finishedAt)
}

/**
 * Random times for the retry list, spread between the end of the round and
 * shortly before the next one, earliest first. A round that ran up to the
 * next one retries right away.
 */
export function retryDueTimes(input: {
  count: number
  roundEnd: number
  nextRoundAt: number
  random: () => number
}): number[] {
  const span = input.nextRoundAt - RETRY_END_MARGIN_MS - input.roundEnd
  return Array.from({ length: input.count }, () =>
    span > 0
      ? Math.round(input.roundEnd + input.random() * span)
      : input.roundEnd,
  ).sort((a, b) => a - b)
}

/** Planned start of each knife's step, for "next check" times in the UI. */
export function plannedStepTimes(input: {
  count: number
  startAt: number
  pauseMs: number
}): number[] {
  const stepMs = STEP_ESTIMATE_MS + input.pauseMs
  return Array.from(
    { length: input.count },
    (_, index) => input.startAt + index * stepMs,
  )
}

export type StepTask =
  | {
      kind: 'check'
      sourceId: number
      laneKey: string
      /**
       * A listing the step's own search just found: its first price waits
       * only the store's minimum gap since that search.
       */
      followUp?: boolean
    }
  | { kind: 'search'; store: OtherStoreId; laneKey: string }

export type StepSource = {
  sourceId: number
  laneKey: string
  /** Covered by scheduled monitoring and its store not paused. */
  scheduled: boolean
  /** Checked since the round started (Check now, Check first, a new link). */
  checkedThisRound: boolean
  /**
   * A page out of stock for two weeks, checked in the last 24 hours: it is
   * checked at most once a day.
   */
  restingOutOfStock: boolean
}

/**
 * One knife's step: a check for each scheduled source not checked since the
 * round started, and a search at each due store where the knife has no
 * listing yet. Stores with a listing are never searched.
 */
export function planStep(input: {
  sources: readonly StepSource[]
  searches: ReadonlyArray<{ store: OtherStoreId; laneKey: string }>
}): StepTask[] {
  const tasks: StepTask[] = []
  const listed = new Set(input.sources.map((source) => source.laneKey))
  for (const source of input.sources)
    if (
      source.scheduled &&
      !source.checkedThisRound &&
      !source.restingOutOfStock
    )
      tasks.push({
        kind: 'check',
        sourceId: source.sourceId,
        laneKey: source.laneKey,
      })
  for (const search of input.searches)
    if (!listed.has(search.laneKey))
      tasks.push({
        kind: 'search',
        store: search.store,
        laneKey: search.laneKey,
      })
  return tasks
}

/** A step's tasks per store, in order; stores run in parallel. */
export function tasksByLane(
  tasks: readonly StepTask[],
): Map<string, StepTask[]> {
  const lanes = new Map<string, StepTask[]>()
  for (const task of tasks)
    lanes.set(task.laneKey, [...(lanes.get(task.laneKey) ?? []), task])
  return lanes
}

/**
 * Whether a step starts a task at a store now, waits for it a little, or
 * skips it onto the retry list: a store in its gap, Retry-After or bot-check
 * cooldown for longer than `waitMs` is not ready. A store whose cooldown is
 * over gets the task as its probe.
 */
export function laneDecision(
  availability: LaneAvailability,
  now: number,
  waitMs: number = LANE_WAIT_MS,
): { action: 'run' } | { action: 'wait'; until: number } | { action: 'skip' } {
  if (availability.state === 'ready' || availability.state === 'probe')
    return { action: 'run' }
  return availability.until - now <= waitMs
    ? { action: 'wait', until: availability.until }
    : { action: 'skip' }
}

/** Check outcomes that put the source on the retry list. */
export function retryableCheck(outcome: CheckOutcomeKind): boolean {
  return outcome === 'failed' || outcome === 'blocked' || outcome === 'no_price'
}

/** Search results that put the store on the retry list. */
export function retryableSearch(result: DiscoveryStatus): boolean {
  return result === 'failed' || result === 'blocked'
}

export const RETRY_REASONS = [
  'failed',
  'blocked',
  'no_price',
  'store_not_ready',
  'supervisor',
] as const
export type RetryReason = (typeof RETRY_REASONS)[number]

export function retryKey(
  task:
    | { kind: 'check'; sourceId: number }
    | { kind: 'search'; knifeId: string; store: string },
): string {
  return task.kind === 'check'
    ? `check:${task.sourceId}`
    : `search:${task.knifeId}:${task.store}`
}
