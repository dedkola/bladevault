import {
  AiClientError,
  PLANNING_TIMEOUT_MS,
  requestJsonCompletion,
  type FetchLike,
} from '@/lib/price-monitor/ai-client'
import { aiConfigured } from '@/lib/price-monitor/ai'
import {
  finishAdvice,
  readAdvisorHistory,
  readAdvisorRows,
  startAdvice,
  type AdvisorRows,
} from '@/lib/price-monitor/advice-store'
import {
  laneFloorMs,
  storeFloorMs,
  MAX_MIN_GAP_MS,
  type LaneState,
} from '@/lib/price-monitor/lanes'
import {
  adviceWindowMs,
  frequencyMs,
  isWithinActiveHours,
} from '@/lib/price-monitor/schedule'
import { redactSecrets } from '@/lib/price-monitor/secret-registry'
import { readPriceAiKey } from '@/lib/price-monitor/secrets'
import { readLaneStates } from '@/lib/price-monitor/store'
import { getLocalDb } from '@/lib/local-db'
import { getSettings } from '@/lib/settings'
import type {
  ActiveHours,
  PriceMonitoringSettings,
} from '@/lib/settings-shared'
import { getVaultAccessState } from '@/lib/vault-access'

/**
 * The optional AI pacing advisor. Once a day, after a store blocked us twice
 * within 24 hours, or on request, it sends per-store statistics (store host
 * names only: no product URLs, knife names or keys) to the configured model
 * and applies its advice within hard bounds: it can only slow a store down,
 * pause it for up to 48 hours, keep it quiet for up to 12 hours a day or pin
 * it to the browser. It never speeds a store up, never shortens a circuit
 * breaker pause and never changes the user's schedule or parallelism. Advice
 * expires after 48 hours. Without AI, or when the call fails, the algorithm
 * in lanes.ts runs alone.
 */
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
export const ADVICE_TTL_MS = 48 * HOUR_MS
export const ADVISOR_INTERVAL_MS = DAY_MS
/** After repeated blocks, the advisor runs again at most this often. */
export const ADVISOR_BLOCKS_INTERVAL_MS = 6 * HOUR_MS
export const ADVISOR_STATS_DAYS = 7
/**
 * The last day of checks weighs more than the week before it: a store whose
 * checks all came through in this window gets no new throttling advice.
 */
export const ADVISOR_RECENT_MS = DAY_MS
/** Checks in the recent window before it counts as recovered. */
export const ADVISOR_RECENT_OK_CHECKS = 2
/** A planning task: the model may reason (REASONING_PURPOSES). */
export const ADVISOR_TIMEOUT_MS = PLANNING_TIMEOUT_MS
export const MAX_ADVISOR_LANES = 25
export const MAX_PAUSE_MINUTES = 48 * 60
export const MAX_QUIET_HOURS = 12
const MAX_REASON_LENGTH = 200

export type AdvisorTrigger = 'daily' | 'repeated_blocks' | 'manual'

// ------------------------------------------------------------ statistics

export type AdvisorLaneStats = {
  /** Store host name such as "vosteed.com" or "bladehq.com". */
  store: string
  sources: number
  checks: number
  /** Share of checks the store answered (with or without a price), 0–1. */
  successRate: number | null
  noPrice: number
  failed: number
  blocked: number
  aiUsed: number
  failureCodes: Record<string, number>
  latencyMsP50: number | null
  latencyMsP95: number | null
  /** Hours (server time) with at least one check. */
  byHour: Array<{ hour: number; checks: number; successRate: number }>
  currentGapSeconds: number
  floorSeconds: number
  circuit: 'open' | 'closed'
  /** Circuit openings in the last 24 hours. */
  recentOpenings: number
  /** The last ADVISOR_RECENT_MS: weigh these above the week's totals. */
  recent: {
    checks: number
    answered: number
    blocked: number
    failed: number
    /** Newest first, at most 5: ok, no_price, failed, blocked, … */
    lastOutcomes: string[]
  }
  /** The longest gap advice may set: every source still fits the interval. */
  maxGapSeconds: number
}

export type AdvisorInput = {
  now: string
  timeZone: string
  /** Hours between two price check rounds. */
  frequencyHours: number
  statsDays: number
  stores: AdvisorLaneStats[]
}

