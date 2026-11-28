import type Database from 'better-sqlite3'
import { readActiveAdvice } from '@/lib/price-monitor/advice-store'
import {
  applyAdviceToLane,
  maxAdvisedGapMs,
  type ActiveLaneAdvice,
} from '@/lib/price-monitor/advisor'
import {
  defaultLaneState,
  laneFloorMs,
  type LaneState,
} from '@/lib/price-monitor/lanes'
import {
  adviceWindowMs,
  frequencyMs,
  scheduledIntervalMs,
} from '@/lib/price-monitor/schedule'
import {
  readLaneStates,
  readQueueCandidates,
  type CandidateRow,
} from '@/lib/price-monitor/store'
import {
  isDue,
  projectChecks,
  slowStores,
  type StoreCapacity,
  type StoreLink,
} from '@/lib/price-monitor/store-queue'
import type { PriceMonitoringSettings } from '@/lib/settings-shared'

const DAY_MS = 24 * 60 * 60 * 1000

/** The rest of the collection is checked at most once a day. */
export const COLLECTION_INTERVAL_MS = DAY_MS

/** A link in its store's queue, with the interval its next check uses. */
export type QueueLink = StoreLink & {
  /** The interval before focus and slow out-of-stock (the engine adds those). */
  baseIntervalMs: number
}

export function normalizeLane(
  lane: LaneState,
  pacing: PriceMonitoringSettings['pacing'],
): LaneState {
  return {
    ...lane,
    minGapMs: Math.max(lane.minGapMs, laneFloorMs(pacing)),
  }
}

/**
 * A store's pacing with the floor and any AI advice in force. The advised
 * gap is capped so the store's `sourceCount` checks still fit in one
 * interval (maxAdvisedGapMs).
 */
export function effectiveLane(
  lane: LaneState,
  pacing: PriceMonitoringSettings['pacing'],
  advice: ActiveLaneAdvice | undefined,
  now: number,
  cap: { activeWindowMs: number; sourceCount: number },
): LaneState {
  return applyAdviceToLane(
    normalizeLane(lane, pacing),
    advice,
    now,
    maxAdvisedGapMs({ ...cap, floorMs: laneFloorMs(pacing) }),
  )
}

/** Scheduled links per store. */
export function scheduledCounts(candidates: readonly CandidateRow[]) {
  const counts = new Map<string, number>()
  for (const candidate of candidates)
    if (candidate.scheduled)
      counts.set(candidate.laneKey, (counts.get(candidate.laneKey) ?? 0) + 1)
  return counts
}

/** A candidate as its store's queue sees it. */
export function toStoreLink(
  candidate: CandidateRow,
  context: {
    intervalMs: number
    now: number
    settings: PriceMonitoringSettings
  },
): QueueLink {
  const baseIntervalMs =
    candidate.tier === 'collection'
      ? Math.max(context.intervalMs, COLLECTION_INTERVAL_MS)
      : context.intervalMs
  return {
    sourceId: candidate.sourceId,
    knifeId: candidate.knifeId,
    laneKey: candidate.laneKey,
    priority: candidate.priority,
    nextCheckAt: candidate.nextCheckAt,
    lastCheckedAt: candidate.lastCheckedAt,
    intervalMs: scheduledIntervalMs({
      intervalMs: baseIntervalMs,
      outOfStockSince: candidate.outOfStockSince,
      now: context.now,
      slowOutOfStock: context.settings.schedule.slowOutOfStock,
      focusIntervalMs: candidate.focusIntervalMs,
    }),
    tier: candidate.tier,
    focus: candidate.focusIntervalMs !== null,
    baseIntervalMs,
  }
}

/** The links scheduled monitoring checks (Check now runs on its own). */
export function scheduledLinks(
  candidates: readonly CandidateRow[],
  context: {
    intervalMs: number
    now: number
    settings: PriceMonitoringSettings
  },
): QueueLink[] {
  return candidates
    .filter((candidate) => candidate.scheduled && candidate.priority < 2)
    .map((candidate) => toStoreLink(candidate, context))
}

export type StorePlan = {
  links: QueueLink[]
  /** Due links: when each is expected to run, and how many come first. */
  projected: Map<number, { at: number; ahead: number }>
  /** Scheduled links due now. */
  backlog: number
  /** Stores that cannot check every link within the interval. */
  slow: StoreCapacity[]
}

/**
 * What the store queues will do, read from the vault: every due link's
 * expected check time at its store's pace, and the stores too slow for the
 * interval. For Price Drops and the supervisor; the worker decides alone.
 */
export function readStorePlan(
  database: Database.Database,
  settings: PriceMonitoringSettings,
  now: number,
): StorePlan {
  const intervalMs = frequencyMs(settings.schedule)
  const candidates = readQueueCandidates(database, settings, now)
  const links = scheduledLinks(candidates, { intervalMs, now, settings })
  const counts = scheduledCounts(candidates)
  const stored = readLaneStates(database)
  const advice = readActiveAdvice(database, now)
  const stores = new Map<string, { readyAt: number; gapMs: number }>()
  for (const [laneKey, sourceCount] of counts) {
    const lane = effectiveLane(
      stored.get(laneKey) ?? defaultLaneState(laneKey, settings.pacing, now),
      settings.pacing,
      advice.get(laneKey),
      now,
      { activeWindowMs: adviceWindowMs(settings.schedule), sourceCount },
    )
    stores.set(laneKey, {
      readyAt: Math.max(lane.readyAt, lane.cooldownUntil ?? 0),
      gapMs: Math.max(lane.minGapMs, laneFloorMs(settings.pacing)),
    })
  }
  // Checks each store owes per interval: a link checked less often (the
  // rest of the collection, long out of stock) counts for less.
  const load = new Map<string, number>()
  for (const link of links)
    load.set(
      link.laneKey,
      (load.get(link.laneKey) ?? 0) + intervalMs / Math.max(1, link.intervalMs),
    )
  return {
    links,
    projected: projectChecks({ links, now, stores }),
    backlog: links.filter((link) => isDue(link, now)).length,
    slow: slowStores(
      [...stores].map(([laneKey, store]) => ({
        laneKey,
        links: Math.round(load.get(laneKey) ?? 0),
        gapMs: store.gapMs,
      })),
      intervalMs,
    ),
  }
}
