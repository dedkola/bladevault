import { randomUUID } from 'node:crypto'
import { getLocalDb } from '@/lib/local-db'
import { readActiveAdvice } from '@/lib/price-monitor/advice-store'
import {
  advisorDue,
  advisorHistory,
  applyAdviceToLane,
  inQuietHours,
  maxAdvisedGapMs,
  runPriceAdvisor,
  type ActiveLaneAdvice,
  type AdvisorRunResult,
  type AdvisorTrigger,
} from '@/lib/price-monitor/advisor'
import {
  agentActive,
  agentDue,
  agentFailureStreak,
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
  AI_RESERVE_SHARE,
  DEFER_MAX_TRIES,
  DEFER_MIN_MS,
  FIX_BUDGET_MS,
  MAX_PARALLEL_TASKS,
  classifyCheck,
  deferredDueAt,
  linkDone,
  linkPending,
  pickLaneCheck,
  pickLaneSearch,
  plannedCheckTimes,
  restPaceMs,
  type CycleLink,
  type CycleRetry,
} from '@/lib/price-monitor/cycle'
import {
  discoverKnife,
  discoveryActive,
  enabledDiscoveryStores,
  type DiscoverySummary,
} from '@/lib/price-monitor/discovery'
import { readDiscoveryQueue } from '@/lib/price-monitor/discovery-store'
import { DISCOVERY_STORES } from '@/lib/price-monitor/discovery-stores'
import { startAttentionSummaryIfDue } from '@/lib/price-monitor/attention'
import { startPriceDigestIfDue } from '@/lib/price-monitor/digest'
import {
  checkPriceSource,
  type CheckMode,
  type CheckSummary,
  type CheckTrigger,
} from '@/lib/price-monitor/engine'
import { countMonitorScopeKnives } from '@/lib/price-monitor/scope'
import type { MonitorTier } from '@/lib/price-monitor/shared'
import { checkClockJump, monitorHoldMs } from '@/lib/price-monitor/power'
import {
  applyLaneOutcome,
  defaultLaneState,
  discoveryAvailability,
  laneAvailability,
  laneFloorMs,
  type LaneState,
} from '@/lib/price-monitor/lanes'
import {
  nextWakeAt,
  pickNextChecks,
  type QueueInput,
} from '@/lib/price-monitor/queue'
import {
  dropStaleRetries,
  finishCycle,
  planCheckTimes,
  pruneRounds,
  readCurrentRound,
  readRetryTasks,
  recordCheckVerdict,
  startCycle,
  type RetryTask,
  type Round,
  type RoundTrigger,
} from '@/lib/price-monitor/round-store'
import type { RetryReason } from '@/lib/price-monitor/rounds'
import {
  adviceWindowMs,
  checkLoad,
  frequencyMs,
  scheduledIntervalMs,
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
  PriceMonitorScopeKind,
} from '@/lib/settings-shared'
import {
  getVaultAccessState,
  withVaultWrite,
  withVaultWriteSync,
} from '@/lib/vault-access'

/**
 * The price monitor. One worker per vault (a lease in SQLite). Scheduled
 * checks run in cycles (cycle.ts): every 6, 12 or 24 hours a cycle goes
 * through every monitored link. Stores work at the same time and on their
 * own, one request at a time with their own gap: What to monitor first,
 * then links never checked, then the rest of the collection spread over the
 * cycle. Pages a store could not serve now are tried again 10–15 minutes
 * later; pages without a usable price wait for AI at the end of the cycle.
 * Other stores searches run at each store between its checks. Check now
 * runs right away. Each store keeps its own pacing: an adaptive minimum
 * gap, Retry-After and a circuit breaker. It runs in the Next.js server
 * process and does not depend on any page being open.
 */
const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const DAY_MS = 24 * 60 * MINUTE_MS
const MAX_SLEEP_MS = MINUTE_MS
const HEARTBEAT_MS = 30 * SECOND_MS
const SYNC_EVERY_MS = 10 * MINUTE_MS
const PRUNE_EVERY_MS = DAY_MS
/** How often the worker looks whether the AI advisor is due. */
const ADVISOR_CHECK_EVERY_MS = 10 * MINUTE_MS
/** How often the worker looks whether the AI supervisor is due. */
const AGENT_CHECK_EVERY_MS = MINUTE_MS
/** The AI endpoint failed during a search: wait before the next one. */
const DISCOVERY_AI_PAUSE_MS = 30 * MINUTE_MS
/** A link of a knife watched closely waits at least this long between checks. */
const FOCUS_MIN_GAP_MS = 15 * MINUTE_MS
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
  discover: (knifeId, options) => discoverKnife(knifeId, options),
}

type InFlight = {
  sourceId: number
  laneKey: string
  trigger: CheckTrigger
  startedAt: number
  /** AI works on the page (a problem at the end of the cycle). */
  fix: boolean
}

type PassContext = {
  settings: PriceMonitoringSettings
  generation: string
  now: number
  intervalMs: number
  floorMs: number
  candidates: readonly CandidateRow[]
  advice: Map<string, ActiveLaneAdvice>
  /** A store's pacing with the floor and any AI advice in force. */
  laneFor: (laneKey: string) => LaneState
  /** Other stores searches may run now (on, AI connected, not paused). */
  searches: boolean
  /** Knives due for a search per store, in the queue's order. */
  dueSearches: Map<OtherStoreId, string[]>
}

