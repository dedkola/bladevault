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
  firstReadingAvailability,
  laneAvailability,
  laneFloorMs,
  type LaneAvailability,
  type LaneState,
} from '@/lib/price-monitor/lanes'
import {
  nextWakeAt,
  pickNextChecks,
  type QueueInput,
} from '@/lib/price-monitor/queue'
import {
  advancePass,
  advanceRound,
  deferUnreadChecks,
  dropStaleRetries,
  finishPass,
  finishRetry,
  finishRound,
  pruneRounds,
  readCurrentPass,
  readCurrentRound,
  readDueRetries,
  readLastPass,
  readLastRound,
  readRetryTasks,
  recordTaskResults,
  startPass,
  startRound,
  type CollectionPass,
  type RetryTask,
  type Round,
  type RoundTrigger,
  type TaskResult,
} from '@/lib/price-monitor/round-store'
import {
  COLLECTION_PASS_INTERVAL_MS,
  laneDecision,
  LANE_WAIT_MS,
  nextPassAt,
  nextRoundAt,
  planStep,
  retryableCheck,
  retryableSearch,
  retryDueTimes,
  tasksByLane,
  type RetryReason,
  type StepSource,
  type StepTask,
} from '@/lib/price-monitor/rounds'
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
import {
  isCollectionPassOn as collectionPassOn,
  type ActiveHours,
  type OtherStoreId,
  type PriceMonitoringSettings,
  type PriceMonitorScopeKind,
} from '@/lib/settings-shared'
import {
  getVaultAccessState,
  withVaultWrite,
  withVaultWriteSync,
} from '@/lib/vault-access'

/**
 * The price monitor. One worker per vault (a lease in SQLite). Scheduled
 * checks run in rounds (rounds.ts): every 6, 12 or 24 hours a round goes
 * through every monitored knife in order, checking all of one knife's stores
 * at the same time (and searching the Other stores where it has no listing
 * yet), then pausing before the next knife. What fails goes on the retry
 * list, which runs at random times before the next round. Check now runs
 * right away, at most one request per store at a time. Each store keeps its
 * own pacing: an adaptive minimum gap, Retry-After and a circuit breaker.
 * It runs in the Next.js server process and does not depend on any page
 * being open.
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
/** A knife watched closely waits at least this long between its steps. */
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
  /** Knives due for a search per store, read once per pass. */
  dueSearches: Map<OtherStoreId, Set<string>>
}

/**
 * One knife's step: its stores in parallel, each store's tasks one after
 * another. `round` steps go through the round; `priority` steps check links
 * moved forward (a new link, Check first, Cross-check); `focus` steps check
 * a knife watched closely; `pass` steps go through the collection pass in
 * the free time between rounds.
 */
