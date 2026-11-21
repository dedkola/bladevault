import os from 'node:os'

/**
 * Sleep and local network awareness for price monitoring.
 *
 * A Mac that sleeps freezes the server mid-request: an AI call or a store
 * check started before sleep ends after wake with a timeout or a dead
 * socket, which is not the endpoint's or the store's fault. The desktop app
 * reports suspend and resume (POST /api/prices/power); without it (locked
 * app, web server, Docker) a wall-clock jump the monotonic clock did not
 * see tells the same story.
 *
 * Several stores failing with network errors together, or the AI host
 * failing DNS, means this computer is offline: those checks are deferred
 * instead of counted against the stores.
 *
 * State lives on globalThis so Next dev module reloads share it.
 */

/** Checks and AI runs wait this long after wake for Wi-Fi and DNS. */
export const RESUME_WARMUP_MS = 90_000
/** A suspend without a resume notice holds work at most this long. */
const SUSPEND_HOLD_MAX_MS = 10 * 60_000
/** Wall time beyond monotonic time that counts as a sleep. */
export const CLOCK_JUMP_MS = 30_000
const WATCH_EVERY_MS = 15_000
/** Network failures this close together come from one cause. */
export const OUTAGE_WINDOW_MS = 2 * 60_000
/** Checks and AI runs pause this long once an outage is seen. */
export const OUTAGE_HOLD_MS = 2 * 60_000
/** A failing check waits this long for others failing at the same time. */
export const OUTAGE_SETTLE_MS = 1_500

export class PowerSuspendError extends Error {
  constructor() {
    super('The computer went to sleep.')
    this.name = 'PowerSuspendError'
  }
}

type PowerState = {
  controller: AbortController
  /** Bumped on every suspend (notice or clock jump). */
  epoch: number
  suspendedAt: number | null
  warmupUntil: number
  outageUntil: number
  /** Lane key → time of its latest network failure. */
  networkFailures: Map<string, number>
  aiDnsFailureAt: number | null
  watch: ReturnType<typeof setInterval> | null
  lastWall: number
  lastMono: number
  settleMs: number
  /** Overridable for tests. */
  hasNetworkInterface: () => boolean
}

const STATE = Symbol.for('bladevault.price-monitor.power')

function hasExternalInterface(): boolean {
  try {
    return Object.values(os.networkInterfaces()).some((entries) =>
      (entries ?? []).some((entry) => !entry.internal),
    )
  } catch {
    // Unknown: never treat that as offline.
    return true
  }
}

function freshState(): PowerState {
  return {
    controller: new AbortController(),
    epoch: 0,
    suspendedAt: null,
    warmupUntil: 0,
    outageUntil: 0,
    networkFailures: new Map(),
    aiDnsFailureAt: null,
    watch: null,
    lastWall: Date.now(),
    lastMono: performance.now(),
    settleMs: OUTAGE_SETTLE_MS,
    hasNetworkInterface: hasExternalInterface,
  }
}

function state(): PowerState {
  const scope = globalThis as typeof globalThis & { [STATE]?: PowerState }
  return (scope[STATE] ??= freshState())
}

/** Tests: forget everything (and stop the watchdog). */
export function resetPowerState(
  options: { settleMs?: number; hasNetworkInterface?: () => boolean } = {},
): void {
  const current = state()
  if (current.watch) clearInterval(current.watch)
  const next = freshState()
  if (options.settleMs !== undefined) next.settleMs = options.settleMs
  if (options.hasNetworkInterface)
    next.hasNetworkInterface = options.hasNetworkInterface
  ;(globalThis as typeof globalThis & { [STATE]?: PowerState })[STATE] = next
}

/** A clock reading for sleptSince: wall and monotonic time. */
export type ClockMark = { wall: number; mono: number; epoch: number }

export function clockMark(): ClockMark {
  return { wall: Date.now(), mono: performance.now(), epoch: state().epoch }
}

/**
 * The computer slept since the mark: a suspend was reported, or the wall
 * clock moved more than CLOCK_JUMP_MS beyond the monotonic clock (which
 * stops during sleep on macOS and Linux).
 */
export function sleptSince(
  mark: ClockMark,
  now: { wall: number; mono: number } = {
    wall: Date.now(),
    mono: performance.now(),
  },
): boolean {
  if (state().epoch !== mark.epoch) return true
  return now.wall - mark.wall - (now.mono - mark.mono) > CLOCK_JUMP_MS
}

/** Aborted when the computer goes to sleep; a new one after each suspend. */
export function powerSignal(): AbortSignal {
  ensurePowerWatch()
  return state().controller.signal
}

/**
 * The computer is going to sleep: AI calls in flight stop now (they would
 * only time out after wake), and work holds until resume.
 */