/** What the cycle looks like in this pass. */
type PassCycle = {
  cycle: Round
  /** Scheduled monitoring runs here: deferred checks and AI fixes too. */
  scheduled: boolean
  /** The rest of the collection is spread over the cycle (not Check all). */
  spread: boolean
  links: CycleLink[]
  byLane: Map<string, CycleLink[]>
  retries: Map<string, CycleRetry[]>
  /** Links still to check in this cycle, at every store. */
  pending: number
  /** What to monitor's knives in the cycle's order (searches go first). */
  wishlistOrder: Map<string, number>
  /** Problem pages waiting for AI. */
  problems: RetryTask[]
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

/**
 * A store's pacing with the floor and any AI advice in force. The advised
 * gap is capped so the store's `sourceCount` checks still fit in one cycle
 * (maxAdvisedGapMs).
 */
function effectiveLane(
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

function scheduledCounts(candidates: readonly CandidateRow[]) {
  const counts = new Map<string, number>()
  for (const candidate of candidates)
    if (candidate.scheduled)
      counts.set(candidate.laneKey, (counts.get(candidate.laneKey) ?? 0) + 1)
  return counts
}

/** A page out of stock for two weeks that was checked within its slower pace. */
function restingOutOfStock(
  candidate: CandidateRow,
  context: Pick<PassContext, 'intervalMs' | 'now' | 'settings'>,
): boolean {
  if (candidate.lastCheckedAt === null) return false
  const waitMs = scheduledIntervalMs({
    intervalMs: context.intervalMs,
    outOfStockSince: candidate.outOfStockSince,
    now: context.now,
    slowOutOfStock: context.settings.schedule.slowOutOfStock,
    focusIntervalMs: candidate.focusIntervalMs,
  })
  return (
    waitMs > context.intervalMs &&
    context.now - candidate.lastCheckedAt < waitMs
  )
}

/** A link of a knife watched closely whose next check is due. */
function focusDue(candidate: CandidateRow, now: number): boolean {
  return (
    candidate.focusIntervalMs !== null &&
    (candidate.nextCheckAt === null || candidate.nextCheckAt <= now) &&
    (candidate.lastCheckedAt === null ||
      now - candidate.lastCheckedAt >= FOCUS_MIN_GAP_MS)
  )
}

function retryReasonFor(summary: CheckSummary | null): RetryReason {
  if (summary?.status !== 'done') return 'failed'
  return summary.outcome === 'blocked'
    ? 'blocked'
    : summary.outcome === 'no_price'
      ? 'no_price'
      : 'failed'
}

/** The AI may work on the product again right away (a fix). */
function liftAiWait(sourceId: number) {
  withVaultWriteSync(() => {
    getLocalDb()
      .prepare('UPDATE price_sources SET last_ai_at = NULL WHERE id = ?')
      .run(sourceId)
  })
}

/** When a store's last saved Other stores search ended (epoch ms), or null. */
function savedSearchAt(store: OtherStoreId): number | null {
  const row = getLocalDb()
    .prepare(
      'SELECT MAX(last_attempt_at) AS at FROM price_discovery WHERE store = ?',
    )
    .get(store) as { at: string | null } | undefined
  const at = row?.at ? Date.parse(row.at) : NaN
  return Number.isFinite(at) ? at : null
}

/**
 * The cycle's links from the queue's candidates: scheduled links not
 * waiting for Check now. Knives the cycle did not list (added since it
 * started) come after its own.
 */
function cycleLinks(
  cycle: Round,
  context: Pick<PassContext, 'candidates' | 'intervalMs' | 'now' | 'settings'>,
  setAside: ReadonlySet<number>,
): CycleLink[] {
  const order = new Map(cycle.knifeIds.map((id, index) => [id, index]))
  return context.candidates
    .filter(
      (candidate) =>
        candidate.scheduled &&
        candidate.priority < 2 &&
        !setAside.has(candidate.sourceId),
    )
    .map((candidate) => ({
      sourceId: candidate.sourceId,
      knifeId: candidate.knifeId,
      laneKey: candidate.laneKey,
      tier: candidate.tier,
      order: order.get(candidate.knifeId) ?? cycle.knifeIds.length,
      lastCheckedAt: candidate.lastCheckedAt,
      priority: candidate.priority === 1 || focusDue(candidate, context.now),
      resting: restingOutOfStock(candidate, context),
    }))
}

function groupByLane<T extends { laneKey: string }>(items: readonly T[]) {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const list = groups.get(item.laneKey)
    if (list) list.push(item)
    else groups.set(item.laneKey, [item])
  }
  return groups
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
  /** Other stores: the searches running, one per store lane at most. */
  readonly searches = new Map<string, Promise<unknown>>()
  /** When each store's last search here ended, saved or not. */
  private readonly searchedAt = new Map<OtherStoreId, number>()
  /** AI endpoint trouble pauses every store's searches. */
  private discoveryNotBefore = 0
  private timer: unknown = null
  private passing: Promise<void> | null = null
  private passAgain = false
  /** The earliest time something waits for, collected during a pass. */
  private wakeAt: number | null = null
  readonly inFlight = new Map<string, InFlight>()
  private readonly work = new Set<Promise<unknown>>()
  private readonly controllers = new Set<AbortController>()
  /** The cycle the per-store state below belongs to. */
  private cycleId: number | null = null
  /** Per store: its last check was moved forward (the next is ordinary). */
  private readonly lastWasPriority = new Map<string, boolean>()
  /** Per store: when its next rest-of-collection link may start. */
  private readonly restNextAt = new Map<string, number>()
  /** Per store: when its next deferred check may start. */
  private readonly deferredNextAt = new Map<string, number>()
  /** Links whose check threw in this cycle: on the retry list instead. */
  private readonly setAside = new Set<number>()
  /** Problem pages AI worked on in this cycle (one try each). */
  private readonly fixTried = new Set<number>()
  /**
   * Store searches run in this cycle (`store:knifeId`). A search saves its
   * result and moves to the back of the store's queue; one that ended
   * without saving (skipped, or an error) still waits for the next cycle.
   */
  private readonly searchedInCycle = new Set<string>()

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

  /** One scheduling pass; safe to call concurrently (it coalesces). */
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

  private considerWake(at: number | null) {
    if (at === null || !Number.isFinite(at)) return
    this.wakeAt = this.wakeAt === null ? at : Math.min(this.wakeAt, at)
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.work.add(promise)
    void promise.finally(() => this.work.delete(promise)).catch(() => {})
    return promise
  }

  private laneBusy(laneKey: string): boolean {
    return this.inFlight.has(laneKey) || this.searches.has(laneKey)
  }

  private busyLanes(): Set<string> {
    return new Set([...this.inFlight.keys(), ...this.searches.keys()])
  }

  /** Checks and searches running now (each one a browser at most). */
  private running(): number {
    return this.inFlight.size + this.searches.size
  }

  private get fixing(): boolean {
    for (const entry of this.inFlight.values()) if (entry.fix) return true
    return false
  }

  private async runPass(): Promise<void> {
    if (this.stopped) return
    let delay = MAX_SLEEP_MS
    this.wakeAt = null
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
        await dropStaleRetries(access.generation)
      }
      if (now - this.lastPrune >= PRUNE_EVERY_MS) {
        this.lastPrune = now
        await pruneCheckLog(now)
        await withVaultWrite(async () => {
          pruneAgentRuns(getLocalDb(), now)
          pruneRounds(getLocalDb(), now)
        })
      }

      const cyclesOn = this.scheduled && settings.enabled
      const advice = readActiveAdvice(database, now)
      const candidates = readQueueCandidates(database, settings, now)
      const stored = readLaneStates(database)
      const intervalMs = frequencyMs(settings.schedule)
      const counts = scheduledCounts(candidates)
      const laneFor = (laneKey: string) =>
        effectiveLane(
          stored.get(laneKey) ??
            defaultLaneState(laneKey, settings.pacing, now),
          settings.pacing,
          advice.get(laneKey),
          now,
          {
            activeWindowMs: adviceWindowMs(settings.schedule),
            sourceCount: counts.get(laneKey) ?? 0,
          },
        )
      if (cyclesOn) {
        this.maybeAdvise(
          settings,
          stored.values(),
          new Set(
            candidates
              .filter((candidate) => candidate.covered)
              .map((candidate) => candidate.laneKey),
          ),
          now,
        )
        this.maybeSupervise(settings, now)
        // The daily AI summary for the Inbox; runs in the background.
        startPriceDigestIfDue(settings, now)
        // The daily Needs attention summary; no AI, runs in the background.
        startAttentionSummaryIfDue(access.generation, now)
      }

      const context: PassContext = {
        settings,
        generation: access.generation,
        now,
        intervalMs,
        floorMs: laneFloorMs(settings.pacing),
        candidates,
        advice,
        laneFor,
        searches:
          discoveryActive(settings) &&
          now >= this.discoveryNotBefore &&
          Boolean(this.deps.discover),
        dueSearches: new Map(),
      }

      // Check now: right away, one request per store at a time.
      const manual: QueueInput = {
        candidates: candidates.filter((candidate) => candidate.priority >= 2),
        lanes: new Map(
          [...stored.keys()].map((laneKey) => [laneKey, laneFor(laneKey)]),
        ),
        busyLanes: this.busyLanes(),
        now,
        scheduledActive: false,
        defaultLane: laneFor,
      }
      for (const pick of pickNextChecks(manual))
        this.startManualCheck(
          pick.sourceId,
          pick.laneKey,
          pick.trigger,
          context,
        )
      this.considerWake(nextWakeAt({ ...manual, busyLanes: this.busyLanes() }))

      // Check all now where checks are not scheduled (dev server, or
      // BLADEVAULT_PRICE_MONITOR=off): its cycle runs here; deferred
      // checks, AI fixes and the next cycle wait for scheduled monitoring.
      const cycle = await this.currentCycle(context, cyclesOn)
      if (cycle) await this.driveCycle(cycle, cyclesOn, context)

      if (this.wakeAt !== null)
        delay = Math.min(MAX_SLEEP_MS, Math.max(SECOND_MS, this.wakeAt - now))
    } catch (error) {
      if (!isVaultError(error)) reportServerError(error, 'price-monitor/worker')
    } finally {
      this.wake(delay)
    }
  }

  // ----------------------------------------------------------- cycles

  /**
   * The cycle to work on. With scheduled monitoring one always runs: the
   * next starts when its time is up. Without it only Check all's cycle
   * runs here.
   */
  private async currentCycle(
    context: PassContext,
    cyclesOn: boolean,
  ): Promise<Round | null> {
    let cycle = readCurrentRound(getLocalDb())
    if (!cyclesOn) return cycle?.trigger === 'manual' ? cycle : null
    if (cycle && context.now >= cycle.startedAt + context.intervalMs) {
      await finishCycle({
        roundId: cycle.id,
        now: context.now,
        generation: context.generation,
      })
      cycle = null
    }
    cycle ??= await startCycle({
      settings: context.settings,
      trigger: 'scheduled',
      intervalMs: context.intervalMs,
      searches: context.searches,
      now: context.now,
      generation: context.generation,
    })
    if (cycle) this.considerWake(cycle.startedAt + context.intervalMs)
    return cycle
  }

  /** The cycle's state, and a fresh start of the per-store state on a new one. */
  private async cycleView(
    cycle: Round,
    scheduled: boolean,
    context: PassContext,
  ): Promise<PassCycle> {
    const fresh = this.cycleId !== cycle.id
    if (fresh) {
      this.cycleId = cycle.id
      this.lastWasPriority.clear()
      this.restNextAt.clear()
      this.deferredNextAt.clear()
      this.setAside.clear()
      this.fixTried.clear()
      this.searchedInCycle.clear()
    }
    const links = cycleLinks(cycle, context, this.setAside)
    const spread = cycle.trigger === 'scheduled'
    if (fresh)
      // "Next check" in the UI. Knives watched closely keep their own times.
      await planCheckTimes({
        planned: plannedCheckTimes({
          links: links.filter(
            (link) =>
              !context.candidates.some(
                (candidate) =>
                  candidate.sourceId === link.sourceId &&
                  candidate.focusIntervalMs !== null,
              ),
          ),
          now: context.now,
          cycleStart: cycle.startedAt,
          cycleMs: context.intervalMs,
          floorMs: context.floorMs,
          spread,
        }),
        generation: context.generation,
      })
    const scheduledIds = new Set(links.map((link) => link.sourceId))
    for (const sourceId of this.setAside) scheduledIds.add(sourceId)
    const tasks = readRetryTasks(getLocalDb()).filter(
      (task) =>
        task.kind === 'check' &&
        task.sourceId !== null &&
        scheduledIds.has(task.sourceId),
    )
    const retries = groupByLane(
      tasks
        .filter((task) => task.dueAt !== null)
        .map((task): CycleRetry => ({
          sourceId: task.sourceId!,
          laneKey: task.laneKey,
          dueAt: task.dueAt,
          supervisor: task.reason === 'supervisor',
        })),
    )
    const order = new Map(cycle.knifeIds.map((id, index) => [id, index]))
    const wishlistOrder = new Map<string, number>()
    for (const link of links)
      if (link.tier === 'scope')
        wishlistOrder.set(link.knifeId, order.get(link.knifeId) ?? link.order)
    return {
      cycle,
      scheduled,
      spread,
      links,
      byLane: groupByLane(links),
      retries,
      pending: links.filter((link) => linkPending(link, cycle.startedAt))
        .length,
      wishlistOrder,
      problems: tasks.filter((task) => task.dueAt === null),
    }
  }

  /**
   * Starts what each free store can start: an Other stores search when its
   * turn has come, else its next check (cycle.ts, pickLaneCheck). Stores
   * that answered least recently go first; at most MAX_PARALLEL_TASKS run.
   * Once every link of the cycle was checked (or its last tenth began), AI
   * works on one problem page at a time.
   */
  private async driveCycle(
    cycle: Round,
    scheduled: boolean,
    context: PassContext,
  ): Promise<void> {
    const view = await this.cycleView(cycle, scheduled, context)
    if (!scheduled && view.pending === 0) {
      // Check all without scheduled monitoring: done once all was checked.
      await finishCycle({
        roundId: cycle.id,
        now: context.now,
        generation: context.generation,
      })
      return
    }
    const searchLanes = new Map<string, OtherStoreId>()
    if (context.searches)
      for (const store of enabledDiscoveryStores(context.settings))
        searchLanes.set(DISCOVERY_STORES[store].laneKey, store)
    const lanes = [
      ...new Set([
        ...view.byLane.keys(),
        ...(scheduled ? view.retries.keys() : []),
        ...searchLanes.keys(),
      ]),
    ].sort(
      (a, b) =>
        (context.laneFor(a).lastRequestAt ?? -Infinity) -
          (context.laneFor(b).lastRequestAt ?? -Infinity) || a.localeCompare(b),
    )
    for (const laneKey of lanes) {
      if (this.running() >= MAX_PARALLEL_TASKS) break
      if (this.laneBusy(laneKey)) continue
      const store = searchLanes.get(laneKey)
      if (store && this.startSearchIfDue(store, laneKey, view, context))
        continue
      this.startLaneCheck(laneKey, view, context)
    }
    if (
      scheduled &&
      this.running() < MAX_PARALLEL_TASKS &&
      !this.fixing &&
      aiConfigured(context.settings.ai) &&
      (view.pending === 0 ||
        context.now >=
          cycle.startedAt + context.intervalMs * (1 - AI_RESERVE_SHARE))
    )
      this.startFix(view, context)
  }

  private holdFor(laneKey: string, context: PassContext): number | null {
    const advice = context.advice.get(laneKey)
    // Advised quiet hours hold scheduled work at the store.
    if (inQuietHours(advice, new Date(context.now)))
      return Number.POSITIVE_INFINITY
    return advice && advice.expiresAt > context.now ? advice.pauseUntil : null
  }

  /** A store's next check of the cycle, when the store is ready for it. */
  private startLaneCheck(
    laneKey: string,
    view: PassCycle,
    context: PassContext,
  ) {
    const lane = context.laneFor(laneKey)
    const pause = this.holdFor(laneKey, context)
    if (pause === Number.POSITIVE_INFINITY) return
    if (pause !== null && pause > context.now) {
      this.considerWake(pause)
      return
    }
    const availability = laneAvailability(lane, context.now)
    if (availability.state === 'waiting' || availability.state === 'cooling') {
      this.considerWake(availability.until)
      return
    }
    // One AI fix at a time: a due Retry with AI waits for the running one.
    const retries = (view.scheduled ? view.retries.get(laneKey) : null) ?? []
    const { pick, wakeAt } = pickLaneCheck({
      now: context.now,
      cycleStart: view.cycle.startedAt,
      links: view.byLane.get(laneKey) ?? [],
      retries: this.fixing
        ? retries.filter((retry) => !retry.supervisor)
        : retries,
      lastWasPriority: this.lastWasPriority.get(laneKey) ?? false,
      restReadyAt: view.spread ? (this.restNextAt.get(laneKey) ?? 0) : 0,
      deferredReadyAt: this.deferredNextAt.get(laneKey) ?? 0,
    })
    if (!pick) {
      this.considerWake(wakeAt)
      return
    }
    const now = context.now
    this.lastWasPriority.set(laneKey, pick.group === 'priority')
    if (pick.group === 'deferred')
      this.deferredNextAt.set(laneKey, now + DEFER_MIN_MS)
    if (pick.group === 'rest' && view.spread) {
      const remaining = (view.byLane.get(laneKey) ?? []).filter(
        (link) =>
          link.tier !== 'scope' &&
          link.lastCheckedAt !== null &&
          link.sourceId !== pick.sourceId &&
          linkPending(link, view.cycle.startedAt),
      ).length
      this.restNextAt.set(
        laneKey,
        now +
          restPaceMs({
            now,
            cycleStart: view.cycle.startedAt,
            cycleMs: context.intervalMs,
            remaining,
            floorMs: Math.max(lane.minGapMs, context.floorMs),
          }),
      )
    }
    const link = view.links.find((item) => item.sourceId === pick.sourceId)
    this.runCycleCheck(
      {
        sourceId: pick.sourceId,
        knifeId:
          link?.knifeId ??
          context.candidates.find(
            (candidate) => candidate.sourceId === pick.sourceId,
          )?.knifeId ??
          '',
        laneKey,
      },
      {
        trigger:
          availability.state === 'probe'
            ? 'probe'
            : pick.group === 'deferred' || pick.fix
              ? 'retry'
              : 'scheduled',
        fix: pick.fix,
      },
      view,
      context,
    )
  }

  /**
   * AI's turn: the first problem page (What to monitor first) at a store
   * that is free and ready, one try per page and cycle.
   */
  private startFix(view: PassCycle, context: PassContext) {
    const order = new Map(
      view.links.map((link) => [
        link.sourceId,
        link.tier === 'scope'
          ? link.order
          : view.cycle.knifeIds.length + link.order,
      ]),
    )
    const problems = view.problems
      .filter((task) => !this.fixTried.has(task.sourceId!))
      .sort(
        (a, b) =>
          (order.get(a.sourceId!) ?? Infinity) -
            (order.get(b.sourceId!) ?? Infinity) || a.sourceId! - b.sourceId!,
      )
    for (const task of problems) {
      if (this.laneBusy(task.laneKey)) continue
      const pause = this.holdFor(task.laneKey, context)
      if (pause !== null && pause > context.now) continue
      const availability = laneAvailability(
        context.laneFor(task.laneKey),
        context.now,
      )
      if (
        availability.state === 'waiting' ||
        availability.state === 'cooling'
      ) {
        this.considerWake(availability.until)
        continue
      }
      this.fixTried.add(task.sourceId!)
      this.runCycleCheck(
        {
          sourceId: task.sourceId!,
          knifeId: task.knifeId,
          laneKey: task.laneKey,
        },
        {
          trigger: availability.state === 'probe' ? 'probe' : 'retry',
          fix: true,
        },
        view,
        context,
      )
      return
    }
  }

  /**
   * Runs one check of the cycle and records what it means for the retry
   * list: read, deferred (10–15 minutes later), or a problem for AI.
   */
  private runCycleCheck(
    link: { sourceId: number; knifeId: string; laneKey: string },
    options: { trigger: CheckTrigger; fix: boolean },
    view: PassCycle,
    context: PassContext,
  ) {
    if (options.fix && aiConfigured(context.settings.ai))
      liftAiWait(link.sourceId)
    void this.track(
      this.runCheck(
        link.sourceId,
        link.laneKey,
        options.trigger,
        context.laneFor(link.laneKey),
        context,
        { mode: options.fix ? 'fix' : 'read', fix: options.fix },
      ).then(async (summary) => {
        if (summary === null) this.setAside.add(link.sourceId)
        const verdict = classifyCheck(summary)
        if (verdict === 'none' || !this.ownsLease()) return
        const now = this.deps.now()
        await recordCheckVerdict({
          ...link,
          cycleId: view.cycle.id,
          verdict,
          reason: retryReasonFor(summary),
          error: summary?.status === 'done' ? summary.errorCode : null,
          // AI's try is the last one in this cycle.
          dueAt:
            verdict === 'defer' && !options.fix
              ? deferredDueAt(now, this.deps.random)
              : null,
          maxTries: DEFER_MAX_TRIES,
          now,
          generation: context.generation,
        }).catch((error) => {
          if (!isVaultError(error))
            reportServerError(error, 'price-monitor/retry')
        })
      }),
    )
  }

  /** Check all now: a new cycle starts now, over every monitored knife. */
  async startCycleNow(): Promise<Round> {
    const settings = getSettings().priceMonitoring
    const now = this.deps.now()
    const cycle = await startCycle({
      settings,
      trigger: 'manual',
      intervalMs: frequencyMs(settings.schedule),
      searches: discoveryActive(settings) && now >= this.discoveryNotBefore,
      now,
      replace: true,
    })
    // Runs here even where checks are not scheduled (see runPass()).
    this.start({ scheduled: false })
    return cycle!
  }

  // ---------------------------------------------------- checks, searches

  /**
   * An Other stores search at the store when its turn has come: knives in
   * What to monitor first, then never searched, then the longest waiting.
   */
  private startSearchIfDue(
    store: OtherStoreId,
    laneKey: string,
    view: PassCycle,
    context: PassContext,
  ): boolean {
    const pause = this.holdFor(laneKey, context)
    if (pause === Number.POSITIVE_INFINITY) return false
    const lane = context.laneFor(laneKey)
    const availability = discoveryAvailability(lane, context.now, {
      floorMs: context.floorMs,
      pauseUntil: pause,
      storeGapMs: DISCOVERY_STORES[store].searchGapMs,
      lastSearchAt: this.lastSearchAt(store),
    })
    if (availability.state === 'waiting' || availability.state === 'cooling') {
      this.considerWake(availability.until)
      return false
    }
    const due = this.dueSearchesAt(store, context).filter(
      (id) => !this.searchedInCycle.has(`${store}:${id}`),
    )
    const knifeId = pickLaneSearch(due, view.wishlistOrder)
    if (!knifeId) return false
    this.searchedInCycle.add(`${store}:${knifeId}`)
    context.dueSearches.set(
      store,
      due.filter((id) => id !== knifeId),
    )
    void this.track(this.runSearch(store, knifeId, lane, context))
    return true
  }

  private dueSearchesAt(store: OtherStoreId, context: PassContext): string[] {
    const cached = context.dueSearches.get(store)
    if (cached) return cached
    const config = DISCOVERY_STORES[store]
    const due = readDiscoveryQueue(getLocalDb(), {
      settings: context.settings,
      store,
      marketplace: config.marketplace,
      laneKey: config.laneKey,
      now: context.now,
      limit: Number.MAX_SAFE_INTEGER,
    })
    context.dueSearches.set(store, due)
    return due
  }

  private startManualCheck(
    sourceId: number,
    laneKey: string,
    trigger: CheckTrigger,
    context: PassContext,
  ) {
    void this.track(
      this.runCheck(
        sourceId,
        laneKey,
        trigger,
        context.laneFor(laneKey),
        context,
        { mode: 'fix', fix: false },
      ).then(async (summary) => {
        // A page read on request leaves the retry list.
        if (classifyCheck(summary) !== 'ok' || !this.ownsLease()) return
        const knifeId =
          context.candidates.find(
            (candidate) => candidate.sourceId === sourceId,
          )?.knifeId ?? ''
        await recordCheckVerdict({
          sourceId,
          knifeId,
          laneKey,
          cycleId: null,
          verdict: 'ok',
          reason: 'failed',
          error: null,
          dueAt: null,
          maxTries: DEFER_MAX_TRIES,
          now: this.deps.now(),
          generation: context.generation,
        }).catch(() => {})
      }),
    )
  }

  /**
   * One price check at a store, with the store's pacing updated from how it
   * answered. Resolves with the check's summary, or null when it threw. An
   * AI fix is cut off after FIX_BUDGET_MS.
   */
  private runCheck(
    sourceId: number,
    laneKey: string,
    trigger: CheckTrigger,
    lane: LaneState,
    context: PassContext,
    options: { mode: CheckMode; fix: boolean },
  ): Promise<CheckSummary | null> {
    this.inFlight.set(laneKey, {
      sourceId,
      laneKey,
      trigger,
      startedAt: this.deps.now(),
      fix: options.fix,
    })
    const controller = new AbortController()
    this.controllers.add(controller)
    const budget = options.fix
      ? this.deps.setTimer(() => controller.abort(), FIX_BUDGET_MS)
      : null
    return (async () => {
      try {
        const summary = await this.deps.check(sourceId, {
          trigger,
          intervalMs: context.intervalMs,
          signal: controller.signal,
          mode: options.mode,
        })
        if (summary.status !== 'done' || controller.signal.aborted)
          return summary
        if (!this.ownsLease()) return summary
        const current = readLaneStates(getLocalDb()).get(laneKey) ?? lane
        // The store's next request waits its minimum gap.
        const update = applyLaneOutcome(
          normalizeLane(current, context.settings.pacing),
          {
            kind: summary.laneOutcome,
            durationMs: summary.durationMs,
            retryAfterMs: summary.retryAfterMs,
          },
          {
            now: this.deps.now(),
            gapMs: Math.max(lane.minGapMs, context.floorMs),
            floorMs: context.floorMs,
            random: this.deps.random,
          },
        )
        await writeLaneState(update.lane, context.generation)
        if (update.clearCookies)
          await clearBrowserState(laneKey).catch(() => {})
        return summary
      } catch (error) {
        if (!isVaultError(error))
          reportServerError(error, 'price-monitor/check')
        return null
      } finally {
        if (budget !== null) this.deps.clearTimer(budget)
        this.controllers.delete(controller)
        this.inFlight.delete(laneKey)
        this.wake(0)
      }
    })()
  }

  /**
   * One Other stores search at a store. It counts as a request at that store
   * for pacing and the circuit breaker. Resolves with the search's summary,
   * or null when it threw.
   */
  private runSearch(
    store: OtherStoreId,
    knifeId: string,
    lane: LaneState,
    context: PassContext,
  ): Promise<DiscoverySummary | null> {
    const { discover } = this.deps
    const laneKey = DISCOVERY_STORES[store].laneKey
    if (!discover) return Promise.resolve(null)
    const controller = new AbortController()
    this.controllers.add(controller)
    // The store's normal gap: the search gap only spaces its searches
    // (discoveryAvailability), never its price checks.
    const gapMs = Math.max(lane.minGapMs, context.floorMs)
    const run = (async (): Promise<DiscoverySummary | null> => {
      try {
        const summary = await discover(knifeId, {
          signal: controller.signal,
          store,
          canWrite: this.ownsLease,
        })
        if (summary.status !== 'done' || controller.signal.aborted)
          return summary
        if (!this.ownsLease()) return summary
        if (summary.aiProblem)
          this.discoveryNotBefore = this.deps.now() + DISCOVERY_AI_PAUSE_MS
        const current = readLaneStates(getLocalDb()).get(laneKey) ?? lane
        const update = applyLaneOutcome(
          normalizeLane(current, context.settings.pacing),
          {
            kind: summary.laneOutcome,
            // A search's duration is mostly AI matching and browsing, not
            // the store answering slowly. Throttled, blocked and failed
            // searches still slow the store.
            durationMs: 0,
            retryAfterMs: summary.retryAfterMs,
          },
          {
            now: this.deps.now(),
            gapMs,
            floorMs: context.floorMs,
            random: this.deps.random,
          },
        )
        await writeLaneState(update.lane, context.generation)
        if (update.clearCookies)
          await clearBrowserState(laneKey).catch(() => {})
        return summary
      } catch (error) {
        this.discoveryNotBefore = this.deps.now() + DISCOVERY_AI_PAUSE_MS
        if (!isVaultError(error) && !controller.signal.aborted)
          reportServerError(error, 'price-monitor/discovery')
        return null
      } finally {
        this.searchedAt.set(store, this.deps.now())
        this.controllers.delete(controller)
        this.searches.delete(laneKey)
        this.wake(0)
      }
    })()
    this.searches.set(laneKey, run)
    return run
  }

  /**
   * When a store was last searched: saved with its result, or ended here
   * without one (a search that failed before saving still reached it).
   */
  private lastSearchAt(store: OtherStoreId): number | null {
    const saved = savedSearchAt(store)
    const here = this.searchedAt.get(store) ?? null
    return saved === null ? here : here === null ? saved : Math.max(saved, here)
  }

  /** Other stores: search again now (settings changed or Search again). */
  resetDiscoveryPause() {
    this.discoveryNotBefore = 0
    this.wake(0)
  }

  // --------------------------------------------------------------- AI

  /**
   * Starts the AI advisor in the background when it is due (daily, or after
   * a store with active sources blocked us twice within 24 hours; later
   * after failed runs). Never blocks the queue.
   */
  private maybeAdvise(
    settings: PriceMonitoringSettings,
    lanes: Iterable<LaneState>,
    activeLanes: ReadonlySet<string>,
    now: number,
  ) {
    if (this.advising || !this.deps.advise) return
    if (!aiConfigured(settings.ai) || !settings.ai.advisor) return
    if (now - this.lastAdvisorCheck < ADVISOR_CHECK_EVERY_MS) return
    this.lastAdvisorCheck = now
    const trigger = advisorDue({
      ...advisorHistory(),
      lanes,
      activeLanes,
      now,
    })
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
   * actions move knives forward or onto the retry list; the next pass picks
   * them up.
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
        ? readAgentEvents(database, lastRunAt, 0, null)
        : undefined
    const trigger = agentDue({
      settings,
      lastRunAt,
      now,
      events,
      failures: agentFailureStreak(database),
    })
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

  /** Resolves when nothing runs: no pass, check, search or AI run. */

  /** Resolves when nothing runs: no pass, check, search or AI run. */
  async idle(): Promise<void> {
    while (
      this.passing ||
      this.work.size ||
      this.advising ||
      this.supervising ||
      this.searches.size
    ) {
      await Promise.all([
        this.passing,
        this.advising,
        this.supervising,
        ...this.searches.values(),
        ...this.work,
      ]).catch(() => {})
    }
  }

  /**
   * Stops scheduling, cancels running checks and releases the lease. With
   * `timeoutMs` (server shutdown) it waits at most that long for running
   * work (an AI run cannot be cancelled) and releases the lease anyway;
   * that work then finds it no longer owns the lease and writes nothing.
   * A cycle in progress carries on where it was on the next start.
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
    this.cycleId = null
    this.lastWasPriority.clear()
    this.restNextAt.clear()
    this.deferredNextAt.clear()
    this.setAside.clear()
    this.fixTried.clear()
    this.searchedInCycle.clear()
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
  /** The store's current minimum gap between two requests. */
  gapMs: number
  readyAt: string | null
  circuit: 'closed' | 'open'
  cooldownUntil: string | null
  strategy: HostStrategy
  lastRequestAt: string | null
  checking: boolean
  /** On the retry list at this store (deferred and problems). */
  retries: number
  /** AI advice in force for this store, if any. */
  advice: {
    minGapMs: number | null
    pauseUntil: string | null
    quietHours: ActiveHours | null
    reason: string
    expiresAt: string
  } | null
}