/**
 * The longest minimum gap advice may set at a store: its sources still fit
 * in one active window (80 %, as the spread in lanes.ts, leaving room for
 * the 20 % jitter), so advice can slow a store but never leave its sources
 * overdue. Never below the floor, never above MAX_MIN_GAP_MS.
 */
export function maxAdvisedGapMs(input: {
  activeWindowMs: number
  sourceCount: number
  floorMs: number
}): number {
  const fit =
    input.sourceCount > 0
      ? (input.activeWindowMs * 0.8) / input.sourceCount
      : MAX_MIN_GAP_MS
  return Math.round(Math.max(input.floorMs, Math.min(MAX_MIN_GAP_MS, fit)))
}

const ANSWERED = new Set(['ok', 'no_price'])

/**
 * Whether a store's recent checks all came through: enough of them in the
 * recent window, none failed or blocked, and its circuit closed. Pure.
 */
export function recentlyHealthy(
  stats: Pick<AdvisorLaneStats, 'recent' | 'circuit'>,
): boolean {
  return (
    stats.circuit === 'closed' &&
    stats.recent.checks >= ADVISOR_RECENT_OK_CHECKS &&
    stats.recent.answered === stats.recent.checks
  )
}

function percentile(sorted: readonly number[], fraction: number) {
  if (!sorted.length) return null
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  )
  return Math.round(sorted[index])
}

const round2 = (value: number) => Math.round(value * 100) / 100

/**
 * Aggregated per-store statistics for the advisor. Pure: built from rows
 * that only carry store keys, outcomes, codes, durations and times.
 */
export function buildAdvisorInput(input: {
  rows: AdvisorRows
  lanes: ReadonlyMap<string, LaneState>
  settings: PriceMonitoringSettings
  now: number
  timeZone: string
}): AdvisorInput {
  const { rows, settings, now } = input
  const laneKeys = new Set<string>([
    ...rows.daily.map((row) => row.laneKey),
    ...rows.checks.map((row) => row.laneKey),
  ])
  const stores: AdvisorLaneStats[] = []
  for (const laneKey of laneKeys) {
    const daily = rows.daily.find((row) => row.laneKey === laneKey)
    const checks = rows.checks.filter((row) => row.laneKey === laneKey)
    const total = daily?.checks ?? checks.length
    // A store without active sources (removed, or dropped from the app)
    // needs no pacing advice, whatever its old statistics say.
    if (!total || !(rows.sources.get(laneKey) ?? 0)) continue
    const answered = (daily?.ok ?? 0) + (daily?.noPrice ?? 0)
    const failureCodes: Record<string, number> = {}
    const hours = new Map<number, { checks: number; ok: number }>()
    const durations: number[] = []
    const recent = {
      checks: 0,
      answered: 0,
      blocked: 0,
      failed: 0,
      lastOutcomes: [] as string[],
    }
    // Rows come newest first.
    for (const check of checks) {
      if (Date.parse(check.startedAt) >= now - ADVISOR_RECENT_MS) {
        recent.checks += 1
        if (ANSWERED.has(check.outcome)) recent.answered += 1
        else if (check.outcome === 'blocked') recent.blocked += 1
        else if (check.outcome === 'failed') recent.failed += 1
        if (recent.lastOutcomes.length < 5)
          recent.lastOutcomes.push(check.outcome)
      }
      if (check.errorCode)
        failureCodes[check.errorCode] = (failureCodes[check.errorCode] ?? 0) + 1
      durations.push(check.durationMs)
      const hour = new Date(check.startedAt).getHours()
      const slot = hours.get(hour) ?? { checks: 0, ok: 0 }
      slot.checks += 1
      if (check.outcome === 'ok' || check.outcome === 'no_price') slot.ok += 1
      hours.set(hour, slot)
    }
    durations.sort((a, b) => a - b)
    const lane = input.lanes.get(laneKey)
    const floorMs = lane
      ? storeFloorMs(lane, laneFloorMs(settings.pacing))
      : laneFloorMs(settings.pacing)
    const sources = rows.sources.get(laneKey) ?? 0
    // Rounds check one knife at a time: a store's gap is its minimum gap.
    const gapMs = Math.max(lane?.minGapMs ?? floorMs, floorMs)
    const circuitOpen =
      lane?.circuit === 'open' && (lane.cooldownUntil ?? 0) > now
    stores.push({
      store: laneKey,
      sources,
      checks: total,
      successRate: daily ? round2(answered / total) : null,
      noPrice: daily?.noPrice ?? 0,
      failed: daily?.failed ?? 0,
      blocked: daily?.blocked ?? 0,
      aiUsed: daily?.aiUsed ?? 0,
      failureCodes,
      latencyMsP50: percentile(durations, 0.5),
      latencyMsP95: percentile(durations, 0.95),
      byHour: [...hours]
        .sort(([a], [b]) => a - b)
        .map(([hour, slot]) => ({
          hour,
          checks: slot.checks,
          successRate: round2(slot.ok / slot.checks),
        })),
      currentGapSeconds: Math.round(gapMs / 1000),
      floorSeconds: Math.round(floorMs / 1000),
      circuit: circuitOpen ? 'open' : 'closed',
      recentOpenings:
        lane && lane.cooldownUntil !== null && lane.cooldownUntil > now - DAY_MS
          ? lane.openCount
          : 0,
      recent,
      maxGapSeconds: Math.round(
        maxAdvisedGapMs({
          activeWindowMs: adviceWindowMs(settings.schedule),
          sourceCount: sources,
          floorMs,
        }) / 1000,
      ),
    })
  }
  stores.sort((a, b) => b.checks - a.checks || a.store.localeCompare(b.store))
  return {
    now: new Date(now).toISOString(),
    timeZone: input.timeZone,
    frequencyHours:
      Math.round((frequencyMs(settings.schedule) / HOUR_MS) * 10) / 10,
    statsDays: ADVISOR_STATS_DAYS,
    stores: stores.slice(0, MAX_ADVISOR_LANES),
  }
}

