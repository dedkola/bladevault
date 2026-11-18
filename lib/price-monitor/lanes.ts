import type { PriceMonitoringSettings } from '@/lib/settings-shared'

/**
 * Per-store pacing (a "lane" per store): one check at a time, an adaptive
 * minimum gap (AIMD), Retry-After, and a circuit breaker for bot checks.
 * Pure functions; the worker persists the state in price_host_state.
 */
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS

/** Spread gaps never exceed this, so a small store is not left idle all day. */
export const MAX_SPREAD_GAP_MS = 2 * HOUR_MS
/** AIMD never slows a store beyond one check per 6 hours. */
export const MAX_MIN_GAP_MS = 6 * HOUR_MS
export const COOLDOWNS_MS = [
  30 * MINUTE_MS,
  2 * HOUR_MS,
  8 * HOUR_MS,
  24 * HOUR_MS,
] as const
export const SLOW_CHECK_MS = 15_000
export const SPEED_UP_AFTER_SUCCESSES = 5
export const OPEN_AFTER_FAILURES = 3
/** Cookies are dropped after this many circuit openings in a row. */
export const CLEAR_COOKIES_AFTER_OPENINGS = 3
/** Openings older than this no longer escalate the cooldown. */
const OPEN_COUNT_RESET_MS = 24 * HOUR_MS

export type Circuit = 'closed' | 'open'

export type LaneState = {
  laneKey: string
  minGapMs: number
  /** Earliest start of the next check (epoch ms). */
  readyAt: number
  circuit: Circuit
  cooldownUntil: number | null
  openCount: number
  successStreak: number
  failureStreak: number
  lastRequestAt: number | null
}

/**
 * success: the store answered (with or without a price).
 * throttled: 429/503. blocked: bot check or 403.
 * failed: network, timeout or 5xx. neutral: not the store's doing
 * (invalid URL, browser missing, implausible reading, cancelled).
 */
export type LaneOutcome = {
  kind: 'success' | 'throttled' | 'blocked' | 'failed' | 'neutral'
  durationMs: number
  retryAfterMs: number | null
}

export function laneFloorMs(
  laneKey: string,
  pacing: PriceMonitoringSettings['pacing'],
): number {
  return (
    (laneKey === 'amazon' ? pacing.amazonMinGapSeconds : pacing.minGapSeconds) *
    1000
  )
}

export function defaultLaneState(
  laneKey: string,
  pacing: PriceMonitoringSettings['pacing'],
  now: number,
): LaneState {
  return {
    laneKey,
    minGapMs: laneFloorMs(laneKey, pacing),
    readyAt: now,
    circuit: 'closed',
    cooldownUntil: null,
    openCount: 0,
    successStreak: 0,
    failureStreak: 0,
    lastRequestAt: null,
  }
}

/**
 * Gap between two checks at one store: its sources spread evenly over the
 * active window (80 %, leaving room for retries), never below the adaptive
 * minimum gap, never above two hours unless AIMD slowed the store further.
 */
export function laneGapMs(input: {
  minGapMs: number
  floorMs: number
  activeWindowMs: number
  sourceCount: number
}): number {
  const minimum = Math.max(input.minGapMs, input.floorMs)
  const spread =
    input.sourceCount > 0
      ? (input.activeWindowMs * 0.8) / input.sourceCount
      : minimum
  return Math.min(
    Math.max(spread, minimum),
    Math.max(MAX_SPREAD_GAP_MS, minimum),
  )
}

/** How long one full pass over a store's sources takes at its pace. */
export function fullPassMs(gapMs: number, sourceCount: number): number {
  return gapMs * sourceCount
}

export type LaneAvailability =
  | { state: 'ready' }
  | { state: 'waiting'; until: number }
  | { state: 'cooling'; until: number }
  | { state: 'probe' }

export function laneAvailability(
  lane: LaneState,
  now: number,
): LaneAvailability {
  if (lane.circuit === 'open') {
    const until = Math.max(lane.cooldownUntil ?? 0, lane.readyAt)
    return until > now ? { state: 'cooling', until } : { state: 'probe' }
  }
  return lane.readyAt > now
    ? { state: 'waiting', until: lane.readyAt }
    : { state: 'ready' }
}

/** Earliest a manual check may start: the store's minimum gap only. */
export function manualReadyAt(lane: LaneState): number {
  return lane.lastRequestAt === null ? 0 : lane.lastRequestAt + lane.minGapMs
}

