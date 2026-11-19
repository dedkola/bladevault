import { randomUUID } from 'node:crypto'
import { getLocalDb } from '@/lib/local-db'
import { readActiveAdvice } from '@/lib/price-monitor/advice-store'
import {
  advisorDue,
  applyAdviceToLane,
  inQuietHours,
  lastAdvisorRunAt,
  runPriceAdvisor,
  type ActiveLaneAdvice,
  type AdvisorRunResult,
  type AdvisorTrigger,
} from '@/lib/price-monitor/advisor'
import { aiConfigured } from '@/lib/price-monitor/ai'
import { clearBrowserState } from '@/lib/price-monitor/browser-state'
import {
  discoverKnife,
  DISCOVERY_LANE,
  discoveryActive,
  nextDiscoveryKnife,
  type DiscoverySummary,
} from '@/lib/price-monitor/discovery'
import { startPriceDigestIfDue } from '@/lib/price-monitor/digest'
import { checkPriceSource } from '@/lib/price-monitor/engine'
import {
  applyLaneOutcome,
  defaultLaneState,
  fullPassMs,
  laneAvailability,
  laneFloorMs,
  laneGapMs,
  type LaneState,
} from '@/lib/price-monitor/lanes'
import {
  nextWakeAt,
  pickNextChecks,
  type QueueInput,
  type QueuePick,
} from '@/lib/price-monitor/queue'
import {
  activeWindowMs,
  effectiveActiveHours,
  frequencyMs,
  isWithinActiveHours,
} from '@/lib/price-monitor/schedule'
import {
  acquireWorkerLease,
  pruneCheckLog,
  readLaneStates,
  readQueueCandidates,
  releaseWorkerLease,
  requestSourceChecks,
  resetStaleChecking,
  syncAllAutoSources,
  writeLaneState,
  type CandidateRow,
  type HostStrategy,
} from '@/lib/price-monitor/store'
import { reportServerError } from '@/lib/sentry/server'
import { getSettings } from '@/lib/settings'
import type {
  ActiveHours,
  PriceMonitoringSettings,
} from '@/lib/settings-shared'
import { getVaultAccessState } from '@/lib/vault-access'

/**
 * The paced monitoring queue. One worker per vault (a lease in SQLite), at
 * most one check per store at a time (different stores run in parallel), each
 * store's checks spread over the frequency window, with adaptive gaps and a
 * circuit breaker per store. It runs in the Next.js server process and does
 * not depend on any page being open.
 */
const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const MAX_SLEEP_MS = MINUTE_MS
const HEARTBEAT_MS = 30 * SECOND_MS
const SYNC_EVERY_MS = 10 * MINUTE_MS
const PRUNE_EVERY_MS = 24 * 60 * MINUTE_MS
/** How often the worker looks whether the AI advisor is due. */
const ADVISOR_CHECK_EVERY_MS = 10 * MINUTE_MS
/** Nothing to look for on other stores: ask again after this. */
const DISCOVERY_IDLE_MS = 10 * MINUTE_MS
/** The AI endpoint failed during a search: wait before the next one. */
const DISCOVERY_AI_PAUSE_MS = 30 * MINUTE_MS
export const DEFAULT_WARMUP_MS = 2 * MINUTE_MS