// --------------------------------------------------------------- advice

export type AppliedLaneAdvice = {
  laneKey: string
  /** Raises the store's minimum gap; never below the floor, at most 6 h. */
  minGapMs: number | null
  /** No scheduled checks before this time (at most 48 h ahead). */
  pauseUntil: string | null
  /** Daily hours without scheduled checks, at most 12 h. */
  quietHours: ActiveHours | null
  /** Only pinning to the browser is accepted; learning handles HTTP. */
  strategy: 'browser_first' | null
  reason: string
  /** What the safety bounds changed or dropped. */
  adjustments: string[]
}

export type AppliedAdvice = {
  createdAt: string
  expiresAt: string
  lanes: AppliedLaneAdvice[]
}

export type AdvisorLaneContext = {
  floorMs: number
  /** maxAdvisedGapMs for the store; MAX_MIN_GAP_MS when left out. */
  maxGapMs?: number
  /**
   * Its recent checks all came through (recentlyHealthy): throttling advice
   * (a longer gap, a pause, quiet hours) is dropped, a browser pin is kept.
   */
  recentOk?: boolean
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function readHours(value: unknown): [number, number] | null {
  if (Array.isArray(value) && value.length === 2)
    return [Number(value[0]), Number(value[1])]
  if (value && typeof value === 'object') {
    const record = value as { start?: unknown; end?: unknown }
    if (record.start !== undefined && record.end !== undefined)
      return [Number(record.start), Number(record.end)]
  }
  return null
}

/** Length of an [start, end) window in hours, wrapping midnight. */
function windowLength([start, end]: ActiveHours): number {
  return (end - start + 24) % 24 || 24
}

/**
 * The model's answer clamped to the safety bounds. Pure. Unknown stores,
 * speed-ups, long pauses and long quiet windows never get through.
 */
export function clampAdvice(
  output: unknown,
  context: {
    lanes: ReadonlyMap<string, AdvisorLaneContext>
    now: number
  },
): AppliedAdvice {
  const { now } = context
  const record =
    output && typeof output === 'object' && !Array.isArray(output)
      ? (output as { stores?: unknown; lanes?: unknown })
      : {}
  const entries = Array.isArray(record.stores)
    ? record.stores
    : Array.isArray(record.lanes)
      ? record.lanes
      : []
  const seen = new Set<string>()
  const lanes: AppliedLaneAdvice[] = []
  for (const entry of entries.slice(0, MAX_ADVISOR_LANES * 2)) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const laneKey =
      typeof item.store === 'string'
        ? item.store.trim().toLowerCase()
        : typeof item.laneKey === 'string'
          ? item.laneKey.trim().toLowerCase()
          : ''
    const lane = context.lanes.get(laneKey)
    if (!lane || seen.has(laneKey)) continue
    seen.add(laneKey)
    const adjustments: string[] = []

    const recentOk = lane.recentOk === true
    const maxGapMs = Math.min(lane.maxGapMs ?? MAX_MIN_GAP_MS, MAX_MIN_GAP_MS)
    let minGapMs: number | null = null
    const gapSeconds = finiteNumber(item.minGapSeconds)
    if (gapSeconds !== null && gapSeconds > 0 && recentOk) {
      adjustments.push('gap dropped: recent checks came through')
    } else if (gapSeconds !== null && gapSeconds > 0) {
      const requested = gapSeconds * 1000
      minGapMs = Math.round(
        Math.min(maxGapMs, Math.max(lane.floorMs, requested)),
      )
      if (requested < lane.floorMs)
        adjustments.push('gap raised to the store minimum')
      if (requested > maxGapMs)
        adjustments.push(
          maxGapMs < MAX_MIN_GAP_MS
            ? 'gap capped so every source fits the check interval'
            : 'gap capped at 6 h',
        )
      if (minGapMs <= lane.floorMs) minGapMs = null
    }

    let pauseUntil: string | null = null
    const pauseMinutes = finiteNumber(item.cooldownMinutes)
    if (pauseMinutes !== null && pauseMinutes > 0 && recentOk) {
      adjustments.push('pause dropped: recent checks came through')
    } else if (pauseMinutes !== null && pauseMinutes > 0) {
      const minutes = Math.min(MAX_PAUSE_MINUTES, Math.round(pauseMinutes))
      if (pauseMinutes > MAX_PAUSE_MINUTES)
        adjustments.push('pause capped at 48 h')
      if (minutes > 0)
        pauseUntil = new Date(now + minutes * MINUTE_MS).toISOString()
    }

    let quietHours: ActiveHours | null = null
    const hours = readHours(item.quietHours)
    if (hours && recentOk) {
      adjustments.push('quiet hours dropped: recent checks came through')
    } else if (hours) {
      const [start, end] = hours
      if (
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start >= 0 &&
        start <= 23 &&
        end >= 0 &&
        end <= 24 &&
        start !== end % 24
      ) {
        quietHours = [start, end]
        if (windowLength(quietHours) > MAX_QUIET_HOURS) {
          quietHours = [start, (start + MAX_QUIET_HOURS) % 24]
          adjustments.push('quiet hours shortened to 12 h')
        }
      } else {
        adjustments.push('invalid quiet hours ignored')
      }
    }

    let strategy: AppliedLaneAdvice['strategy'] = null
    if (item.strategy === 'browser_first') strategy = 'browser_first'
    else if (item.strategy === 'http_first')
      adjustments.push('HTTP-first is learned, not advised; ignored')

    const reason =
      typeof item.reason === 'string'
        ? item.reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LENGTH)
        : ''
    if (!minGapMs && !pauseUntil && !quietHours && !strategy) continue
    lanes.push({
      laneKey,
      minGapMs,
      pauseUntil,
      quietHours,
      strategy,
      reason,
      adjustments,
    })
  }
  return {
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ADVICE_TTL_MS).toISOString(),
    lanes,
  }
}

