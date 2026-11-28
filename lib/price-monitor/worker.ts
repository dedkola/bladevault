import { randomUUID } from 'node:crypto'
import { getLocalDb } from '@/lib/local-db'
import { readActiveAdvice } from '@/lib/price-monitor/advice-store'
import {
  advisorDue,
  advisorHistory,
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
import { fetchCrawlDelay } from '@/lib/price-monitor/robots'
import { checkClockJump, monitorHoldMs } from '@/lib/price-monitor/power'
import {
  applyLaneOutcome,
  defaultLaneState,
  discoveryAvailability,
  laneAvailability,
  laneFloorMs,
  DURATION_SAMPLES,
  type LaneAvailability,
  type LaneState,
} from '@/lib/price-monitor/lanes'
import {
  nextWakeAt,
  pickNextChecks,
  type QueueInput,
} from '@/lib/price-monitor/queue'
import {
  dropStaleRetries,
  endRound,
  finishRetry,
  pruneRounds,
  readCurrentRound,
  readDueRetries,
  readLastRound,
  readRetryTasks,
  startRound,
  type RetryTask,
  type Round,
} from '@/lib/price-monitor/round-store'
import {
  effectiveLane,
  normalizeLane,
  readStorePlan,
  scheduledCounts,
  scheduledLinks,
  type QueueLink,
} from '@/lib/price-monitor/store-plan'
import {
  checkAllPending,
  FOCUS_SHARE,
  isDue,
  pickForStore,
  slotFractions,
  type PickKind,
} from '@/lib/price-monitor/store-queue'
import {
  adviceWindowMs,
  checkLoad,
  frequencyMs,
} from '@/lib/price-monitor/schedule'
import {
  acquireWorkerLease,
  ownsWorkerLease,
  pruneCheckLog,
  readLaneHealth,
  emptyLaneHealth,
  type LaneHealth,
  readLaneStates,
  readRobotsDue,
  readQueueCandidates,
  releaseWorkerLease,
  requestSourceChecks,
  resetStaleChecking,
  syncAllAutoSources,
  writeLaneState,
  writeRobotsDelay,
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
 * The price monitor. One worker per vault (a lease in SQLite). Every store
 * works through its own queue in parallel (store-queue.ts): a store checks
 * its next due link as soon as its own gap allows, so a slow store never
 * holds up a fast one. Each link's next check sits in its own slot of the
 * interval, so a store's checks spread over the day. Failed checks come
 * back on the engine's retry delays; the supervisor's Retry with AI uses
 * the retry list. Check now runs right away, at most one request per store
 * at a time. Each store keeps its own pacing: an adaptive minimum gap,
 * Retry-After and a circuit breaker. It runs in the Next.js server process
 * and does not depend on any page being open.
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
/** Nothing to search at a store: ask again after this. */
const DISCOVERY_IDLE_MS = 10 * MINUTE_MS
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
  /** A store's robots.txt Crawl-delay (ms), or null (robots.ts). */
  crawlDelay?: (pageUrl: string, signal: AbortSignal) => Promise<number | null>
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
  crawlDelay: (pageUrl, signal) => fetchCrawlDelay(pageUrl, signal),
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
}

function isVaultError(error: unknown): boolean {
  return error instanceof Error && error.name === 'VaultAccessError'
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
  /** The daily robots.txt read, one store at a time. */
  private readingRobots: Promise<unknown> | null = null
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
  /** Each store's last picks, for the watched knives' share (store-queue.ts). */
  private readonly recentPicks = new Map<string, PickKind[]>()
  /** Other stores with nothing to search: asked again after this. */
  private readonly searchIdleUntil = new Map<OtherStoreId, number>()

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

  /**
   * Reads robots.txt at stores not read in a day, one store at a time in
   * the background. Its Crawl-delay becomes the store's floor (lanes.ts).
   */
  private maybeReadRobots(generation: string, now: number) {
    const { crawlDelay } = this.deps
    if (!crawlDelay || this.readingRobots) return
    const due = readRobotsDue(getLocalDb(), now)
    if (!due.length) return
    const controller = new AbortController()
    this.controllers.add(controller)
    this.readingRobots = this.track(
      (async () => {
        try {
          for (const store of due) {
            if (controller.signal.aborted || !this.ownsLease()) return
            const delayMs = await crawlDelay(store.url, controller.signal)
            if (controller.signal.aborted || !this.ownsLease()) return
            await writeRobotsDelay(store.laneKey, delayMs, generation)
          }
        } catch (error) {
          if (!isVaultError(error) && !controller.signal.aborted)
            reportServerError(error, 'price-monitor/robots')
        } finally {
          this.controllers.delete(controller)
          this.readingRobots = null
        }
      })(),
    )
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
        // Stores are contacted only while scheduled monitoring runs.
        if (this.scheduled && settings.enabled)
          this.maybeReadRobots(access.generation, now)
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
        // The supervisor's retries first: they wait for their store's turn.
        this.driveRetries(context)
        await this.driveStores(context)
      } else if (
        settings.enabled &&
        readCurrentRound(database)?.trigger === 'manual'
      ) {
        // Check all now where checks are not scheduled (dev server, or
        // BLADEVAULT_PRICE_MONITOR=off): only its knives are checked here.
        await this.driveStores(context, { roundOnly: true })
      }

      if (this.wakeAt !== null)
        delay = Math.min(MAX_SLEEP_MS, Math.max(SECOND_MS, this.wakeAt - now))
    } catch (error) {
      if (!isVaultError(error)) reportServerError(error, 'price-monitor/worker')
    } finally {
      this.wake(delay)
    }
  }

  // ----------------------------------------------------------- stores

  /**
   * Every store works through its own queue (store-queue.ts), in parallel:
   * each free store starts its next due link, or an Other stores search,
   * as soon as its own gap allows. Check all only makes every monitored
   * link due; it ends once each of its knives was checked.
   */
  private async driveStores(
    context: PassContext,
    options: { roundOnly?: boolean } = {},
  ): Promise<void> {
    const round = readCurrentRound(getLocalDb())
    let links = this.storeLinks(context)
    if (round) {
      const pending = checkAllPending(round, links)
      if (!pending.size || context.now >= round.startedAt + round.intervalMs)
        await endRound({
          roundId: round.id,
          now: context.now,
          generation: context.generation,
        })
      if (options.roundOnly)
        links = links.filter((link) => pending.has(link.knifeId))
    } else if (options.roundOnly) return

    const byLane = new Map<string, QueueLink[]>()
    for (const link of links)
      byLane.set(link.laneKey, [...(byLane.get(link.laneKey) ?? []), link])
    const fractions = slotFractions(links)
    const laneKeys = new Set(byLane.keys())
    if (!options.roundOnly && context.searches)
      for (const store of enabledDiscoveryStores(context.settings))
        laneKeys.add(DISCOVERY_STORES[store].laneKey)

    for (const laneKey of laneKeys) {
      if (this.laneBusy(laneKey)) continue
      const own = byLane.get(laneKey) ?? []
      const recent = this.recentPicks.get(laneKey) ?? []
      const link = pickForStore(own, context.now, recent)
      const search =
        options.roundOnly || (link && recent.at(-1) === 'search')
          ? null
          : this.nextSearch(laneKey, context)
      if (search) {
        this.remember(laneKey, 'search')
        void this.track(
          this.runSearch(
            search.store,
            search.knifeId,
            context.laneFor(laneKey),
            context,
          ),
        )
        continue
      }
      if (!link) {
        const next = own
          .map((candidate) => candidate.nextCheckAt)
          .filter((at): at is number => at !== null)
        if (next.length) this.considerWake(Math.min(...next))
        continue
      }
      const availability = this.taskAvailability(
        { kind: 'check', sourceId: link.sourceId, laneKey },
        context,
      )
      if (
        availability.state === 'waiting' ||
        availability.state === 'cooling'
      ) {
        this.considerWake(availability.until)
        continue
      }
      this.remember(laneKey, link.focus ? 'focus' : 'other')
      void this.track(
        this.runCheck(
          link.sourceId,
          laneKey,
          availability.state === 'probe' ? 'probe' : 'scheduled',
          context.laneFor(laneKey),
          context,
          {
            intervalMs: link.baseIntervalMs,
            slotFraction: fractions.get(link.sourceId),
          },
        ),
      )
    }
  }

  /** The links scheduled monitoring checks, as the store queues see them. */
  private storeLinks(context: PassContext): QueueLink[] {
    return scheduledLinks(context.candidates, context)
  }

  private remember(laneKey: string, kind: PickKind) {
    const recent = [...(this.recentPicks.get(laneKey) ?? []), kind]
    this.recentPicks.set(laneKey, recent.slice(-FOCUS_SHARE * 2))
  }

  /**
   * The Other stores search a store runs next, when the store is ready for
   * one: What to monitor first, then the knife that waited longest.
   */
  private nextSearch(
    laneKey: string,
    context: PassContext,
  ): { store: OtherStoreId; knifeId: string } | null {
    if (!context.searches) return null
    for (const store of enabledDiscoveryStores(context.settings)) {
      const config = DISCOVERY_STORES[store]
      if (config.laneKey !== laneKey) continue
      if ((this.searchIdleUntil.get(store) ?? 0) > context.now) {
        this.considerWake(this.searchIdleUntil.get(store)!)
        continue
      }
      const availability = this.taskAvailability(
        { kind: 'search', store, laneKey },
        context,
      )
      if (
        availability.state === 'waiting' ||
        availability.state === 'cooling'
      ) {
        this.considerWake(availability.until)
        continue
      }
      const due = readDiscoveryQueue(getLocalDb(), {
        settings: context.settings,
        store,
        marketplace: config.marketplace,
        laneKey: config.laneKey,
        now: context.now,
        limit: Number.MAX_SAFE_INTEGER,
      })
      if (!due.length) {
        this.searchIdleUntil.set(store, context.now + DISCOVERY_IDLE_MS)
        this.considerWake(context.now + DISCOVERY_IDLE_MS)
        continue
      }
      const scope = new Set(
        context.candidates
          .filter((candidate) => candidate.tier === 'scope')
          .map((candidate) => candidate.knifeId),
      )
      return { store, knifeId: due.find((id) => scope.has(id)) ?? due[0] }
    }
    return null
  }

  private taskAvailability(
    task:
      | { kind: 'check'; sourceId: number; laneKey: string }
      | { kind: 'search'; store: OtherStoreId; laneKey: string },
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
    return laneAvailability(lane, context.now)
  }

  /** Check all now: every monitored link is due now, in knife order. */
  async startRoundNow(): Promise<Round | null> {
    const settings = getSettings().priceMonitoring
    const now = this.deps.now()
    const round = await startRound({
      settings,
      trigger: 'manual',
      intervalMs: frequencyMs(settings.schedule),
      searches: discoveryActive(settings) && now >= this.discoveryNotBefore,
      now,
    })
    // Runs here even where checks are not scheduled (see pass()).
    this.start({ scheduled: false })
    return round
  }

  // ------------------------------------------------------- retry list

  /**
   * Runs the retry list items whose time has come (the supervisor's Retry
   * with AI), one per store at a time, before the store's own queue. Checks
   * may use AI right away. Each item leaves the list after its run; what
   * fails again comes back on the source's own retry delays.
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
    const started = new Set<string>()
    const scheduled = new Set(
      context.candidates
        .filter((candidate) => candidate.scheduled)
        .map((candidate) => candidate.sourceId),
    )
    for (const task of due) {
      if (started.has(task.laneKey) || this.laneBusy(task.laneKey)) continue
      const obsolete =
        task.kind === 'check'
          ? task.sourceId === null || !scheduled.has(task.sourceId)
          : task.store === null ||
            !discoveryActive(context.settings, task.store)
      if (obsolete) {
        void this.track(
          finishRetry({
            key: task.key,
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
    const finish = () =>
      finishRetry({
        key: task.key,
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
          finish,
        ),
      )
      return
    }
    if (task.kind === 'search' && task.store)
      void this.track(
        this.runSearch(task.store, task.knifeId, lane, context).then(finish),
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
    schedule: { intervalMs?: number; slotFraction?: number } = {},
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
          intervalMs: schedule.intervalMs ?? context.intervalMs,
          slotFraction: schedule.slotFraction,
          signal: controller.signal,
        })
        if (summary.status !== 'done' || controller.signal.aborted)
          return summary
        if (!this.ownsLease()) return summary
        const current = readLaneStates(getLocalDb()).get(laneKey) ?? lane
        // The next request at the store waits its minimum gap; the slots
        // (store-queue.ts) spread the checks themselves.
        const update = applyLaneOutcome(
          normalizeLane(current, context.settings.pacing),
          {
            kind: summary.laneOutcome,
            durationMs: summary.durationMs,
            retryAfterMs: summary.retryAfterMs,
            suspect: summary.suspect,
            priced: summary.outcome === 'ok',
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
    this.recentPicks.clear()
    this.searchIdleUntil.clear()
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
  /** On the retry list at this store. */
  retries: number
  /** Scheduled links due now at this store. */
  due: number
  /** AI advice in force for this store, if any. */
  advice: {
    minGapMs: number | null
    pauseUntil: string | null
    quietHours: ActiveHours | null
    reason: string
    expiresAt: string
  } | null
  /** The store's robots.txt Crawl-delay, when it sets one. */
  robotsDelayMs: number | null
  /** The store's usual check time, once it has a few checks. */
  typicalMs: number | null
  /** Why the store is cooling down, when pages loaded without prices. */
  openReason: 'soft_block' | null
  /** What happened at the store in the last 24 hours. */
  last24h: LaneHealth
}