export type WorkerDeps = {
  now: () => number
  setTimer: (callback: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  check: typeof checkPriceSource
  random: () => number
  /** The AI pacing advisor; only runs when AI and the advisor are on. */
  advise?: (trigger: AdvisorTrigger) => Promise<AdvisorRunResult>
  /** Other stores: the next knife AI should look for, or null. */
  nextDiscovery?: (
    settings: PriceMonitoringSettings,
    now: number,
  ) => string | null
  /** Other stores: AI looks for one knife on Amazon. */
  discover?: (
    knifeId: string,
    options: { signal: AbortSignal },
  ) => Promise<DiscoverySummary>
}

const realDeps: WorkerDeps = {
  now: () => Date.now(),
  setTimer: (callback, ms) => {
    const handle = setTimeout(callback, ms)
    handle.unref?.()
    return handle
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  check: (...args) => checkPriceSource(...args),
  random: () => Math.random(),
  advise: (trigger) => runPriceAdvisor({ trigger }),
  nextDiscovery: (settings, now) => nextDiscoveryKnife(settings, now),
  discover: (knifeId, options) => discoverKnife(knifeId, options),
}

type InFlight = {
  sourceId: number
  laneKey: string
  trigger: QueuePick['trigger']
  startedAt: number
}

type PassContext = {
  settings: PriceMonitoringSettings
  generation: string
  intervalMs: number
  windowMs: number
  laneCounts: Map<string, number>
  /** Scheduled sources per store that were never checked. */
  firstReadings: Map<string, number>
  /** The never-checked sources themselves. */
  firstReadingIds: ReadonlySet<number>
}

function isVaultError(error: unknown): boolean {
  return error instanceof Error && error.name === 'VaultAccessError'
}

function normalizeLane(
  lane: LaneState,
  pacing: PriceMonitoringSettings['pacing'],
): LaneState {
  return {
    ...lane,
    minGapMs: Math.max(lane.minGapMs, laneFloorMs(lane.laneKey, pacing)),
  }
}

/** A store's pacing with the floor and any AI advice in force. */
function effectiveLane(
  lane: LaneState,
  pacing: PriceMonitoringSettings['pacing'],
  advice: ActiveLaneAdvice | undefined,
  now: number,
): LaneState {
  return applyAdviceToLane(normalizeLane(lane, pacing), advice, now)
}

function scheduledCounts(
  candidates: readonly CandidateRow[],
  include: (candidate: CandidateRow) => boolean = () => true,
) {
  const counts = new Map<string, number>()
  for (const candidate of candidates)
    if (candidate.scheduled && include(candidate))
      counts.set(candidate.laneKey, (counts.get(candidate.laneKey) ?? 0) + 1)
  return counts
}

/**
 * The gap after a check: the store's even spread, or only its minimum gap
 * while it still has sources that were never checked, so new sources get a
 * first price within minutes instead of over the whole window. Retry-After,
 * the circuit breaker and AI advice still apply on top (lanes, advisor).
 */
function gapAfterCheck(input: {
  lane: LaneState
  laneKey: string
  floorMs: number
  context: PassContext
  /** The check that just ran was itself a first reading. */
  firstReading: boolean
}): number {
  const { lane, laneKey, floorMs, context } = input
  const waiting =
    (context.firstReadings.get(laneKey) ?? 0) - (input.firstReading ? 1 : 0)
  if (waiting > 0) return Math.max(lane.minGapMs, floorMs)
  return laneGapMs({
    minGapMs: lane.minGapMs,
    floorMs,
    activeWindowMs: context.windowMs,
    sourceCount: context.laneCounts.get(laneKey) ?? 0,
  })
}

export class PriceMonitorWorker {
  readonly owner = randomUUID()
  scheduled = false
  started = false
  private stopped = false
  private leaseHeld = false
  private lastHeartbeat = 0
  private lastSync = 0
  private lastPrune = 0
  private lastAdvisorCheck = 0
  private advising: Promise<unknown> | null = null
  /** Other stores: a search running on the Amazon lane. */
  discovering: Promise<unknown> | null = null
  private discoveryNotBefore = 0
  private timer: unknown = null
  private passing: Promise<void> | null = null
  private passAgain = false
  readonly inFlight = new Map<string, InFlight>()
  private readonly checks = new Set<Promise<void>>()
  private readonly controllers = new Set<AbortController>()

  constructor(private readonly deps: WorkerDeps = realDeps) {}

  /** Scheduled monitoring, or manual-only (Check now) when `scheduled` is false. */
  start(options: { scheduled: boolean; warmupMs?: number }) {
    this.stopped = false
    this.scheduled = this.scheduled || options.scheduled
    if (this.started) {
      this.wake(0)
      return
    }
    this.started = true
    this.wake(options.warmupMs ?? 0)
  }

  wake(delayMs = 0) {
    if (this.stopped || !this.started) return
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = this.deps.setTimer(
      () => {
        this.timer = null
        void this.pass()
      },
      Math.max(0, delayMs),
    )
  }

  /** One scheduling round; safe to call concurrently (it coalesces). */
  pass(): Promise<void> {
    if (this.passing) {
      this.passAgain = true
      return this.passing
    }
    this.passing = (async () => {
      do {
        this.passAgain = false
        await this.runPass()
      } while (this.passAgain && !this.stopped)
    })().finally(() => {
      this.passing = null
    })
    return this.passing
  }

  private async ensureLease(now: number): Promise<boolean> {
    if (this.leaseHeld && now - this.lastHeartbeat < HEARTBEAT_MS) return true
    const held = await acquireWorkerLease(this.owner, now)
    if (held && !this.leaseHeld) await resetStaleChecking()
    this.leaseHeld = held
    if (held) this.lastHeartbeat = now
    return held
  }

  private async runPass(): Promise<void> {
    if (this.stopped) return
    let delay = MAX_SLEEP_MS
    try {
      const access = getVaultAccessState()
      if (access.readOnly) {
        delay = 30 * SECOND_MS
        return
      }
      const database = getLocalDb()
      const settings = getSettings().priceMonitoring
      const now = this.deps.now()
      if (!(await this.ensureLease(now))) return

      if (now - this.lastSync >= SYNC_EVERY_MS) {
        this.lastSync = now
        await syncAllAutoSources()
      }
      if (now - this.lastPrune >= PRUNE_EVERY_MS) {
        this.lastPrune = now
        await pruneCheckLog(now)
      }

      const hours = effectiveActiveHours(settings.schedule)
      const scheduledActive =
        this.scheduled &&
        settings.enabled &&
        isWithinActiveHours(hours, new Date(now))
      const advice = readActiveAdvice(database, now)
      // Advised quiet hours hold a store's scheduled checks; Check now still runs.
      const candidates = readQueueCandidates(database, settings).map(
        (candidate) =>
          candidate.scheduled &&
          inQuietHours(advice.get(candidate.laneKey), new Date(now))
            ? { ...candidate, scheduled: false }
            : candidate,
      )
      const stored = readLaneStates(database)
      const lanes = new Map(
        [...stored].map(([key, lane]) => [
          key,
          effectiveLane(lane, settings.pacing, advice.get(key), now),
        ]),
      )
      if (scheduledActive) this.maybeAdvise(settings, stored.values(), now)
      // The daily AI summary for the Inbox; runs in the background.
      if (this.scheduled && settings.enabled)
        startPriceDigestIfDue(settings, now)
      const input: QueueInput = {
        candidates,
        lanes,
        busyLanes: this.busyLanes(),
        now,
        scheduledActive,
        defaultLane: (laneKey) =>
          effectiveLane(
            defaultLaneState(laneKey, settings.pacing, now),
            settings.pacing,
            advice.get(laneKey),
            now,
          ),
      }
      const context: PassContext = {
        settings,
        generation: access.generation,
        intervalMs: frequencyMs(settings.schedule),
        windowMs: activeWindowMs(settings.schedule),
        laneCounts: scheduledCounts(candidates),
        firstReadings: scheduledCounts(
          candidates,
          (candidate) => candidate.priority === 1,
        ),
        firstReadingIds: new Set(
          candidates
            .filter((candidate) => candidate.priority === 1)
            .map((candidate) => candidate.sourceId),
        ),
      }
      for (const pick of pickNextChecks(input)) {
        const lane = lanes.get(pick.laneKey) ?? input.defaultLane(pick.laneKey)
        this.launch(pick, lane, context)
      }
      // Searches on other stores only use the Amazon lane when no Amazon
      // check is due: monitoring known sources comes first.
      if (scheduledActive) this.maybeDiscover(input, context, now)
      const wakeAt = nextWakeAt({
        ...input,
        busyLanes: this.busyLanes(),
      })
      if (wakeAt !== null)
        delay = Math.min(MAX_SLEEP_MS, Math.max(SECOND_MS, wakeAt - now))
    } catch (error) {
      if (!isVaultError(error)) reportServerError(error, 'price-monitor/worker')
    } finally {
      this.wake(delay)
    }
  }

  private busyLanes(): Set<string> {
    const busy = new Set(this.inFlight.keys())
    if (this.discovering) busy.add(DISCOVERY_LANE)
    return busy
  }

  /**
   * Other stores: starts one AI search on the Amazon lane when the lane is
   * free and ready and a knife is due. The search
   * counts as an Amazon request for pacing and the circuit breaker.
   */
  private maybeDiscover(input: QueueInput, context: PassContext, now: number) {
    const { discover, nextDiscovery } = this.deps
    if (this.discovering || !discover || !nextDiscovery) return
    if (!discoveryActive(context.settings) || now < this.discoveryNotBefore)
      return
    const busy = this.busyLanes()
    if (busy.has(DISCOVERY_LANE)) return
    const lane =
      input.lanes.get(DISCOVERY_LANE) ?? input.defaultLane(DISCOVERY_LANE)
    if (laneAvailability(lane, now).state !== 'ready') return
    const knifeId = nextDiscovery(context.settings, now)
    if (!knifeId) {
      this.discoveryNotBefore = now + DISCOVERY_IDLE_MS
      return
    }
    const controller = new AbortController()
    this.controllers.add(controller)
    const floorMs = laneFloorMs(DISCOVERY_LANE, context.settings.pacing)
    const gapMs = laneGapMs({
      minGapMs: lane.minGapMs,
      floorMs,
      activeWindowMs: context.windowMs,
      sourceCount: context.laneCounts.get(DISCOVERY_LANE) ?? 0,
    })
    this.discovering = (async () => {
      try {
        const summary = await discover(knifeId, { signal: controller.signal })
        if (summary.status !== 'done' || controller.signal.aborted) return
        if (summary.aiProblem)
          this.discoveryNotBefore = this.deps.now() + DISCOVERY_AI_PAUSE_MS
        const current = readLaneStates(getLocalDb()).get(DISCOVERY_LANE) ?? lane
        const update = applyLaneOutcome(
          normalizeLane(current, context.settings.pacing),
          {
            kind: summary.laneOutcome,
            durationMs: summary.durationMs,
            retryAfterMs: summary.retryAfterMs,
          },
          { now: this.deps.now(), gapMs, floorMs, random: this.deps.random },
        )
        await writeLaneState(update.lane, context.generation)
        if (update.clearCookies)
          await clearBrowserState(DISCOVERY_LANE).catch(() => {})
      } catch (error) {
        this.discoveryNotBefore = this.deps.now() + DISCOVERY_AI_PAUSE_MS
        if (!isVaultError(error) && !controller.signal.aborted)
          reportServerError(error, 'price-monitor/discovery')
      } finally {
        this.controllers.delete(controller)
        this.discovering = null
        this.wake(0)
      }
    })()
  }

  /** Other stores: search again now (settings changed or Search again). */
  resetDiscoveryPause() {
    this.discoveryNotBefore = 0
    this.wake(0)
  }

  /**
   * Starts the AI advisor in the background when it is due (daily, or after
   * a store blocked us twice within 24 hours). Never blocks the queue.
   */
  private maybeAdvise(
    settings: PriceMonitoringSettings,
    lanes: Iterable<LaneState>,
    now: number,
  ) {
    if (this.advising || !this.deps.advise) return
    if (!aiConfigured(settings.ai) || !settings.ai.advisor) return
    if (now - this.lastAdvisorCheck < ADVISOR_CHECK_EVERY_MS) return
    this.lastAdvisorCheck = now
    const trigger = advisorDue({ lastRunAt: lastAdvisorRunAt(), lanes, now })
    if (!trigger) return
    this.advising = this.deps
      .advise(trigger)
      .catch((error) => {
        if (!isVaultError(error))
          reportServerError(error, 'price-monitor/advisor')
      })
      .finally(() => {
        this.advising = null
        this.wake(0)
      })
  }

  private launch(pick: QueuePick, lane: LaneState, context: PassContext) {
    const startedAt = this.deps.now()
    this.inFlight.set(pick.laneKey, {
      sourceId: pick.sourceId,
      laneKey: pick.laneKey,
      trigger: pick.trigger,
      startedAt,
    })
    const floorMs = laneFloorMs(pick.laneKey, context.settings.pacing)
    const gapMs = gapAfterCheck({
      lane,
      laneKey: pick.laneKey,
      floorMs,
      context,
      firstReading: context.firstReadingIds.has(pick.sourceId),
    })
    const controller = new AbortController()
    this.controllers.add(controller)
    const run = (async () => {
      try {
        const summary = await this.deps.check(pick.sourceId, {
          trigger: pick.trigger,
          intervalMs: context.intervalMs,
          signal: controller.signal,
        })
        if (summary.status !== 'done' || controller.signal.aborted) return
        const current = readLaneStates(getLocalDb()).get(pick.laneKey) ?? lane
        const update = applyLaneOutcome(
          normalizeLane(current, context.settings.pacing),
          {
            kind: summary.laneOutcome,
            durationMs: summary.durationMs,
            retryAfterMs: summary.retryAfterMs,
          },
          { now: this.deps.now(), gapMs, floorMs, random: this.deps.random },
        )
        await writeLaneState(update.lane, context.generation)
        if (update.clearCookies)
          await clearBrowserState(pick.laneKey).catch(() => {})
      } catch (error) {
        if (!isVaultError(error))
          reportServerError(error, 'price-monitor/check')
      } finally {
        this.controllers.delete(controller)
        this.inFlight.delete(pick.laneKey)
        this.wake(0)
      }
    })()
    this.checks.add(run)
    void run.finally(() => this.checks.delete(run))
  }

  /** Resolves when no check is running and no pass is in progress. */
  async idle(): Promise<void> {
    while (
      this.passing ||
      this.checks.size ||
      this.advising ||
      this.discovering
    ) {
      await Promise.all([
        this.passing,
        this.advising,
        this.discovering,
        ...this.checks,
      ])
    }
  }

  /** Stops scheduling, cancels running checks and releases the lease. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = null
    for (const controller of this.controllers) controller.abort()
    await this.idle()
    this.started = false
    this.scheduled = false
    if (this.leaseHeld) {
      this.leaseHeld = false
      await releaseWorkerLease(this.owner).catch(() => {})
    }
  }
}

const WORKER_SYMBOL = Symbol.for('bladevault.price-monitor.worker')

/** The process-wide worker (survives Next dev module reloads). */
export function getPriceMonitorWorker(): PriceMonitorWorker {
  const scope = globalThis as typeof globalThis & {
    [WORKER_SYMBOL]?: PriceMonitorWorker
  }
  return (scope[WORKER_SYMBOL] ??= new PriceMonitorWorker())
}

/** Called from instrumentation.ts once the server starts. */
export function startPriceMonitorWorker() {
  const configured = Number(process.env.BLADEVAULT_PRICE_MONITOR_WARMUP_MS)
  getPriceMonitorWorker().start({
    scheduled: true,
    warmupMs: Number.isFinite(configured) ? configured : DEFAULT_WARMUP_MS,
  })
}

/**
 * Check now: marks the sources and makes sure a worker runs here, at least
 * for manual checks (dev servers and tests do not schedule). Another
 * process holding the lease picks them up within a minute instead.
 */
export async function requestPriceChecks(
  sourceIds: readonly number[],
): Promise<number[]> {
  const queued = await requestSourceChecks(sourceIds)
  if (queued.length) getPriceMonitorWorker().start({ scheduled: false })
  return queued
}

export type QueueLaneView = {
  laneKey: string
  /** Sources covered by scheduled monitoring. */
  sources: number
  /** Check now requests waiting. */
  manual: number
  minGapMs: number
  gapMs: number
  readyAt: string | null
  circuit: 'closed' | 'open'
  cooldownUntil: string | null
  strategy: HostStrategy
  fullPassMs: number
  lastRequestAt: string | null
  checking: boolean
  /** AI advice in force for this store, if any. */
  advice: {
    minGapMs: number | null
    pauseUntil: string | null
    quietHours: ActiveHours | null
    reason: string
    expiresAt: string
  } | null
}

export type QueueSnapshot = {
  /** This server process runs the worker (scheduled or manual-only). */
  running: boolean
  scheduled: boolean
  enabled: boolean
  scheduledActive: boolean
  activeHours: ActiveHours | null
  timeZone: string
  frequencyMs: number
  inFlight: Array<{
    sourceId: number
    laneKey: string
    trigger: QueuePick['trigger']
    startedAt: string
  }>
  lanes: QueueLaneView[]
}

const iso = (value: number | null) =>
  value === null ? null : new Date(value).toISOString()

/** Queue state for the UI, read from SQLite plus this process's checks. */
export function buildQueueSnapshot(now = Date.now()): QueueSnapshot {
  const worker = getPriceMonitorWorker()
  const database = getLocalDb()
  const settings = getSettings().priceMonitoring
  const hours = effectiveActiveHours(settings.schedule)
  const candidates = readQueueCandidates(database, settings)
  const counts = scheduledCounts(candidates)
  const manual = new Map<string, number>()
  for (const candidate of candidates)
    if (candidate.priority >= 2)
      manual.set(candidate.laneKey, (manual.get(candidate.laneKey) ?? 0) + 1)
  const stored = readLaneStates(database)
  const advice = readActiveAdvice(database, now)
  const laneKeys = new Set([...counts.keys(), ...manual.keys()])
  const windowMs = activeWindowMs(settings.schedule)
  const checkingLanes = new Set(
    (
      database
        .prepare(
          `SELECT DISTINCT lane_key FROM price_sources
           WHERE status = 'checking' AND removed_at IS NULL`,
        )
        .all() as Array<{ lane_key: string }>
    ).map((row) => row.lane_key),
  )

  const lanes = [...laneKeys].sort().map((laneKey): QueueLaneView => {
    const raw = stored.get(laneKey)
    const laneAdvice = advice.get(laneKey)
    const lane = effectiveLane(
      raw ?? defaultLaneState(laneKey, settings.pacing, now),
      settings.pacing,
      laneAdvice,
      now,
    )
    const sources = counts.get(laneKey) ?? 0
    const gapMs = laneGapMs({
      minGapMs: lane.minGapMs,
      floorMs: laneFloorMs(laneKey, settings.pacing),
      activeWindowMs: windowMs,
      sourceCount: sources,
    })
    const availability = laneAvailability(lane, now)
    return {
      laneKey,
      sources,
      manual: manual.get(laneKey) ?? 0,
      minGapMs: lane.minGapMs,
      gapMs,
      readyAt: iso(lane.readyAt),
      circuit: availability.state === 'cooling' ? 'open' : 'closed',
      cooldownUntil:
        availability.state === 'cooling' ? iso(availability.until) : null,
      strategy: raw?.strategy ?? 'auto',
      fullPassMs: fullPassMs(gapMs, sources),
      lastRequestAt: iso(lane.lastRequestAt),
      checking:
        worker.inFlight.has(laneKey) ||
        checkingLanes.has(laneKey) ||
        (laneKey === DISCOVERY_LANE && Boolean(worker.discovering)),
      advice: laneAdvice
        ? {
            minGapMs: laneAdvice.minGapMs,
            pauseUntil: iso(laneAdvice.pauseUntil),
            quietHours: laneAdvice.quietHours,
            reason: laneAdvice.reason,
            expiresAt: new Date(laneAdvice.expiresAt).toISOString(),
          }
        : null,
    }
  })

  return {
    running: worker.started,
    scheduled: worker.scheduled,
    enabled: settings.enabled,
    scheduledActive:
      settings.enabled && isWithinActiveHours(hours, new Date(now)),
    activeHours: hours,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    frequencyMs: frequencyMs(settings.schedule),
    inFlight: [...worker.inFlight.values()].map((entry) => ({
      sourceId: entry.sourceId,
      laneKey: entry.laneKey,
      trigger: entry.trigger,
      startedAt: new Date(entry.startedAt).toISOString(),
    })),
    lanes,
  }
}
