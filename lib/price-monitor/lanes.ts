import type { PriceMonitoringSettings } from '@/lib/settings-shared'

/**
 * Per-store pacing (a "lane" per store): one check at a time, an adaptive
 * minimum gap (AIMD), Retry-After, and a circuit breaker for bot checks.
 * Pure functions; the worker persists the state in price_host_state.
 */
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS

/** AIMD never slows a store beyond one check per 6 hours. */
export const MAX_MIN_GAP_MS = 6 * HOUR_MS
export const COOLDOWNS_MS = [
  30 * MINUTE_MS,
  2 * HOUR_MS,
  8 * HOUR_MS,
  24 * HOUR_MS,
] as const
/** Slow-check limit until a store has enough checks for its own. */
export const SLOW_CHECK_MS = 15_000
/** A store's own limit: this many times its usual check time... */
export const SLOW_FACTOR = 2
/** ...and never below this. */
export const MIN_SLOW_CHECK_MS = 5_000
/** Checks a store needs before its own slow-check limit applies. */
export const DURATION_SAMPLES = 5
/** Weight of the newest check in the store's usual check time. */
const DURATION_WEIGHT = 0.2
/**
 * Pages that load without a price, in a row, at links that had one: the
 * store may be serving a bot wall instead of its pages.
 */
export const SOFT_BLOCK_AFTER = 3
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
  /** Suspect pages in a row (see SOFT_BLOCK_AFTER). */
  softFailStreak?: number
  /** The store's usual check time (ms), once it has a few checks. */
  typicalMs?: number | null
  /** Checks counted in typicalMs, at most DURATION_SAMPLES. */
  durationSamples?: number
  /** The store's robots.txt Crawl-delay; its gap never goes below it. */
  robotsDelayMs?: number | null
  /** Why the circuit opened, when it was pages without prices. */
  openReason?: 'soft_block' | null
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
  /**
   * A success where the page loaded without a price at a link that had one:
   * possibly a bot wall the page detection did not recognise.
   */
  suspect?: boolean
  /**
   * The check read a price. Only that ends a soft-block streak or a
   * soft-block pause: a search, or a page that already had no price, says
   * nothing about whether the bot wall is gone.
   */
  priced?: boolean
}

export function laneFloorMs(pacing: PriceMonitoringSettings['pacing']): number {
  return pacing.minGapSeconds * 1000
}

/**
 * A store's own floor: the Minimum gap setting, or its robots.txt
 * Crawl-delay when that is longer (at most MAX_MIN_GAP_MS).
 */
export function storeFloorMs(
  lane: Pick<LaneState, 'robotsDelayMs'>,
  floorMs: number,
): number {
  return Math.max(floorMs, Math.min(lane.robotsDelayMs ?? 0, MAX_MIN_GAP_MS))
}

/**
 * True when a check took long for this store: over SLOW_FACTOR times its
 * usual check time (at least MIN_SLOW_CHECK_MS) once it has
 * DURATION_SAMPLES checks, over SLOW_CHECK_MS before that.
 */
export function isSlowCheck(lane: LaneState, durationMs: number): boolean {
  const typical = lane.typicalMs ?? null
  if (typical === null || (lane.durationSamples ?? 0) < DURATION_SAMPLES)
    return durationMs > SLOW_CHECK_MS
  return durationMs > Math.max(MIN_SLOW_CHECK_MS, SLOW_FACTOR * typical)
}

/** The store's usual check time after one more check. */
function nextTypical(
  lane: LaneState,
  durationMs: number,
): Pick<LaneState, 'typicalMs' | 'durationSamples'> {
  // Other stores searches report 0: their time is AI work, not the store.
  if (durationMs <= 0)
    return {
      typicalMs: lane.typicalMs ?? null,
      durationSamples: lane.durationSamples ?? 0,
    }
  const typical = lane.typicalMs ?? null
  return {
    typicalMs: Math.round(
      typical === null
        ? durationMs
        : typical + DURATION_WEIGHT * (durationMs - typical),
    ),
    durationSamples: Math.min(
      DURATION_SAMPLES,
      (lane.durationSamples ?? 0) + 1,
    ),
  }
}