export function notePowerSuspend(now = Date.now()): void {
  const current = state()
  current.suspendedAt = now
  current.epoch++
  const previous = current.controller
  current.controller = new AbortController()
  previous.abort(new PowerSuspendError())
}

/** The computer woke: work restarts after a short warmup. */
export function notePowerResume(now = Date.now()): void {
  const current = state()
  current.suspendedAt = null
  current.warmupUntil = Math.max(current.warmupUntil, now + RESUME_WARMUP_MS)
  // Failures from before sleep say nothing about the network now.
  current.networkFailures.clear()
  current.aiDnsFailureAt = null
  current.outageUntil = 0
  current.lastWall = Date.now()
  current.lastMono = performance.now()
}

/**
 * One watchdog tick: a wall-clock jump beyond the monotonic clock is a
 * sleep nobody reported (no desktop notice, or a DarkWake in between).
 * Returns whether a jump was seen. Exported for tests.
 */
export function checkClockJump(
  now: { wall: number; mono: number } = {
    wall: Date.now(),
    mono: performance.now(),
  },
): boolean {
  const current = state()
  const jumped =
    now.wall - current.lastWall - (now.mono - current.lastMono) > CLOCK_JUMP_MS
  current.lastWall = now.wall
  current.lastMono = now.mono
  if (!jumped) return false
  notePowerSuspend(now.wall)
  notePowerResume(now.wall)
  return true
}

/** Starts the clock-jump watchdog once per process (never keeps it alive). */
export function ensurePowerWatch(): void {
  const current = state()
  if (current.watch) return
  current.lastWall = Date.now()
  current.lastMono = performance.now()
  current.watch = setInterval(() => checkClockJump(), WATCH_EVERY_MS)
  current.watch.unref?.()
}

/**
 * How long scheduled work (checks, AI runs) should still wait: while the
 * computer sleeps, during the warmup after wake, and during a local outage.
 */
export function monitorHoldMs(now = Date.now()): number {
  const current = state()
  if (current.suspendedAt !== null) {
    if (now - current.suspendedAt < SUSPEND_HOLD_MAX_MS) return RESUME_WARMUP_MS
    // No resume notice came: assume awake, with the usual warmup.
    notePowerResume(now)
  }
  return Math.max(0, current.warmupUntil - now, current.outageUntil - now)
}

const DNS_FAILURE = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i

/** The AI endpoint could not be reached; a DNS failure hints at an outage. */
export function noteAiNetworkFailure(reason: string, now = Date.now()): void {
  if (DNS_FAILURE.test(reason)) state().aiDnsFailureAt = now
}

/**
 * A store answered a check that started at `since`: the network worked
 * then, so failures seen before it say nothing. Later ones (such as the AI
 * host failing DNS during that check) still count.
 */
export function noteNetworkSuccess(since = Date.now()): void {
  const current = state()
  for (const [key, at] of current.networkFailures)
    if (at < since) current.networkFailures.delete(key)
  if (current.aiDnsFailureAt !== null && current.aiDnsFailureAt < since)
    current.aiDnsFailureAt = null
  if (!current.networkFailures.size && current.aiDnsFailureAt === null)
    current.outageUntil = 0
}

/** Remembers a store's network failure for outage detection. */
export function noteNetworkFailure(laneKey: string, now = Date.now()): void {
  state().networkFailures.set(laneKey, now)
}

/**
 * Whether this lane's network failure is the computer's (offline) rather
 * than the store's: no network interface, another store failing the same
 * way within OUTAGE_WINDOW_MS, the AI host failing DNS, or an outage
 * already seen. Starts an outage hold when it says yes.
 */
export function isLocalOutage(laneKey: string, now = Date.now()): boolean {
  const current = state()
  const recent = (at: number | null) =>
    at !== null && Math.abs(now - at) <= OUTAGE_WINDOW_MS
  const otherLane = [...current.networkFailures].some(
    ([key, at]) => key !== laneKey && recent(at),
  )
  const offline =
    current.outageUntil > now ||
    otherLane ||
    recent(current.aiDnsFailureAt) ||
    !current.hasNetworkInterface()
  if (offline)
    current.outageUntil = Math.max(current.outageUntil, now + OUTAGE_HOLD_MS)
  return offline
}

/**
 * A store check failed with a network error: waits briefly for checks at
 * other stores failing at the same moment, then says whether the computer
 * is offline (see isLocalOutage).
 */
export async function settleNetworkFailure(
  laneKey: string,
  signal?: AbortSignal,
): Promise<boolean> {
  noteNetworkFailure(laneKey)
  const waitMs = state().settleMs
  if (waitMs > 0 && !signal?.aborted)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, waitMs)
      function done() {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      signal?.addEventListener('abort', done, { once: true })
    })
  return isLocalOutage(laneKey)
}