/** Links of one part of the cycle, and how many it checked. */
export type CycleProgress = { links: number; done: number }

export type CycleStatus = {
  id: number
  trigger: RoundTrigger
  startedAt: string
  /** When the next scheduled cycle starts (Check all's cycle without scheduled checks ends once every link was checked). */
  endsAt: string
  /** What to monitor (the Wishlist) and the rest of the collection. */
  wishlist: CycleProgress
  collection: CycleProgress
  /** Checks a store asked to wait for, tried again 10–15 minutes later. */
  deferred: number
  /** Pages without a usable price, waiting for AI at the end of the cycle. */
  problems: number
  /** AI is set up: it works on the problems at the end of the cycle. */
  ai: boolean
  /** Every link was checked or the cycle's last tenth began: AI's turn. */
  aiTurn: boolean
  /** The problem page AI works on now, if any. */
  fixingSourceId: number | null
  /** Knives in the cycle. */
  knives: number
}

export type QueueSnapshot = {
  /** This server process runs the worker (scheduled or manual-only). */
  running: boolean
  scheduled: boolean
  enabled: boolean
  timeZone: string
  /** How long one cycle lasts. */
  frequencyMs: number
  /** Check now requests waiting. */
  waiting: number
  /** The cycle in progress, if any. */
  cycle: CycleStatus | null
  inFlight: Array<{
    sourceId: number
    laneKey: string
    trigger: CheckTrigger
    startedAt: string
    fix: boolean
  }>
  lanes: QueueLaneView[]
  /**
   * What to monitor: the scope kind and how many existing knives it covers
   * (null for the whole collection).
   */
  scope: { kind: PriceMonitorScopeKind; knives: number | null }
}