/** Check all now in progress. */
export type RoundView = {
  id: number
  trigger: 'scheduled' | 'manual'
  startedAt: string
  /** Knives in it, and how many were checked since it started. */
  knives: number
  done: number
}

export type QueueSnapshot = {
  /** This server process runs the worker (scheduled or manual-only). */
  running: boolean
  scheduled: boolean
  enabled: boolean
  timeZone: string
  /** How often each monitored link is checked. */
  frequencyMs: number
  /** Check now requests waiting. */
  waiting: number
  /** Scheduled links due now, waiting for their store's turn. */
  backlog: number
  /** Check all now in progress, if any. */
  round: RoundView | null
  /** The last Check all that finished, if any. */
  lastRound: {
    id: number
    startedAt: string
    finishedAt: string
    knives: number
  } | null
  /** The supervisor's Retry with AI: items waiting for a time, and with one. */
  retries: { waiting: number; scheduled: number; nextAt: string | null }
  inFlight: Array<{
    sourceId: number
    laneKey: string
    trigger: CheckTrigger
    startedAt: string
  }>
  lanes: QueueLaneView[]
  /**
   * Stores that cannot check every link within the interval at their pace:
   * `cycleMs` is how long one full pass over their links takes.
   */
  slowStores: Array<{ laneKey: string; links: number; cycleMs: number }>
  /**
   * What to monitor: the scope kind and how many existing knives it covers
   * (null for the whole collection).
   */
  scope: { kind: PriceMonitorScopeKind; knives: number | null }
  /**
   * The rest of the collection, checked at most once a day: null while it
   * is off. `done` knives had every link checked in the last 24 hours.
   */
  collectionPass: { knives: number; done: number } | null
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

  const health = readLaneHealth(database, now - DAY_MS)
  const lanes = [...laneKeys].sort().map((laneKey) => {
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
      circuit: (availability.state === 'cooling' ? 'open' : 'closed') as
        'open' | 'closed',
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
      robotsDelayMs: raw?.robotsDelayMs ?? null,
      typicalMs:
        raw && (raw.durationSamples ?? 0) >= DURATION_SAMPLES
          ? (raw.typicalMs ?? null)
          : null,
      openReason:
        availability.state === 'cooling' ? (lane.openReason ?? null) : null,
      last24h: health.get(laneKey) ?? emptyLaneHealth(),
    }
  })

  const plan = readStorePlan(database, settings, now)
  const current = readCurrentRound(database)
  const last = readLastRound(database)
  const finished = last && last.finishedAt !== null ? last : null
  const pending = current ? checkAllPending(current, plan.links) : null
  const collection = plan.links.filter((link) => link.tier === 'collection')
  const collectionKnives = new Set(collection.map((link) => link.knifeId))
  const staleCollection = new Set(
    collection
      .filter(
        (link) =>
          link.lastCheckedAt === null || now - link.lastCheckedAt > DAY_MS,
      )
      .map((link) => link.knifeId),
  )
  return {
    running: worker.started,
    scheduled: worker.scheduled,
    enabled: settings.enabled,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    frequencyMs: intervalMs,
    waiting,
    backlog: plan.backlog,
    round: current
      ? {
          id: current.id,
          trigger: current.trigger,
          startedAt: new Date(current.startedAt).toISOString(),
          knives: current.knifeIds.length,
          done: current.knifeIds.length - (pending?.size ?? 0),
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
    lanes: lanes.map((lane): QueueLaneView => ({
      ...lane,
      due: plan.links.filter(
        (link) => link.laneKey === lane.laneKey && isDue(link, now),
      ).length,
    })),
    slowStores: plan.slow.map((store) => ({
      laneKey: store.laneKey,
      links: store.links,
      cycleMs: store.cycleMs,
    })),
    scope: {
      kind: settings.scope.kind,
      knives: countMonitorScopeKnives(database, settings.scope),
    },
    collectionPass: collectionPassOn(settings)
      ? {
          knives: collectionKnives.size,
          done: collectionKnives.size - staleCollection.size,
        }
      : null,
  }
}