export function defaultLaneState(
  laneKey: string,
  pacing: PriceMonitoringSettings['pacing'],
  now: number,
): LaneState {
  return {
    laneKey,
    minGapMs: laneFloorMs(pacing),
    readyAt: now,
    circuit: 'closed',
    cooldownUntil: null,
    openCount: 0,
    successStreak: 0,
    failureStreak: 0,
    lastRequestAt: null,
    softFailStreak: 0,
    typicalMs: null,
    durationSamples: 0,
    robotsDelayMs: null,
    openReason: null,
  }
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

/** Other stores: at most one search per store in this time. */
export const DISCOVERY_MIN_GAP_MS = 5 * MINUTE_MS

/**
 * Gap between a store's last search and its next Other stores search.
 * `storeGapMs` is a store's own slower pace (small Shopify stores).
 */
export function discoveryGapMs(
  lane: LaneState,
  floorMs: number,
  storeGapMs = 0,
): number {
  return Math.max(lane.minGapMs, floorMs, DISCOVERY_MIN_GAP_MS, storeGapMs)
}

/**
 * When an Other stores search may start at a store: once the store is ready
 * for its next request (its minimum gap), and the search gap since its last
 * search is over. Price checks never wait for the search gap, so a search
 * in one knife's step does not hold the next knife's checks at that store.
 * A store that failed, slowed us down (Retry-After), is in a cooldown or
 * advised pause waits as before.
 */
export function discoveryAvailability(
  lane: LaneState,
  now: number,
  options: {
    floorMs: number
    pauseUntil?: number | null
    /** The store's own minimum gap between searches. */
    storeGapMs?: number
    /** When the store was last searched (epoch ms), or null. */
    lastSearchAt: number | null
  },
): LaneAvailability {
  if (lane.circuit === 'open' || lane.failureStreak > 0)
    return laneAvailability(lane, now)
  const until = Math.max(
    lane.readyAt,
    options.lastSearchAt === null
      ? 0
      : options.lastSearchAt +
          discoveryGapMs(lane, options.floorMs, options.storeGapMs),
    options.pauseUntil ?? 0,
  )
  return until > now ? { state: 'waiting', until } : { state: 'ready' }
}

/** Earliest a manual check may start: the store's minimum gap only. */
export function manualReadyAt(lane: LaneState): number {
  return lane.lastRequestAt === null ? 0 : lane.lastRequestAt + lane.minGapMs
}

/**
 * When a never-checked source may get its first reading: the store's minimum
 * gap since its last request, not the spread of its scheduled checks. A
 * listing found by Other stores or added between two checks would otherwise
 * wait for the store's next scheduled slot, often an hour or more. A store
 * that failed, slowed us down (Retry-After), is cooling down or has an
 * advised pause waits as before.
 */
export function firstReadingAvailability(
  lane: LaneState,
  now: number,
  pauseUntil: number | null = null,
): LaneAvailability {
  if (lane.circuit === 'open' || lane.failureStreak > 0)
    return laneAvailability(lane, now)
  const until = Math.min(
    lane.readyAt,
    Math.max(manualReadyAt(lane), pauseUntil ?? 0),
  )
  return until > now ? { state: 'waiting', until } : { state: 'ready' }
}

function openCircuit(
  lane: LaneState,
  now: number,
  retryAfterMs: number | null,
  reason: LaneState['openReason'] = null,
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
    softFailStreak: 0,
    openReason: reason,
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
  const { now } = context
  const floorMs = storeFloorMs(lane, context.floorMs)
  const jitter = (ms: number) =>
    ms * (1 + 0.2 * (context.random ?? Math.random)())
  const base = { ...lane, lastRequestAt: now }
  const wasProbe = lane.circuit === 'open'

  switch (outcome.kind) {
    case 'success': {
      const timed = { ...base, ...nextTypical(lane, outcome.durationMs) }
      let minGapMs = Math.max(lane.minGapMs, floorMs)
      if (outcome.suspect) {
        // Pages without prices never speed the store up; enough of them
        // in a row pause it like a bot check.
        const softFailStreak = (lane.softFailStreak ?? 0) + 1
        if (wasProbe || softFailStreak >= SOFT_BLOCK_AFTER) {
          const opened = openCircuit(
            { ...timed, minGapMs },
            now,
            outcome.retryAfterMs,
            'soft_block',
          )
          return {
            lane: opened,
            clearCookies: opened.openCount >= CLEAR_COOKIES_AFTER_OPENINGS,
          }
        }
        return {
          lane: {
            ...timed,
            minGapMs,
            softFailStreak,
            successStreak: 0,
            failureStreak: 0,
            readyAt: now + jitter(Math.max(context.gapMs, minGapMs)),
          },
          clearCookies: false,
        }
      }
      if (wasProbe && lane.openReason === 'soft_block' && !outcome.priced)
        // The probe did not show a price either way: keep the store paused
        // for the first cooldown step without counting another opening.
        return {
          lane: {
            ...timed,
            readyAt: now + COOLDOWNS_MS[0],
            cooldownUntil: now + COOLDOWNS_MS[0],
          },
          clearCookies: false,
        }
      let successStreak = lane.successStreak + 1
      if (isSlowCheck(lane, outcome.durationMs)) {
        minGapMs = Math.min(minGapMs * 1.25, MAX_MIN_GAP_MS)
        successStreak = 0
      } else if (successStreak >= SPEED_UP_AFTER_SUCCESSES) {
        minGapMs = Math.max(floorMs, minGapMs * 0.9)
        successStreak = 0
      }
      return {
        lane: {
          ...timed,
          minGapMs,
          successStreak,
          failureStreak: 0,
          softFailStreak: outcome.priced ? 0 : (lane.softFailStreak ?? 0),
          circuit: 'closed',
          cooldownUntil: wasProbe ? null : lane.cooldownUntil,
          openReason: wasProbe ? null : (lane.openReason ?? null),
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