const iso = (value: number | null) =>
  value === null ? null : new Date(value).toISOString()

/** Queue and cycle state for the UI, read from SQLite plus this process. */
export function buildQueueSnapshot(now = Date.now()): QueueSnapshot {
  const worker = getPriceMonitorWorker()
  const database = getLocalDb()
  const settings = getSettings().priceMonitoring
  const candidates = readQueueCandidates(database, settings, now)
  const counts = scheduledCounts(candidates)
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
    if (candidate.priority >= 2) {
      manual.set(laneKey, (manual.get(laneKey) ?? 0) + 1)
      waiting += 1
    }
  }
  const retryTasks = readRetryTasks(database).filter(
    (task) => task.kind === 'check',
  )
  const retriesByLane = new Map<string, number>()
  for (const task of retryTasks)
    retriesByLane.set(task.laneKey, (retriesByLane.get(task.laneKey) ?? 0) + 1)
  const stored = readLaneStates(database)
  const advice = readActiveAdvice(database, now)
  const pausedLanes = new Set(
    candidates
      .filter((candidate) => candidate.storePaused && candidate.covered)
      .map((candidate) => candidate.laneKey),
  )
  const laneKeys = new Set([
    ...counts.keys(),
    ...manual.keys(),
    ...pausedLanes,
    ...retriesByLane.keys(),
  ])
  const adviceMs = adviceWindowMs(settings.schedule)
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
    const sourceCount = counts.get(laneKey) ?? 0
    const lane = effectiveLane(
      raw ?? defaultLaneState(laneKey, settings.pacing, now),
      settings.pacing,
      laneAdvice,
      now,
      { activeWindowMs: adviceMs, sourceCount },
    )
    const availability = laneAvailability(lane, now)
    return {
      laneKey,
      sources: covered.get(laneKey) ?? 0,
      slowed: slowed.get(laneKey) ?? 0,
      paused: pausedLanes.has(laneKey),
      manual: manual.get(laneKey) ?? 0,
      gapMs: Math.max(lane.minGapMs, laneFloorMs(settings.pacing)),
      readyAt: iso(lane.readyAt),
      circuit: availability.state === 'cooling' ? 'open' : 'closed',
      cooldownUntil:
        availability.state === 'cooling' ? iso(availability.until) : null,
      strategy: raw?.strategy ?? 'auto',
      lastRequestAt: iso(lane.lastRequestAt),
      checking:
        worker.inFlight.has(laneKey) ||
        checkingLanes.has(laneKey) ||
        worker.searches.has(laneKey),
      retries: retriesByLane.get(laneKey) ?? 0,
      advice: laneAdvice
        ? {
            // As applied: capped so the store's sources fit the interval.
            minGapMs:
              laneAdvice.minGapMs === null
                ? null
                : Math.min(
                    laneAdvice.minGapMs,
                    maxAdvisedGapMs({
                      activeWindowMs: adviceMs,
                      sourceCount,
                      floorMs: laneFloorMs(settings.pacing),
                    }),
                  ),
            pauseUntil: iso(laneAdvice.pauseUntil),
            quietHours: laneAdvice.quietHours,
            reason: laneAdvice.reason,
            expiresAt: new Date(laneAdvice.expiresAt).toISOString(),
          }
        : null,
    }
  })

  const current = readCurrentRound(database)
  let cycle: CycleStatus | null = null
  if (current) {
    const links = cycleLinks(
      current,
      { candidates, intervalMs, now, settings },
      new Set(),
    ).filter((link) => !link.resting)
    const progress = (tier: MonitorTier): CycleProgress => {
      const own = links.filter((link) => link.tier === tier)
      return {
        links: own.length,
        done: own.filter((link) => linkDone(link, current.startedAt)).length,
      }
    }
    const pending = links.filter(
      (link) => !linkDone(link, current.startedAt),
    ).length
    const fixing = [...worker.inFlight.values()].find((entry) => entry.fix)
    cycle = {
      id: current.id,
      trigger: current.trigger,
      startedAt: new Date(current.startedAt).toISOString(),
      endsAt: new Date(current.startedAt + intervalMs).toISOString(),
      wishlist: progress('scope'),
      collection: progress('collection'),
      deferred: retryTasks.filter((task) => task.dueAt !== null).length,
      problems: retryTasks.filter((task) => task.dueAt === null).length,
      ai: aiConfigured(settings.ai),
      aiTurn:
        aiConfigured(settings.ai) &&
        (pending === 0 ||
          now >= current.startedAt + intervalMs * (1 - AI_RESERVE_SHARE)),
      fixingSourceId: fixing?.sourceId ?? null,
      knives: current.knifeIds.length,
    }
  }
  return {
    running: worker.started,
    scheduled: worker.scheduled,
    enabled: settings.enabled,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    frequencyMs: intervalMs,
    waiting,
    cycle,
    inFlight: [...worker.inFlight.values()].map((entry) => ({
      sourceId: entry.sourceId,
      laneKey: entry.laneKey,
      trigger: entry.trigger,
      startedAt: new Date(entry.startedAt).toISOString(),
      fix: entry.fix,
    })),
    lanes,
    scope: {
      kind: settings.scope.kind,
      knives: countMonitorScopeKnives(database, settings.scope),
    },
  }
}