/** Advice in force for one store, as the worker applies it. */
export type ActiveLaneAdvice = {
  adviceId: number
  minGapMs: number | null
  pauseUntil: number | null
  quietHours: ActiveHours | null
  reason: string
  expiresAt: number
}

/**
 * A store's pacing with advice applied: the gap can only grow and the next
 * start can only move later, so an open circuit is never shortened and
 * nothing is sped up. Expired advice changes nothing. `maxGapMs` caps the
 * advised gap (not the store's own adaptive gap), so advice stored before
 * the store gained sources cannot leave them overdue.
 */
export function applyAdviceToLane(
  lane: LaneState,
  advice: ActiveLaneAdvice | undefined,
  now: number,
  maxGapMs: number = MAX_MIN_GAP_MS,
): LaneState {
  if (!advice || advice.expiresAt <= now) return lane
  return {
    ...lane,
    minGapMs: Math.max(lane.minGapMs, Math.min(advice.minGapMs ?? 0, maxGapMs)),
    readyAt: Math.max(lane.readyAt, advice.pauseUntil ?? 0),
  }
}

/** Scheduled checks wait while a store is in its advised quiet hours. */
export function inQuietHours(
  advice: ActiveLaneAdvice | undefined,
  date: Date,
): boolean {
  if (!advice?.quietHours || advice.expiresAt <= date.getTime()) return false
  return isWithinActiveHours(advice.quietHours, date)
}