type ActiveStep = {
  kind: 'round' | 'priority' | 'focus' | 'pass'
  knifeId: string
  roundId: number | null
  passId: number | null
  /** The round's (or pass's) cursor once this step is done. */
  nextCursor: number | null
  /** A `focus` step: how often the knife is watched. */
  focusIntervalMs: number | null
  pending: Map<string, StepTask[]>
  /** Since when the step waits for a store that is not ready yet. */
  waitingSince: Map<string, number>
  running: number
  results: TaskResult[]
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
 * gap is capped so the store's `sourceCount` checks still fit in one round
 * interval (maxAdvisedGapMs).
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

function checkRetryReason(
  summary: CheckSummary | null,
): { reason: RetryReason; error: string | null } | null {
  if (!summary) return { reason: 'failed', error: null }
  if (summary.status === 'skipped') return null
  if (summary.status === 'deferred')
    return { reason: 'failed', error: 'The check was interrupted.' }
  if (!retryableCheck(summary.outcome)) return null
  return {
    reason:
      summary.outcome === 'blocked'
        ? 'blocked'
        : summary.outcome === 'no_price'
          ? 'no_price'
          : 'failed',
    error: summary.errorCode,
  }
}

function searchRetryReason(
  summary: DiscoverySummary | null,
): { reason: RetryReason; error: string | null } | null {
  if (!summary) return { reason: 'failed', error: null }
  if (summary.status !== 'done' || !retryableSearch(summary.result)) return null
  return {
    reason: summary.result === 'blocked' ? 'blocked' : 'failed',
    error: null,
  }
}

/** The AI may work on the product again right away (Retry with AI). */
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
  /** The knife being checked right now, if any. */
  private step: ActiveStep | null = null
  /** The pause between knives ends here. */
  private nextStepAt = 0
  /** Knives watched closely that just had a step, until when. */
  private readonly focusHeld = new Map<string, number>()
  /**
   * The last step was a watched knife or a link moved forward: the round
   * (or the collection pass) gets the next turn.
   */
  private lastStepWasExtra = false

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

      const roundsOn = this.scheduled && settings.enabled
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
      if (roundsOn) {
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

      if (roundsOn) {
        await this.driveSteps(context)
        this.driveRetries(context)
      } else if (
        settings.enabled &&
        readCurrentRound(database)?.trigger === 'manual'
      ) {
        // Check all now where checks are not scheduled (dev server, or
        // BLADEVAULT_PRICE_MONITOR=off): its round runs here; the retry list
        // and the next round wait for scheduled monitoring.
        await this.driveSteps(context, { roundOnly: true })
      } else if (this.step) {
        // Monitoring was turned off: the knife being checked finishes.
        this.advanceStep(context)
        if (this.stepDone()) await this.finishStep(context)
      }

      if (this.wakeAt !== null)
        delay = Math.min(MAX_SLEEP_MS, Math.max(SECOND_MS, this.wakeAt - now))
    } catch (error) {
      if (!isVaultError(error)) reportServerError(error, 'price-monitor/worker')
    } finally {
      this.wake(delay)
    }
  }

  // ----------------------------------------------------------- rounds

  /**
   * Starts a round when one is due, then works through steps: links moved
   * forward and knives watched closely take turns with the round's next
   * knife (or the collection pass), so they can never hold the round up.
   * Each step is followed by the pause between knives. When the round's
   * last knife is done, the round ends and its retry list is spread out.
   */
  private async driveSteps(
    context: PassContext,
    options: { roundOnly?: boolean } = {},
  ): Promise<void> {
    const database = getLocalDb()
    let round = readCurrentRound(database)
    if (!round && !options.roundOnly) {
      const last = readLastRound(database)
      const due = nextRoundAt(last, context.intervalMs, context.now)
      if (due !== null && due <= context.now)
        round = await this.beginRound('scheduled', context)
      else this.considerWake(due)
    }

    if (this.step) {
      this.advanceStep(context)
      if (!this.stepDone()) return
      await this.finishStep(context)
    }
    if (context.now < this.nextStepAt) {
      this.considerWake(this.nextStepAt)
      return
    }
    const extraStep = () =>
      options.roundOnly
        ? null
        : (this.priorityStep(context) ?? this.focusStep(context))
    const regularStep = async () => {
      const next = round ? await this.roundStep(round, context) : null
      // Free time: no round running (or the round just ended). The round
      // always comes first; the pass waits at its cursor until it is done.
      if (next || options.roundOnly || readCurrentRound(database)) return next
      return this.passStep(context)
    }
    const step = this.lastStepWasExtra
      ? ((await regularStep()) ?? extraStep())
      : (extraStep() ?? (await regularStep()))
    if (!step) return
    this.lastStepWasExtra = step.kind === 'priority' || step.kind === 'focus'
    this.step = step
    this.advanceStep(context)
    if (this.stepDone()) await this.finishStep(context)
  }

  private beginRound(
    trigger: RoundTrigger,
    context: PassContext,
  ): Promise<Round | null> {
    return startRound({
      settings: context.settings,
      trigger,
      intervalMs: context.intervalMs,
      pauseMs: context.floorMs,
      searches: context.searches,
      now: context.now,
      generation: context.generation,
    })
  }

  private dueSearchesAt(
    store: OtherStoreId,
    context: PassContext,
  ): Set<string> {
    const cached = context.dueSearches.get(store)
    if (cached) return cached
    const config = DISCOVERY_STORES[store]
    const due = new Set(
      readDiscoveryQueue(getLocalDb(), {
        settings: context.settings,
        store,
        marketplace: config.marketplace,
        laneKey: config.laneKey,
        now: context.now,
        limit: Number.MAX_SAFE_INTEGER,
      }),
    )
    context.dueSearches.set(store, due)
    return due
  }

  private newStep(
    kind: ActiveStep['kind'],
    knifeId: string,
    tasks: readonly StepTask[],
    position: { id: number; nextCursor: number } | null = null,
  ): ActiveStep {
    return {
      kind,
      knifeId,
      roundId: kind === 'round' ? (position?.id ?? null) : null,
      passId: kind === 'pass' ? (position?.id ?? null) : null,
      nextCursor: position?.nextCursor ?? null,
      focusIntervalMs: null,
      pending: tasksByLane(tasks),
      waitingSince: new Map(),
      running: 0,
      results: [],
    }
  }

  /** Links moved forward: a new link, the supervisor's Check first or Cross-check. */
  private priorityStep(context: PassContext): ActiveStep | null {
    const first = context.candidates
      .filter((candidate) => candidate.scheduled && candidate.priority === 1)
      .sort((a, b) => a.sourceId - b.sourceId)[0]
    if (!first) return null
    const tasks = context.candidates
      .filter(
        (candidate) =>
          candidate.knifeId === first.knifeId &&
          candidate.scheduled &&
          candidate.priority === 1,
      )
      .map((candidate): StepTask => ({
        kind: 'check',
        sourceId: candidate.sourceId,
        laneKey: candidate.laneKey,
      }))
    return this.newStep('priority', first.knifeId, tasks)
  }

  /**
   * A knife watched closely gets its due links checked at its own pace, all
   * stores at once. A link the step cannot read waits for the knife's next
   * watch time (finishStep), so the knife is not due again right away.
   */
  private focusStep(context: PassContext): ActiveStep | null {
    const held = (knifeId: string) =>
      (this.focusHeld.get(knifeId) ?? 0) > context.now
    const isDue = (candidate: CandidateRow) =>
      candidate.nextCheckAt === null || candidate.nextCheckAt <= context.now
    const watched = context.candidates.filter(
      (candidate) =>
        candidate.scheduled &&
        candidate.focusIntervalMs !== null &&
        !restingOutOfStock(candidate, context),
    )
    const due = watched
      .filter((candidate) => !held(candidate.knifeId) && isDue(candidate))
      .sort((a, b) => (a.nextCheckAt ?? 0) - (b.nextCheckAt ?? 0))[0]
    if (!due) {
      const next = watched.map((candidate) =>
        Math.max(
          candidate.nextCheckAt ?? context.now,
          this.focusHeld.get(candidate.knifeId) ?? 0,
        ),
      )
      if (next.length) this.considerWake(Math.min(...next))
      return null
    }
    this.focusHeld.set(due.knifeId, context.now + FOCUS_MIN_GAP_MS)
    const tasks = watched
      .filter(
        (candidate) => candidate.knifeId === due.knifeId && isDue(candidate),
      )
      .map((candidate): StepTask => ({
        kind: 'check',
        sourceId: candidate.sourceId,
        laneKey: candidate.laneKey,
      }))
    const step = this.newStep('focus', due.knifeId, tasks)
    step.focusIntervalMs = due.focusIntervalMs
    return step
  }

  /**
   * The round's next knife with something to do. Knives with nothing due
   * (every link checked this round, nothing to search) are passed without
   * a pause. After the last knife the round ends.
   */
  private async roundStep(
    round: Round,
    context: PassContext,
  ): Promise<ActiveStep | null> {
    let cursor = round.cursor
    while (cursor < round.knifeIds.length) {
      const knifeId = round.knifeIds[cursor]
      const tasks = this.knifeTasks(knifeId, round.startedAt, context)
      cursor += 1
      if (tasks.length)
        return this.newStep('round', knifeId, tasks, {
          id: round.id,
          nextCursor: cursor,
        })
    }
    if (cursor !== round.cursor)
      await advanceRound({
        roundId: round.id,
        cursor,
        generation: context.generation,
      })
    const next = Math.max(context.now, round.startedAt + context.intervalMs)
    await finishRound({
      roundId: round.id,
      now: context.now,
      nextRoundAt: next,
      random: this.deps.random,
      generation: context.generation,
    })
    this.considerWake(next)
    return null
  }

  /**
   * The collection pass's next knife with something to do, when the pass is
   * on and free time has come: a pass starts at most once a day and goes
   * through the knives outside What to monitor, one step at a time like a
   * round. A knife that moved into What to monitor meanwhile is passed.
   * After the last knife the pass ends.
   */
  private async passStep(context: PassContext): Promise<ActiveStep | null> {
    const database = getLocalDb()
    let pass: CollectionPass | null = readCurrentPass(database)
    if (!collectionPassOn(context.settings)) {
      if (pass)
        await finishPass({
          passId: pass.id,
          now: context.now,
          generation: context.generation,
        })
      return null
    }
    if (!pass) {
      const due = nextPassAt(readLastPass(database), context.now)
      if (due === null || due > context.now) {
        this.considerWake(due)
        return null
      }
      pass = await startPass({
        settings: context.settings,
        pauseMs: context.floorMs,
        searches: context.searches,
        now: context.now,
        generation: context.generation,
      })
      if (!pass) return null
    }
    let cursor = pass.cursor
    while (cursor < pass.knifeIds.length) {
      const knifeId = pass.knifeIds[cursor]
      const tasks = this.knifeTasks(
        knifeId,
        pass.startedAt,
        context,
        'collection',
      )
      cursor += 1
      if (tasks.length)
        return this.newStep('pass', knifeId, tasks, {
          id: pass.id,
          nextCursor: cursor,
        })
    }
    if (cursor !== pass.cursor)
      await advancePass({
        passId: pass.id,
        cursor,
        generation: context.generation,
      })
    await finishPass({
      passId: pass.id,
      now: context.now,
      generation: context.generation,
    })
    this.considerWake(
      Math.max(context.now, pass.startedAt + COLLECTION_PASS_INTERVAL_MS),
    )
    return null
  }

  /**
   * One knife's tasks in a round or pass that started at `startedAt`. In
   * the collection pass only the knife's collection-tier links count, so a
   * knife that moved into What to monitor is left to the rounds.
   */
  private knifeTasks(
    knifeId: string,
    startedAt: number,
    context: PassContext,
    tier?: MonitorTier,
  ): StepTask[] {
    const own = context.candidates.filter(
      (candidate) => candidate.knifeId === knifeId,
    )
    if (tier && own.some((candidate) => candidate.tier !== tier)) return []
    const sources: StepSource[] = own.map((candidate) => ({
      sourceId: candidate.sourceId,
      laneKey: candidate.laneKey,
      scheduled: candidate.scheduled,
      checkedThisRound:
        candidate.lastCheckedAt !== null &&
        candidate.lastCheckedAt >= startedAt,
      restingOutOfStock: restingOutOfStock(candidate, context),
    }))
    const searches = context.searches
      ? enabledDiscoveryStores(context.settings)
          .filter((store) => this.dueSearchesAt(store, context).has(knifeId))
          .map((store) => ({ store, laneKey: DISCOVERY_STORES[store].laneKey }))
      : []
    return planStep({ sources, searches })
  }

  private taskAvailability(
    task: StepTask,
    context: PassContext,
  ): LaneAvailability {
    const lane = context.laneFor(task.laneKey)
    const advice = context.advice.get(task.laneKey)
    // Advised quiet hours hold scheduled work at the store.
    if (inQuietHours(advice, new Date(context.now)))
      return { state: 'cooling', until: Number.POSITIVE_INFINITY }
    const pauseUntil =
      advice && advice.expiresAt > context.now ? advice.pauseUntil : null
    if (task.kind === 'search')
      return discoveryAvailability(lane, context.now, {
        floorMs: context.floorMs,
        pauseUntil,
        storeGapMs: DISCOVERY_STORES[task.store].searchGapMs,
        lastSearchAt: this.lastSearchAt(task.store),
      })
    if (task.followUp)
      return firstReadingAvailability(lane, context.now, pauseUntil)
    return laneAvailability(lane, context.now)
  }

  /**
   * Starts what the current step can start: at every store with work left
   * and nothing running, its next task when the store is ready, a short
   * wait when it soon will be, else the store's tasks go on the retry list.
   */
  private advanceStep(context: PassContext) {
    const step = this.step
    if (!step) return
    for (const [laneKey, tasks] of [...step.pending]) {
      if (!tasks.length) {
        step.pending.delete(laneKey)
        continue
      }
      if (this.laneBusy(laneKey)) continue
      const task = tasks[0]
      const since = step.waitingSince.get(laneKey) ?? context.now
      const decision = laneDecision(
        this.taskAvailability(task, context),
        context.now,
        LANE_WAIT_MS - (context.now - since),
      )
      if (decision.action === 'wait') {
        step.waitingSince.set(laneKey, since)
        this.considerWake(decision.until)
        continue
      }
      step.waitingSince.delete(laneKey)
      if (decision.action === 'skip') {
        for (const skipped of tasks)
          step.results.push({
            task: skipped,
            knifeId: step.knifeId,
            retry: { reason: 'store_not_ready', error: null },
          })
        step.pending.delete(laneKey)
        continue
      }
      tasks.shift()
      if (!tasks.length) step.pending.delete(laneKey)
      step.running += 1
      this.runStepTask(step, task, context)
    }
  }

  private runStepTask(step: ActiveStep, task: StepTask, context: PassContext) {
    const lane = context.laneFor(task.laneKey)
    const done = (retry: TaskResult['retry']) => {
      step.results.push({ task, knifeId: step.knifeId, retry })
      step.running -= 1
      this.wake(0)
    }
    if (task.kind === 'check') {
      const trigger: CheckTrigger =
        lane.circuit === 'open' ? 'probe' : 'scheduled'
      void this.track(
        this.runCheck(task.sourceId, task.laneKey, trigger, lane, context).then(
          (summary) => done(checkRetryReason(summary)),
        ),
      )
      return
    }
    void this.track(
      this.runSearch(task.store, step.knifeId, lane, context).then(
        (summary) => {
          // A listing the search just found gets its first price in this
          // step, at the same store.
          if (
            summary?.status === 'done' &&
            summary.result === 'found' &&
            summary.sourceId !== null
          )
            step.pending.set(task.laneKey, [
              {
                kind: 'check',
                sourceId: summary.sourceId,
                laneKey: task.laneKey,
                followUp: true,
              },
              ...(step.pending.get(task.laneKey) ?? []),
            ])
          done(searchRetryReason(summary))
        },
      ),
    )
  }

  private stepDone(): boolean {
    return (
      this.step !== null && this.step.pending.size === 0 && !this.step.running
    )
  }

  /**
   * Saves what the step did, moves the round on and starts the pause before
   * the next knife. Outside a round, what failed is retried at a random time
   * before the next round.
   */
  private async finishStep(context: PassContext) {
    const step = this.step
    if (!step) return
    this.step = null
    const now = this.deps.now()
    this.nextStepAt = now + context.floorMs
    this.considerWake(this.nextStepAt)
    if (!this.ownsLease()) return
    const results = step.results.flatMap((result): TaskResult[] => {
      const notReady = result.retry?.reason === 'store_not_ready'
      // A watched knife's link its store had no time for waits for the
      // knife's next watch time (below), not on the retry list.
      if (step.kind === 'focus' && notReady) return []
      // The collection pass retries only stores that were not ready: the
      // next pass reads what failed again, so stores get no extra requests.
      if (step.kind === 'pass' && !notReady) return [{ ...result, retry: null }]
      return [result]
    })
    if (step.kind === 'focus' && step.focusIntervalMs !== null)
      await deferUnreadChecks({
        sourceIds: step.results.flatMap(({ task }) =>
          task.kind === 'check' ? [task.sourceId] : [],
        ),
        until: now + step.focusIntervalMs,
        now,
        generation: context.generation,
      })
    let dueAt: number | null = null
    if (step.roundId === null && results.some((result) => result.retry)) {
      const last = readLastRound(getLocalDb())
      dueAt = retryDueTimes({
        count: 1,
        roundEnd: now,
        nextRoundAt:
          nextRoundAt(last, context.intervalMs, now) ??
          now + context.intervalMs,
        random: this.deps.random,
      })[0]
    }
    await recordTaskResults({
      results,
      roundId: step.roundId,
      now,
      dueAt,
      generation: context.generation,
    })
    if (step.roundId !== null && step.nextCursor !== null)
      await advanceRound({
        roundId: step.roundId,
        cursor: step.nextCursor,
        generation: context.generation,
      })
    if (step.passId !== null && step.nextCursor !== null)
      await advancePass({
        passId: step.passId,
        cursor: step.nextCursor,
        generation: context.generation,
      })
  }

  /** Check all now: a round starts now unless one is running. */
  async startRoundNow(): Promise<Round | null> {
    const settings = getSettings().priceMonitoring
    const now = this.deps.now()
    const round = await startRound({
      settings,
      trigger: 'manual',
      intervalMs: frequencyMs(settings.schedule),
      pauseMs: laneFloorMs(settings.pacing),
      searches: discoveryActive(settings) && now >= this.discoveryNotBefore,
      now,
    })
    // Runs here even where checks are not scheduled (see pass()).
    this.start({ scheduled: false })
    return round
  }

  // ------------------------------------------------------- retry list

  /**
   * Runs the retry list items whose time has come, one per store at a time,
   * at stores the current step does not need. Checks may use AI right away;
   * searches run as usual. What fails again waits for the next round.
   */
  private driveRetries(context: PassContext) {
    const due = readDueRetries(getLocalDb(), context.now)
    if (!due.length) {
      const next = readRetryTasks(getLocalDb()).find(
        (task) => task.dueAt !== null,
      )
      this.considerWake(next?.dueAt ?? null)
      return
    }
    const stepLanes = new Set(this.step?.pending.keys() ?? [])
    const started = new Set<string>()
    const scheduled = new Set(
      context.candidates
        .filter((candidate) => candidate.scheduled)
        .map((candidate) => candidate.sourceId),
    )
    for (const task of due) {
      if (
        started.has(task.laneKey) ||
        stepLanes.has(task.laneKey) ||
        this.laneBusy(task.laneKey)
      )
        continue
      const obsolete =
        task.kind === 'check'
          ? task.sourceId === null || !scheduled.has(task.sourceId)
          : task.store === null ||
            !discoveryActive(context.settings, task.store)
      if (obsolete) {
        void this.track(
          finishRetry({
            key: task.key,
            ok: true,
            now: context.now,
            generation: context.generation,
          }).catch(() => {}),
        )
        continue
      }
      if (task.kind === 'search' && !context.searches) continue
      const availability =
        task.kind === 'check'
          ? laneAvailability(context.laneFor(task.laneKey), context.now)
          : this.taskAvailability(
              { kind: 'search', store: task.store!, laneKey: task.laneKey },
              context,
            )
      if (
        availability.state === 'waiting' ||
        availability.state === 'cooling'
      ) {
        this.considerWake(availability.until)
        continue
      }
      started.add(task.laneKey)
      this.runRetry(task, context)
    }
  }

  private runRetry(task: RetryTask, context: PassContext) {
    const lane = context.laneFor(task.laneKey)
    const finish = (retry: TaskResult['retry']) =>
      finishRetry({
        key: task.key,
        ok: retry === null,
        reason: retry?.reason,
        error: retry?.error ?? null,
        now: this.deps.now(),
        generation: context.generation,
      }).catch((error) => {
        if (!isVaultError(error))
          reportServerError(error, 'price-monitor/retry')
      })
    if (task.kind === 'check' && task.sourceId !== null) {
      const sourceId = task.sourceId
      if (aiConfigured(context.settings.ai)) liftAiWait(sourceId)
      const trigger: CheckTrigger = lane.circuit === 'open' ? 'probe' : 'retry'
      void this.track(
        this.runCheck(sourceId, task.laneKey, trigger, lane, context).then(
          (summary) => finish(checkRetryReason(summary)),
        ),
      )
      return
    }
    if (task.kind === 'search' && task.store)
      void this.track(
        this.runSearch(task.store, task.knifeId, lane, context).then(
          (summary) => finish(searchRetryReason(summary)),
        ),
      )
  }

  // ---------------------------------------------------- checks, searches

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
      ),
    )
  }

  /**
   * One price check at a store, with the store's pacing updated from how it
   * answered. Resolves with the check's summary, or null when it threw.
   */
  private runCheck(
    sourceId: number,
    laneKey: string,
    trigger: CheckTrigger,
    lane: LaneState,
    context: PassContext,
  ): Promise<CheckSummary | null> {
    this.inFlight.set(laneKey, {
      sourceId,
      laneKey,
      trigger,
      startedAt: this.deps.now(),
    })
    const controller = new AbortController()
    this.controllers.add(controller)
    return (async () => {
      try {
        const summary = await this.deps.check(sourceId, {
          trigger,
          intervalMs: context.intervalMs,
          signal: controller.signal,
        })
        if (summary.status !== 'done' || controller.signal.aborted)
          return summary
        if (!this.ownsLease()) return summary
        const current = readLaneStates(getLocalDb()).get(laneKey) ?? lane
        // Rounds space a store's requests by knife: the next one waits only
        // the store's minimum gap.
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
   * A round in progress resumes at its knife on the next start.
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
    this.step = null
    this.nextStepAt = 0
    this.focusHeld.clear()
    this.lastStepWasExtra = false
    this.started = false
    this.scheduled = false
    if (this.leaseHeld) {
      this.leaseHeld = false
      await releaseWorkerLease(this.owner).catch(() => {})
    }
  }

  /** The knife the round checks right now (Price Drops). */
  get currentStep(): { knifeId: string; kind: ActiveStep['kind'] } | null {
    return this.step
      ? { knifeId: this.step.knifeId, kind: this.step.kind }
      : null
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
  /** On the retry list at this store. */
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

export type RoundView = {
  id: number
  trigger: RoundTrigger
  startedAt: string
  /** Knives in the round, and how many are done. */
  knives: number
  done: number
  /** The knife being checked now, if any. */
  currentKnifeId: string | null
}

export type QueueSnapshot = {
  /** This server process runs the worker (scheduled or manual-only). */
  running: boolean
  scheduled: boolean
  enabled: boolean
  timeZone: string
  /** Time between two rounds. */
  frequencyMs: number
  /** Check now requests waiting. */
  waiting: number
  /** The round in progress, if any. */
  round: RoundView | null
  /** The last round that finished, if any. */
  lastRound: {
    id: number
    startedAt: string
    finishedAt: string
    knives: number
  } | null
  /** When the next round starts (null while one runs or checks are off). */
  nextRoundAt: string | null
  /** The retry list: items waiting for a time, and items with one. */
  retries: { waiting: number; scheduled: number; nextAt: string | null }
  inFlight: Array<{
    sourceId: number
    laneKey: string
    trigger: CheckTrigger
    startedAt: string
  }>
  lanes: QueueLaneView[]
  /**
   * What to monitor: the scope kind and how many existing knives it covers
   * (null for the whole collection).
   */
  scope: { kind: PriceMonitorScopeKind; knives: number | null }
  /**
   * The collection pass (knives outside What to monitor, in free time):
   * null while it is off. `knives`/`done` describe the running pass;
   * `nextAt` is when the next one may start (it still waits for free time).
   */
  collectionPass: {
    running: boolean
    /** A round runs, so the pass waits at its knife. */
    waiting: boolean
    knives: number
    done: number
    currentKnifeId: string | null
    lastFinishedAt: string | null
    nextAt: string | null
  } | null
}

const iso = (value: number | null) =>
  value === null ? null : new Date(value).toISOString()

/** Queue and round state for the UI, read from SQLite plus this process. */
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
  const retryTasks = readRetryTasks(database)
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
  const last = readLastRound(database)
  const finished = last && last.finishedAt !== null ? last : null
  const step = worker.currentStep
  const nextAt =
    settings.enabled && !current ? nextRoundAt(last, intervalMs, now) : null
  const pass = readCurrentPass(database)
  const lastPass = pass ? null : readLastPass(database)
  const collectionPass: QueueSnapshot['collectionPass'] = collectionPassOn(
    settings,
  )
    ? {
        running: pass !== null,
        waiting: pass !== null && current !== null,
        knives: pass?.knifeIds.length ?? 0,
        done: pass ? Math.min(pass.cursor, pass.knifeIds.length) : 0,
        currentKnifeId: step?.kind === 'pass' ? step.knifeId : null,
        lastFinishedAt: iso(lastPass?.finishedAt ?? null),
        nextAt:
          pass || !settings.enabled
            ? null
            : iso(Math.max(now, nextPassAt(lastPass, now) ?? now)),
      }
    : null
  return {
    running: worker.started,
    scheduled: worker.scheduled,
    enabled: settings.enabled,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    frequencyMs: intervalMs,
    waiting,
    round: current
      ? {
          id: current.id,
          trigger: current.trigger,
          startedAt: new Date(current.startedAt).toISOString(),
          knives: current.knifeIds.length,
          done: Math.min(current.cursor, current.knifeIds.length),
          currentKnifeId: step?.kind === 'round' ? step.knifeId : null,
        }
      : null,
    lastRound: finished
      ? {
          id: finished.id,
          startedAt: new Date(finished.startedAt).toISOString(),
          finishedAt: new Date(finished.finishedAt!).toISOString(),
          knives: finished.knifeIds.length,
        }
      : null,
    nextRoundAt: iso(nextAt),
    retries: {
      waiting: retryTasks.filter((task) => task.dueAt === null).length,
      scheduled: retryTasks.filter((task) => task.dueAt !== null).length,
      nextAt: iso(
        retryTasks.find((task) => task.dueAt !== null)?.dueAt ?? null,
      ),
    },
    inFlight: [...worker.inFlight.values()].map((entry) => ({
      sourceId: entry.sourceId,
      laneKey: entry.laneKey,
      trigger: entry.trigger,
      startedAt: new Date(entry.startedAt).toISOString(),
    })),
    lanes,
    scope: {
      kind: settings.scope.kind,
      knives: countMonitorScopeKnives(database, settings.scope),
    },
    collectionPass,
  }
}
