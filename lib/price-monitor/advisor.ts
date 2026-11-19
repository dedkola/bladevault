import {
  requestJsonCompletion,
  type FetchLike,
} from '@/lib/price-monitor/ai-client'
import { aiConfigured } from '@/lib/price-monitor/ai'
import {
  readAdvisorRows,
  readLastAdviceAt,
  recordAdvice,
  type AdvisorRows,
} from '@/lib/price-monitor/advice-store'
import {
  laneFloorMs,
  laneGapMs,
  MAX_MIN_GAP_MS,
  type LaneState,
} from '@/lib/price-monitor/lanes'
import {
  activeWindowMs,
  effectiveActiveHours,
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
export const ADVISOR_TIMEOUT_MS = 60_000
export const MAX_ADVISOR_LANES = 25
export const MAX_PAUSE_MINUTES = 48 * 60
export const MAX_QUIET_HOURS = 12
const MAX_REASON_LENGTH = 200

export type AdvisorTrigger = 'daily' | 'repeated_blocks' | 'manual'

// ------------------------------------------------------------ statistics

export type AdvisorLaneStats = {
  /** Store host name such as "vosteed.com", or "amazon". */
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
}

export type AdvisorInput = {
  now: string
  timeZone: string
  frequencyHours: number
  activeHours: ActiveHours | null
  statsDays: number
  stores: AdvisorLaneStats[]
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
  const windowMs = activeWindowMs(settings.schedule)
  const stores: AdvisorLaneStats[] = []
  for (const laneKey of laneKeys) {
    const daily = rows.daily.find((row) => row.laneKey === laneKey)
    const checks = rows.checks.filter((row) => row.laneKey === laneKey)
    const total = daily?.checks ?? checks.length
    if (!total) continue
    const answered = (daily?.ok ?? 0) + (daily?.noPrice ?? 0)
    const failureCodes: Record<string, number> = {}
    const hours = new Map<number, { checks: number; ok: number }>()
    const durations: number[] = []
    for (const check of checks) {
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
    const floorMs = laneFloorMs(laneKey, settings.pacing)
    const sources = rows.sources.get(laneKey) ?? 0
    const gapMs = laneGapMs({
      minGapMs: Math.max(lane?.minGapMs ?? floorMs, floorMs),
      floorMs,
      activeWindowMs: windowMs,
      sourceCount: sources,
    })
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
    })
  }
  stores.sort((a, b) => b.checks - a.checks || a.store.localeCompare(b.store))
  return {
    now: new Date(now).toISOString(),
    timeZone: input.timeZone,
    frequencyHours:
      Math.round((frequencyMs(settings.schedule) / HOUR_MS) * 10) / 10,
    activeHours: effectiveActiveHours(settings.schedule),
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

    let minGapMs: number | null = null
    const gapSeconds = finiteNumber(item.minGapSeconds)
    if (gapSeconds !== null && gapSeconds > 0) {
      const requested = gapSeconds * 1000
      minGapMs = Math.round(
        Math.min(MAX_MIN_GAP_MS, Math.max(lane.floorMs, requested)),
      )
      if (requested < lane.floorMs)
        adjustments.push('gap raised to the store minimum')
      if (requested > MAX_MIN_GAP_MS) adjustments.push('gap capped at 6 h')
      if (minGapMs <= lane.floorMs) minGapMs = null
    }

    let pauseUntil: string | null = null
    const pauseMinutes = finiteNumber(item.cooldownMinutes)
    if (pauseMinutes !== null && pauseMinutes > 0) {
      const minutes = Math.min(MAX_PAUSE_MINUTES, Math.round(pauseMinutes))
      if (pauseMinutes > MAX_PAUSE_MINUTES)
        adjustments.push('pause capped at 48 h')
      if (minutes > 0)
        pauseUntil = new Date(now + minutes * MINUTE_MS).toISOString()
    }

    let quietHours: ActiveHours | null = null
    const hours = readHours(item.quietHours)
    if (hours) {
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
 * nothing is sped up. Expired advice changes nothing.
 */
export function applyAdviceToLane(
  lane: LaneState,
  advice: ActiveLaneAdvice | undefined,
  now: number,
): LaneState {
  if (!advice || advice.expiresAt <= now) return lane
  return {
    ...lane,
    minGapMs: Math.max(lane.minGapMs, advice.minGapMs ?? 0),
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

/** Whether the scheduled advisor should run now, and why. */
export function advisorDue(input: {
  lastRunAt: number | null
  lanes: Iterable<LaneState>
  now: number
}): Exclude<AdvisorTrigger, 'manual'> | null {
  const since =
    input.lastRunAt === null ? Infinity : input.now - input.lastRunAt
  if (since >= ADVISOR_INTERVAL_MS) return 'daily'
  if (since < ADVISOR_BLOCKS_INTERVAL_MS) return null
  for (const lane of input.lanes)
    if (
      lane.openCount >= 2 &&
      lane.cooldownUntil !== null &&
      lane.cooldownUntil > input.now - DAY_MS
    )
      return 'repeated_blocks'
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
  'Suggest changes only for stores that need them, as JSON: {"stores": [{"store", "minGapSeconds", "cooldownMinutes", "quietHours", "strategy", "reason"}]}.',
  'minGapSeconds: a longer gap between checks at that store, or null. cooldownMinutes: pause the store now for this long (at most 2880), or null.',
  'quietHours: {"start", "end"} hours (0-24, server time) when the store should not be checked, at most 12 hours, or null. strategy: "browser_first" to stop plain HTTP checks, or "keep"/null.',
  'reason: one short sentence. You cannot speed stores up. Leave healthy stores out. Use only the store names you were given.',
].join('\n')

export type AdvisorRunResult =
  | {
      status: 'skipped'
      reason: 'disabled' | 'read_only' | 'busy' | 'no_data'
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

/** When the advisor last ran (successfully or not), epoch ms. */
export function lastAdvisorRunAt(): number | null {
  return readLastAdviceAt(getLocalDb())
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
    const base = {
      generation: access.generation,
      createdAt: new Date(now).toISOString(),
      trigger: options.trigger,
      model: settings.ai.model,
      input,
    }
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
      const message = redactSecrets(
        error instanceof Error ? error.message : 'The AI request failed.',
      )
      const adviceId = await recordAdvice({ ...base, error: message })
      return { status: 'failed', adviceId, error: message }
    }
    const applied = clampAdvice(output, {
      lanes: new Map(
        input.stores.map((store) => [
          store.store,
          { floorMs: laneFloorMs(store.store, settings.pacing) },
        ]),
      ),
      now,
    })
    const adviceId = await recordAdvice({ ...base, output, applied })
    return { status: 'done', adviceId: adviceId ?? 0, applied }
  } finally {
    flag.value = false
  }
}