/**
 * After failed runs in a row, the next run waits the regular interval
 * times 2^(failures - 1), at most ADVISOR_MAX_BACKOFF_MS: an AI endpoint
 * that times out is not asked again every few hours.
 */
export const ADVISOR_MAX_BACKOFF_MS = 2 * DAY_MS

export function advisorBackoffMs(baseMs: number, failures: number): number {
  if (failures <= 0) return baseMs
  return Math.min(
    Math.max(baseMs, ADVISOR_MAX_BACKOFF_MS),
    baseMs * 2 ** Math.min(failures - 1, 8),
  )
}

/**
 * Whether the scheduled advisor should run now, and why. `lastRunAt` is
 * the start of the last run, finished or not (a run is recorded when it
 * starts, so a slow or concurrent run is never doubled). After failures it
 * backs off (advisorBackoffMs). Repeated blocks count only at stores with
 * active sources (`activeLanes`) that were tried again since the last run:
 * a store dropped from the app or waiting out its cooldown for the user's
 * Solve in browser does not call the advisor again and again.
 */
export function advisorDue(input: {
  lastRunAt: number | null
  lanes: Iterable<LaneState>
  now: number
  /** Failed runs in a row, newest first (0 after a successful run). */
  failures?: number
  /** Stores with active, enabled sources; every store when left out. */
  activeLanes?: ReadonlySet<string>
}): Exclude<AdvisorTrigger, 'manual'> | null {
  const failures = input.failures ?? 0
  const since =
    input.lastRunAt === null ? Infinity : input.now - input.lastRunAt
  if (since >= advisorBackoffMs(ADVISOR_INTERVAL_MS, failures)) return 'daily'
  if (since < advisorBackoffMs(ADVISOR_BLOCKS_INTERVAL_MS, failures))
    return null
  for (const lane of input.lanes) {
    if (input.activeLanes && !input.activeLanes.has(lane.laneKey)) continue
    // Nothing new since the last run: the advisor already saw these blocks.
    if (
      input.lastRunAt !== null &&
      (lane.lastRequestAt === null || lane.lastRequestAt <= input.lastRunAt)
    )
      continue
    if (
      lane.openCount >= 2 &&
      lane.cooldownUntil !== null &&
      lane.cooldownUntil > input.now - DAY_MS
    )
      return 'repeated_blocks'
  }
  return null
}

// ---------------------------------------------------------------- runner