function openCircuit(
  lane: LaneState,
  now: number,
  retryAfterMs: number | null,
): LaneState {
  const stale =
    lane.cooldownUntil !== null &&
    now - lane.cooldownUntil > OPEN_COUNT_RESET_MS
  const openCount = (stale ? 0 : lane.openCount) + 1
  const cooldown =
    COOLDOWNS_MS[Math.min(openCount, COOLDOWNS_MS.length) - 1] ??
    COOLDOWNS_MS[0]
  const until = now + Math.max(cooldown, retryAfterMs ?? 0)
  return {
    ...lane,
    circuit: 'open',
    cooldownUntil: until,
    readyAt: until,
    openCount,
    successStreak: 0,
    failureStreak: 0,
  }
}

export type LaneUpdate = {
  lane: LaneState
  /** Stale cookies may be what keeps the store blocking us. */
  clearCookies: boolean
}

/**
 * Next lane state after a check. `gapMs` is the store's current gap (spread
 * or minimum); `random` adds 0–20 % jitter so requests do not look timed.
 */
export function applyLaneOutcome(
  lane: LaneState,
  outcome: LaneOutcome,
  context: {
    now: number
    gapMs: number
    floorMs: number
    random?: () => number
  },
): LaneUpdate {
  const { now, floorMs } = context
  const jitter = (ms: number) =>
    ms * (1 + 0.2 * (context.random ?? Math.random)())
  const base = { ...lane, lastRequestAt: now }
  const wasProbe = lane.circuit === 'open'

  switch (outcome.kind) {
    case 'success': {
      let minGapMs = Math.max(lane.minGapMs, floorMs)
      let successStreak = lane.successStreak + 1
      if (outcome.durationMs > SLOW_CHECK_MS) {
        minGapMs = Math.min(minGapMs * 1.25, MAX_MIN_GAP_MS)
        successStreak = 0
      } else if (successStreak >= SPEED_UP_AFTER_SUCCESSES) {
        minGapMs = Math.max(floorMs, minGapMs * 0.9)
        successStreak = 0
      }
      return {
        lane: {
          ...base,
          minGapMs,
          successStreak,
          failureStreak: 0,
          circuit: 'closed',
          cooldownUntil: wasProbe ? null : lane.cooldownUntil,
          readyAt: now + jitter(Math.max(context.gapMs, minGapMs)),
        },
        clearCookies: false,
      }
    }
    case 'throttled': {
      const minGapMs = Math.min(
        Math.max(lane.minGapMs, floorMs) * 2,
        MAX_MIN_GAP_MS,
      )
      const failureStreak = lane.failureStreak + 1
      if (wasProbe || failureStreak >= OPEN_AFTER_FAILURES) {
        const opened = openCircuit(
          { ...base, minGapMs },
          now,
          outcome.retryAfterMs,
        )
        return {
          lane: opened,
          clearCookies: opened.openCount >= CLEAR_COOKIES_AFTER_OPENINGS,
        }
      }
      return {
        lane: {
          ...base,
          minGapMs,
          successStreak: 0,
          failureStreak,
          readyAt:
            now +
            Math.max(
              outcome.retryAfterMs ?? 0,
              jitter(Math.max(context.gapMs, minGapMs)),
            ),
        },
        clearCookies: false,
      }
    }
    case 'blocked': {
      const opened = openCircuit(base, now, outcome.retryAfterMs)
      return {
        lane: opened,
        clearCookies: opened.openCount >= CLEAR_COOKIES_AFTER_OPENINGS,
      }
    }
    case 'failed': {
      const failureStreak = lane.failureStreak + 1
      if (wasProbe || failureStreak >= OPEN_AFTER_FAILURES) {
        const opened = openCircuit(base, now, outcome.retryAfterMs)
        return {
          lane: opened,
          clearCookies: opened.openCount >= CLEAR_COOKIES_AFTER_OPENINGS,
        }
      }
      return {
        lane: {
          ...base,
          successStreak: 0,
          failureStreak,
          readyAt: now + jitter(Math.max(context.gapMs, lane.minGapMs)),
        },
        clearCookies: false,
      }
    }
    case 'neutral':
      return {
        lane: {
          ...base,
          // A probe that never reached the store keeps the circuit open.
          readyAt: wasProbe
            ? now + COOLDOWNS_MS[0]
            : now + jitter(Math.max(lane.minGapMs, floorMs)),
          cooldownUntil: wasProbe ? now + COOLDOWNS_MS[0] : lane.cooldownUntil,
        },
        clearCookies: false,
      }
  }
}
