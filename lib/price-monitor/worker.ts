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
import {
  agentActive,
  agentDue,
  agentEventGapMs,
  lastAgentRunAt,
  pruneAgentRuns,
  readAgentEvents,
  runPriceAgent,
  type AgentRunResult,
  type AgentTrigger,
} from '@/lib/price-monitor/agent'
import { aiConfigured } from '@/lib/price-monitor/ai'
import { clearBrowserState } from '@/lib/price-monitor/browser-state'
import {
  discoverKnife,
  discoveryActive,
  enabledDiscoveryStores,
  nextDiscoveryKnife,
  type DiscoverySummary,
} from '@/lib/price-monitor/discovery'
import { DISCOVERY_STORES } from '@/lib/price-monitor/discovery-stores'
import { startPriceDigestIfDue } from '@/lib/price-monitor/digest'
import { checkPriceSource } from '@/lib/price-monitor/engine'
import { checkClockJump, monitorHoldMs } from '@/lib/price-monitor/power'
import {
  applyLaneOutcome,
  defaultLaneState,
  discoveryAvailability,
  discoveryGapMs,
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
  checkLoad,
  effectiveActiveHours,
  frequencyMs,
  isWithinActiveHours,
} from '@/lib/price-monitor/schedule'
import {
  acquireWorkerLease,
  ownsWorkerLease,
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
  OtherStoreId,
  PriceMonitoringSettings,
} from '@/lib/settings-shared'
import { getVaultAccessState, withVaultWrite } from '@/lib/vault-access'

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
/** How often the worker looks whether the AI supervisor is due. */
const AGENT_CHECK_EVERY_MS = MINUTE_MS
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
  /**
   * The AI supervisor; only runs when AI is set up and its mode is on.
   * `canWrite` says whether this worker still holds the lease.
   */
  supervise?: (
    trigger: AgentTrigger,
    options: { canWrite: () => boolean },
  ) => Promise<AgentRunResult>
  /** Other stores: the next knife AI should look for at a store, or null. */
  nextDiscovery?: (
    settings: PriceMonitoringSettings,
    now: number,
    store: OtherStoreId,
  ) => string | null
  /** Other stores: AI looks for one knife at a store. */
  discover?: (
    knifeId: string,
    options: {
      signal: AbortSignal
      store: OtherStoreId
      canWrite: () => boolean
    },
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
  supervise: (trigger, options) => runPriceAgent({ trigger, ...options }),
  nextDiscovery: (settings, now, store) =>
    nextDiscoveryKnife(settings, now, store),
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
  /** Scheduled checks per store and window (long out-of-stock count less). */
  laneCounts: Map<string, number>
  /**
   * Scheduled sources per store waiting for an early check: never checked,
   * or moved forward by the AI supervisor (priority 1).
   */
  firstReadings: Map<string, number>
  /** The never-checked sources themselves. */
  firstReadingIds: ReadonlySet<number>
  /** AI advice per store: pauses and quiet hours hold searches too. */
  advice: Map<string, ActiveLaneAdvice>
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
    minGapMs: Math.max(lane.minGapMs, laneFloorMs(pacing)),
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
 * Scheduled checks per store in one frequency window: one per source, less
 * for a page out of stock long enough to be checked only once a day.
 */
function scheduledLoad(
  candidates: readonly CandidateRow[],
  schedule: PriceMonitoringSettings['schedule'],
  now: number,
) {
  const intervalMs = frequencyMs(schedule)
  const load = new Map<string, number>()
  for (const candidate of candidates)
    if (candidate.scheduled)
      load.set(
        candidate.laneKey,
        (load.get(candidate.laneKey) ?? 0) +
          checkLoad({
            intervalMs,
            outOfStockSince: candidate.outOfStockSince,
            now,
            slowOutOfStock: schedule.slowOutOfStock,
            focusIntervalMs: candidate.focusIntervalMs,
          }),
      )
  return load
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
  private lastAgentCheck = 0
  private supervising: Promise<unknown> | null = null
  /** Other stores: a search running on a store's lane. */
  discovering: Promise<unknown> | null = null
  /** The store lane the running search uses. */
  discoveryLane: string | null = null
  /** AI endpoint trouble pauses every store. */
  private discoveryNotBefore = 0
  /** A store with no knife due is asked again after a while. */
  private discoveryIdleUntil = new Map<OtherStoreId, number>()
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

  /**
   * Whether this worker still holds the lease, read from the vault. Work
   * that finishes after the lease moved to another process (after sleep, or
   * to a newer build) or after stop() writes nothing.
   */
  readonly ownsLease = (): boolean => {
    if (this.stopped || !this.leaseHeld) return false
    if (ownsWorkerLease(this.owner)) return true
    this.leaseHeld = false
    return false
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
      // Asleep, just awake or offline: checks and AI runs wait (power.ts).
      checkClockJump()
      const hold = monitorHoldMs(now)
      if (hold > 0) {
        delay = Math.min(MAX_SLEEP_MS, Math.max(SECOND_MS, hold))
        return
      }

      if (now - this.lastSync >= SYNC_EVERY_MS) {
        this.lastSync = now
        await syncAllAutoSources()
      }
      if (now - this.lastPrune >= PRUNE_EVERY_MS) {
        this.lastPrune = now
        await pruneCheckLog(now)
        await withVaultWrite(async () => pruneAgentRuns(getLocalDb(), now))
      }

      const hours = effectiveActiveHours(settings.schedule)
      const scheduledActive =
        this.scheduled &&
        settings.enabled &&
        isWithinActiveHours(hours, new Date(now))
      const advice = readActiveAdvice(database, now)
      // Advised quiet hours hold a store's scheduled checks; Check now still runs.
      const candidates = readQueueCandidates(database, settings, now).map(
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
      if (scheduledActive) {
        this.maybeAdvise(settings, stored.values(), now)
        this.maybeSupervise(settings, now)
      }
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
        pauses: new Map(
          [...advice].flatMap(([key, item]) =>
            item.expiresAt > now && item.pauseUntil !== null
              ? [[key, item.pauseUntil] as const]
              : [],
          ),
        ),
      }
      const context: PassContext = {
        settings,
        generation: access.generation,
        intervalMs: frequencyMs(settings.schedule),
        windowMs: activeWindowMs(settings.schedule),
        laneCounts: scheduledLoad(candidates, settings.schedule, now),
        firstReadings: scheduledCounts(
          candidates,
          (candidate) => candidate.priority === 1,
        ),
        firstReadingIds: new Set(
          candidates
            .filter((candidate) => candidate.priority === 1)
            .map((candidate) => candidate.sourceId),
        ),
        advice,
      }
      for (const pick of pickNextChecks(input)) {
        const lane = lanes.get(pick.laneKey) ?? input.defaultLane(pick.laneKey)
        this.launch(pick, lane, context)
      }
      // Searches on other stores only use a store's lane when no check
      // there is due: monitoring known sources comes first.
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
    if (this.discovering && this.discoveryLane) busy.add(this.discoveryLane)
    return busy
  }

  /**
   * Other stores: starts one AI search at the first enabled store whose
   * lane is free and ready and that has a knife due. The search counts as a
   * request at that store for pacing and the circuit breaker.
   */
  private maybeDiscover(input: QueueInput, context: PassContext, now: number) {
    const { discover, nextDiscovery } = this.deps
    if (this.discovering || !discover || !nextDiscovery) return
    if (!discoveryActive(context.settings) || now < this.discoveryNotBefore)
      return
    const busy = this.busyLanes()
    let picked: { store: OtherStoreId; knifeId: string } | null = null
    for (const store of enabledDiscoveryStores(context.settings)) {
      if ((this.discoveryIdleUntil.get(store) ?? 0) > now) continue
      const laneKey = DISCOVERY_STORES[store].laneKey
      if (busy.has(laneKey)) continue
      const advice = context.advice.get(laneKey)
      if (inQuietHours(advice, new Date(now))) continue
      const lane = input.lanes.get(laneKey) ?? input.defaultLane(laneKey)
      // After a cooldown the search is the store's probe: a store with no
      // price sources there has no check that could probe it,
      // and its searches would otherwise stop for good.
      const availability = discoveryAvailability(lane, now, {
        floorMs: laneFloorMs(context.settings.pacing),
        pauseUntil: advice && advice.expiresAt > now ? advice.pauseUntil : null,
      }).state
      if (availability !== 'ready' && availability !== 'probe') continue
      const knifeId = nextDiscovery(context.settings, now, store)
      if (!knifeId) {
        this.discoveryIdleUntil.set(store, now + DISCOVERY_IDLE_MS)
        continue
      }
      picked = { store, knifeId }
      break
    }
    if (!picked) return
    const { store, knifeId } = picked
    const laneKey = DISCOVERY_STORES[store].laneKey
    const lane = input.lanes.get(laneKey) ?? input.defaultLane(laneKey)
    const controller = new AbortController()
    this.controllers.add(controller)
    const floorMs = laneFloorMs(context.settings.pacing)
    // The next search waits the store's minimum gap; scheduled checks keep
    // their own spread (below).
    const gapMs = discoveryGapMs(lane, floorMs)
    this.discoveryLane = laneKey
    this.discovering = (async () => {
      try {
        const summary = await discover(knifeId, {
          signal: controller.signal,
          store,
          canWrite: this.ownsLease,
        })
        if (summary.status !== 'done' || controller.signal.aborted) return
        if (!this.ownsLease()) return
        if (summary.aiProblem)
          this.discoveryNotBefore = this.deps.now() + DISCOVERY_AI_PAUSE_MS
        const current = readLaneStates(getLocalDb()).get(laneKey) ?? lane
        const update = applyLaneOutcome(
          normalizeLane(current, context.settings.pacing),
          {
            kind: summary.laneOutcome,
            durationMs: summary.durationMs,
            retryAfterMs: summary.retryAfterMs,
          },
          { now: this.deps.now(), gapMs, floorMs, random: this.deps.random },
        )
        // A search that went well does not bring the store's next scheduled
        // check forward: its spread still holds.
        if (
          update.lane.circuit === 'closed' &&
          summary.laneOutcome === 'success'
        )
          update.lane.readyAt = Math.max(update.lane.readyAt, current.readyAt)
        await writeLaneState(update.lane, context.generation)
        if (update.clearCookies)
          await clearBrowserState(laneKey).catch(() => {})
      } catch (error) {
        this.discoveryNotBefore = this.deps.now() + DISCOVERY_AI_PAUSE_MS
        if (!isVaultError(error) && !controller.signal.aborted)
          reportServerError(error, 'price-monitor/discovery')
      } finally {
        this.controllers.delete(controller)
        this.discovering = null
        this.discoveryLane = null
        this.wake(0)
      }
    })()
  }

  /** Other stores: search again now (settings changed or Search again). */
  resetDiscoveryPause() {
    this.discoveryNotBefore = 0
    this.discoveryIdleUntil.clear()
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

  /**
   * Starts the AI supervisor in the background when it is due: when price,
   * stock or page changes wait since its last run (at most every 10 minutes
   * with Unlimited AI, every hour with Limited), and otherwise on its
   * heartbeat (hourly with Unlimited, every 6 hours with Limited). Its
   * actions only reorder the paced queue, so the next pass picks them up.
   */
  private maybeSupervise(settings: PriceMonitoringSettings, now: number) {
    if (this.supervising || !this.deps.supervise) return
    if (!agentActive(settings)) return
    if (now - this.lastAgentCheck < AGENT_CHECK_EVERY_MS) return
    this.lastAgentCheck = now
    const database = getLocalDb()
    const lastRunAt = lastAgentRunAt(database)
    // Events matter only once the gap since the last run has passed.
    const events =
      lastRunAt !== null && now - lastRunAt >= agentEventGapMs(settings)
        ? readAgentEvents(database, lastRunAt, 0)
        : undefined
    const trigger = agentDue({ settings, lastRunAt, now, events })
    if (!trigger) return
    this.supervising = this.deps
      .supervise(trigger, { canWrite: this.ownsLease })
      .catch((error) => {
        if (!isVaultError(error))
          reportServerError(error, 'price-monitor/agent')
      })
      .finally(() => {
        this.supervising = null
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
    const floorMs = laneFloorMs(context.settings.pacing)
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
        if (!this.ownsLease()) return
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
      this.supervising ||
      this.discovering
    ) {
      await Promise.all([
        this.passing,
        this.advising,
        this.supervising,
        this.discovering,
        ...this.checks,
      ])
    }
  }

  /**
   * Stops scheduling, cancels running checks and releases the lease. With
   * `timeoutMs` (server shutdown) it waits at most that long for running
   * work (an AI run cannot be cancelled) and releases the lease anyway;
   * that work then finds it no longer owns the lease and writes nothing.
   */
  async stop(options: { timeoutMs?: number } = {}): Promise<void> {
    this.stopped = true
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = null
    for (const controller of this.controllers) controller.abort()
    const idle = this.idle()
    if (options.timeoutMs === undefined) await idle
    else {
      let timeout: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        idle,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, options.timeoutMs)
        }),
      ])
      clearTimeout(timeout)
    }
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
  /** Sources covered by scheduled monitoring (also while the store is paused). */
  sources: number
  /** Of those, pages out of stock long enough to be checked once a day. */
  slowed: number
  /** The user paused scheduled checks at this store. */
  paused: boolean
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
  /** Checks waiting to run: Check now requests and due scheduled checks. */
  waiting: number
  /** Sources checked since `since` (Check all progress), when asked. */
  checkedSince: number | null
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
export function buildQueueSnapshot(
  now = Date.now(),
  options: { since?: string | null } = {},
): QueueSnapshot {
  const worker = getPriceMonitorWorker()
  const database = getLocalDb()
  const settings = getSettings().priceMonitoring
  const hours = effectiveActiveHours(settings.schedule)
  const candidates = readQueueCandidates(database, settings, now)
  const counts = scheduledCounts(candidates)
  const load = scheduledLoad(candidates, settings.schedule, now)
  const covered = new Map<string, number>()
  const slowed = new Map<string, number>()
  const manual = new Map<string, number>()
  const intervalMs = frequencyMs(settings.schedule)
  let waiting = 0
  for (const candidate of candidates) {
    const { laneKey } = candidate
    if (candidate.covered) {
      covered.set(laneKey, (covered.get(laneKey) ?? 0) + 1)
      if (
        checkLoad({
          intervalMs,
          outOfStockSince: candidate.outOfStockSince,
          now,
          slowOutOfStock: settings.schedule.slowOutOfStock,
          focusIntervalMs: candidate.focusIntervalMs,
        }) < 1
      )
        slowed.set(laneKey, (slowed.get(laneKey) ?? 0) + 1)
    }
    if (candidate.priority >= 2)
      manual.set(laneKey, (manual.get(laneKey) ?? 0) + 1)
    if (
      candidate.priority >= 2 ||
      (candidate.scheduled &&
        (candidate.nextCheckAt === null || candidate.nextCheckAt <= now))
    )
      waiting += 1
  }
  const stored = readLaneStates(database)
  const advice = readActiveAdvice(database, now)
  const pausedLanes = new Set(
    candidates
      .filter((candidate) => candidate.storePaused && candidate.covered)
      .map((candidate) => candidate.laneKey),
  )
  const laneKeys = new Set([...counts.keys(), ...manual.keys(), ...pausedLanes])
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
  const since = options.since ? Date.parse(options.since) : NaN
  const checkedSince = Number.isFinite(since)
    ? (
        database
          .prepare(
            `SELECT COUNT(*) AS n FROM price_sources
             WHERE removed_at IS NULL AND last_checked_at >= ?`,
          )
          .get(new Date(since).toISOString()) as { n: number }
      ).n
    : null

  const lanes = [...laneKeys].sort().map((laneKey): QueueLaneView => {
    const raw = stored.get(laneKey)
    const laneAdvice = advice.get(laneKey)
    const lane = effectiveLane(
      raw ?? defaultLaneState(laneKey, settings.pacing, now),
      settings.pacing,
      laneAdvice,
      now,
    )
    const laneLoad = load.get(laneKey) ?? 0
    const gapMs = laneGapMs({
      minGapMs: lane.minGapMs,
      floorMs: laneFloorMs(settings.pacing),
      activeWindowMs: windowMs,
      sourceCount: laneLoad,
    })
    const availability = laneAvailability(lane, now)
    return {
      laneKey,
      sources: covered.get(laneKey) ?? 0,
      slowed: slowed.get(laneKey) ?? 0,
      paused: pausedLanes.has(laneKey),
      manual: manual.get(laneKey) ?? 0,
      minGapMs: lane.minGapMs,
      gapMs,
      readyAt: iso(lane.readyAt),
      circuit: availability.state === 'cooling' ? 'open' : 'closed',
      cooldownUntil:
        availability.state === 'cooling' ? iso(availability.until) : null,
      strategy: raw?.strategy ?? 'auto',
      fullPassMs: fullPassMs(gapMs, laneLoad),
      lastRequestAt: iso(lane.lastRequestAt),
      checking:
        worker.inFlight.has(laneKey) ||
        checkingLanes.has(laneKey) ||
        (laneKey === worker.discoveryLane && Boolean(worker.discovering)),
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
    frequencyMs: intervalMs,
    waiting,
    checkedSince,
    inFlight: [...worker.inFlight.values()].map((entry) => ({
      sourceId: entry.sourceId,
      laneKey: entry.laneKey,
      trigger: entry.trigger,
      startedAt: new Date(entry.startedAt).toISOString(),
    })),
    lanes,
  }
}