export const ADVISOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['stores'],
  properties: {
    stores: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'store',
          'minGapSeconds',
          'cooldownMinutes',
          'quietHours',
          'strategy',
          'reason',
        ],
        properties: {
          store: { type: 'string' },
          minGapSeconds: { type: ['number', 'null'] },
          cooldownMinutes: { type: ['number', 'null'] },
          quietHours: {
            anyOf: [
              {
                type: 'object',
                additionalProperties: false,
                required: ['start', 'end'],
                properties: {
                  start: { type: 'integer' },
                  end: { type: 'integer' },
                },
              },
              { type: 'null' },
            ],
          },
          strategy: {
            anyOf: [
              { type: 'string', enum: ['browser_first', 'keep'] },
              { type: 'null' },
            ],
          },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const

const ADVISOR_PROMPT = [
  'You help a personal app check product prices in online stores gently, so the stores do not block it.',
  'You get statistics per store for the last days: checks, how many the store answered, failures by code (challenge = bot check, http = error status, timeout, network), latency, success rate by hour of day (server time), the current gap between two checks at the store in seconds, its minimum, and recent circuit-breaker openings.',
  'recent holds the last 24 hours, newest outcome first: weigh it above the older totals. A store whose recent checks all came through has recovered: leave it out, even if it had bot checks or timeouts days ago.',
  'Suggest changes only for stores that need them, as JSON: {"stores": [{"store", "minGapSeconds", "cooldownMinutes", "quietHours", "strategy", "reason"}]}.',
  'minGapSeconds: a longer gap between checks at that store, at most its maxGapSeconds (a longer gap would leave its sources overdue), or null. cooldownMinutes: pause the store now for this long (at most 2880), or null.',
  'quietHours: {"start", "end"} hours (0-24, server time) when the store should not be checked, at most 12 hours, or null. strategy: "browser_first" to stop plain HTTP checks, or "keep"/null.',
  'reason: one short sentence. You cannot speed stores up. Leave healthy stores out. Use only the store names you were given.',
].join('\n')

export type AdvisorRunResult =
  | {
      status: 'skipped'
      /** suspended: the computer slept mid-request; it runs again later. */
      reason: 'disabled' | 'read_only' | 'busy' | 'no_data' | 'suspended'
    }
  | { status: 'done'; adviceId: number; applied: AppliedAdvice }
  | { status: 'failed'; adviceId: number | null; error: string }

const RUNNING = Symbol.for('bladevault.price-monitor.advisor-running')

function runningFlag(): { value: boolean } {
  const scope = globalThis as typeof globalThis & {
    [RUNNING]?: { value: boolean }
  }
  return (scope[RUNNING] ??= { value: false })
}

/**
 * When the advisor last started (finished or not, epoch ms) and how many
 * runs failed in a row since its last successful one.
 */
export function advisorHistory(): {
  lastRunAt: number | null
  failures: number
} {
  return readAdvisorHistory(getLocalDb())
}

/**
 * Runs the advisor once: reads the statistics, asks the model, clamps and
 * stores the advice. Failures are recorded and leave pacing unchanged.
 */
export async function runPriceAdvisor(options: {
  trigger: AdvisorTrigger
  signal?: AbortSignal
  fetchImpl?: FetchLike
  now?: number
}): Promise<AdvisorRunResult> {
  const settings = getSettings().priceMonitoring
  if (!aiConfigured(settings.ai) || !settings.ai.advisor)
    return { status: 'skipped', reason: 'disabled' }
  const access = getVaultAccessState()
  if (access.readOnly) return { status: 'skipped', reason: 'read_only' }
  const flag = runningFlag()
  if (flag.value) return { status: 'skipped', reason: 'busy' }
  flag.value = true
  try {
    const now = options.now ?? Date.now()
    const database = getLocalDb()
    const lanes = readLaneStates(database)
    const input = buildAdvisorInput({
      rows: readAdvisorRows(database, now - ADVISOR_STATS_DAYS * DAY_MS),
      lanes,
      settings,
      now,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    if (!input.stores.length) return { status: 'skipped', reason: 'no_data' }
    // Recorded before the AI call, so a slow call (or another server on the
    // same vault) does not start a second run meanwhile.
    const adviceId = await startAdvice({
      generation: access.generation,
      createdAt: new Date(now).toISOString(),
      trigger: options.trigger,
      model: settings.ai.model,
      input,
    })
    const base = { generation: access.generation, adviceId }
    let output: unknown
    try {
      output = await requestJsonCompletion(
        {
          baseUrl: settings.ai.baseUrl,
          apiKey: await readPriceAiKey(),
          headers: settings.ai.headers,
          maxAnswerTokens: settings.ai.maxAnswerTokens,
        },
        {
          model: settings.ai.model,
          system: ADVISOR_PROMPT,
          user: JSON.stringify(input),
          schemaName: 'store_pacing_advice',
          purpose: 'advisor',
          schema: ADVISOR_SCHEMA,
          maxTokens: 1200,
        },
        {
          timeoutMs: ADVISOR_TIMEOUT_MS,
          signal: options.signal,
          fetchImpl: options.fetchImpl,
        },
      )
    } catch (error) {
      // Sleep is not a failed review: nothing is recorded, so it is due again.
      if (error instanceof AiClientError && error.code === 'suspended')
        return { status: 'skipped', reason: 'suspended' }
      const message = redactSecrets(
        error instanceof Error ? error.message : 'The AI request failed.',
      )
      await finishAdvice({ ...base, error: message })
      return { status: 'failed', adviceId, error: message }
    }
    const applied = clampAdvice(output, {
      lanes: new Map(
        input.stores.map((store) => [
          store.store,
          {
            floorMs: store.floorSeconds * 1000,
            maxGapMs: store.maxGapSeconds * 1000,
            recentOk: recentlyHealthy(store),
          },
        ]),
      ),
      now,
    })
    await finishAdvice({ ...base, output, applied })
    return { status: 'done', adviceId, applied }
  } finally {
    flag.value = false
  }
}
