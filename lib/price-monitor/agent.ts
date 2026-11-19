import type Database from 'better-sqlite3'
import { getLocalDb } from '@/lib/local-db'
import { aiConfigured } from '@/lib/price-monitor/ai'
import {
  requestJsonCompletion,
  type FetchLike,
} from '@/lib/price-monitor/ai-client'
import { readAiUsageToday } from '@/lib/price-monitor/ai-journal'
import { discoveryActive } from '@/lib/price-monitor/discovery'
import { frequencyMs } from '@/lib/price-monitor/schedule'
import { redactSecrets } from '@/lib/price-monitor/secret-registry'
import { readPriceAiKey } from '@/lib/price-monitor/secrets'
import {
  FETCH_OVERRIDES,
  type FetchOverride,
  type PriceSourceStatus,
} from '@/lib/price-monitor/shared'
import { readLaneStates, readQueueCandidates } from '@/lib/price-monitor/store'
import { getSettings } from '@/lib/settings'
import type {
  PriceAgentMode,
  PriceMonitoringSettings,
} from '@/lib/settings-shared'
import {
  assertVaultGeneration,
  getVaultAccessState,
  withVaultWrite,
} from '@/lib/vault-access'

/**
 * The AI supervisor. On a schedule it shows the model the whole state of
 * price monitoring (every source, every store's pacing, coverage and the AI
 * budget) and the model answers with actions from a fixed set:
 *
 * - check: move sources to the front of their store's queue,
 * - retryWithAi: let AI read or solve a failing page on its next check,
 * - fetchMode: load a source in the browser or over plain HTTP,
 * - pause: stop a source whose page keeps failing as gone,
 * - searchOtherStore: look for a knife on other stores (Other stores).
 *
 * Every action is validated and capped here, never trusted. Checks still run
 * through the paced queue: one product at a time per store, with store gaps,
 * Retry-After, AI pacing advice and the circuit breaker all in force, so the
 * agent can reorder work but never speed a store up. It never sees or sends
 * URLs, keys, purchase prices or notes. In observe mode it only journals
 * what it would do.
 */
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
export const AGENT_INTERVAL_UNLIMITED_MS = 10 * MINUTE_MS
export const AGENT_INTERVAL_LIMITED_MS = 60 * MINUTE_MS
export const AGENT_TIMEOUT_MS = 180_000
export const AGENT_RETENTION_MS = 30 * 24 * HOUR_MS
/** Sources shown to the model, most urgent first. */
export const MAX_SNAPSHOT_SOURCES = 600
/** Actions per kind and run. */
export const AGENT_LIMITS = {
  check: 25,
  retryWithAi: 10,
  fetchMode: 5,
  pause: 3,
  searchOtherStore: 5,
} as const
/** A check asked for this soon after the last one is refused. */
export const RECHECK_MIN_MS = 30 * MINUTE_MS
/** Failed checks in a row before the agent may pause a source. */
export const PAUSE_MIN_FAILURES = 5
const REASON_MAX = 200
const SUMMARY_MAX = 600

const RETRYABLE: ReadonlySet<PriceSourceStatus> = new Set([
  'failed',
  'price_unavailable',
])

export type AgentTrigger = 'scheduled' | 'manual'

export type AgentSource = {
  id: number
  knifeId: string
  knife: string
  store: string
  status: PriceSourceStatus
  /** Covered by scheduled monitoring (enabled, knife eligible). */
  monitored: boolean
  fetch: FetchOverride
  checkedMinAgo: number | null
  okMinAgo: number | null
  error: string | null
  failures: number
  dueInMin: number | null
  aiMinAgo: number | null
  /**
   * Already waiting at the front of its store's queue: never checked, Check
   * now, or moved forward by an earlier run.
   */
  queued: boolean
}

export type AgentStore = {
  store: string
  sources: number
  circuit: 'closed' | 'open'
  pausedForMin: number
  readyInMin: number
  minGapSec: number
  fullPassHours: number
}

export type AgentCoverage = {
  monitored: number
  neverChecked: number
  dueNow: number
  /** Last check older than 1.5 × the check interval. */
  stale: number
  failed: number
  blocked: number
  priceUnavailable: number
  outOfStock: number
}

export type AgentSnapshot = {
  now: string
  mode: Exclude<PriceAgentMode, 'off'>
  checkIntervalHours: number
  ai: {
    usage: 'limited' | 'unlimited'
    today: { calls: number; tokens: number }
    dailyCalls: number
    dailyTokens: number
    readsPages: boolean
    solvesErrors: boolean
  }
  otherStores: boolean
  coverage: AgentCoverage
  stores: AgentStore[]
  sources: AgentSource[]
  /** Sources left out of `sources` (only when over MAX_SNAPSHOT_SOURCES). */
  omitted: number
  recentRuns: Array<{
    at: string
    summary: string | null
    actions: Array<{ kind: string; target: string; status: string }>
  }>
}

type SourceQueryRow = {
  id: number
  knife_id: string
  brand: string
  name: string
  lane_key: string
  store_name: string
  enabled: number
  status: PriceSourceStatus
  fetch_override: FetchOverride
  last_checked_at: string | null
  last_success_at: string | null
  last_error_code: string | null
  consecutive_failures: number
  next_check_at: string | null
  last_ai_at: string | null
  priority: number
}

const minutesAgo = (value: string | null, now: number) => {
  if (!value) return null
  const time = Date.parse(value)
  return Number.isFinite(time)
    ? Math.max(0, Math.round((now - time) / MINUTE_MS))
    : null
}

const minutesUntil = (value: number | string | null, now: number) => {
  if (value === null) return null
  const time = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(time) ? Math.round((time - now) / MINUTE_MS) : null
}

/** How urgent a source is for the model's list (lower first). */
function urgency(source: AgentSource): number {
  if (!source.monitored) return 5
  if (source.checkedMinAgo === null) return 0
  if (source.status === 'failed' || source.status === 'price_unavailable')
    return 1
  if (source.dueInMin !== null && source.dueInMin <= 0) return 2
  if (source.status === 'blocked') return 3
  return 4
}

/** Everything the model sees. Pure apart from the database reads. */
export function buildAgentSnapshot(input: {
  database: Database.Database
  settings: PriceMonitoringSettings
  mode: Exclude<PriceAgentMode, 'off'>
  now: number
}): AgentSnapshot {
  const { database, settings, now } = input
  const intervalMs = frequencyMs(settings.schedule)
  const monitored = new Set(
    readQueueCandidates(database, settings)
      .filter((candidate) => candidate.scheduled)
      .map((candidate) => candidate.sourceId),
  )
  const rows = database
    .prepare(
      `SELECT s.id, s.knife_id, k.brand, k.name, s.lane_key, s.store_name,
              s.enabled, s.status, s.fetch_override, s.last_checked_at,
              s.last_success_at, s.last_error_code, s.consecutive_failures,
              s.next_check_at, s.last_ai_at, s.priority
       FROM price_sources s JOIN knives k ON k.id = s.knife_id
       WHERE s.removed_at IS NULL`,
    )
    .all() as SourceQueryRow[]

  const all: AgentSource[] = rows.map((row) => ({
    id: row.id,
    knifeId: row.knife_id,
    knife: [row.brand, row.name].filter(Boolean).join(' ').slice(0, 120),
    store: row.store_name || row.lane_key,
    status: row.status,
    monitored: monitored.has(row.id),
    fetch: row.fetch_override,
    checkedMinAgo: minutesAgo(row.last_checked_at, now),
    okMinAgo: minutesAgo(row.last_success_at, now),
    error: row.last_error_code,
    failures: row.consecutive_failures,
    dueInMin: minutesUntil(row.next_check_at, now),
    aiMinAgo: minutesAgo(row.last_ai_at, now),
    // Never-checked sources and earlier agent picks wait at the front.
    queued: row.priority >= 1,
  }))

  const watched = all.filter((source) => source.monitored)
  const coverage: AgentCoverage = {
    monitored: watched.length,
    neverChecked: watched.filter((source) => source.checkedMinAgo === null)
      .length,
    dueNow: watched.filter(
      (source) => source.dueInMin === null || source.dueInMin <= 0,
    ).length,
    stale: watched.filter(
      (source) =>
        source.checkedMinAgo !== null &&
        source.checkedMinAgo * MINUTE_MS > intervalMs * 1.5,
    ).length,
    failed: watched.filter((source) => source.status === 'failed').length,
    blocked: watched.filter((source) => source.status === 'blocked').length,
    priceUnavailable: watched.filter(
      (source) => source.status === 'price_unavailable',
    ).length,
    outOfStock: watched.filter((source) => source.status === 'out_of_stock')
      .length,
  }

  const laneOf = new Map(rows.map((row) => [row.id, row.lane_key]))
  const counts = new Map<string, number>()
  for (const source of watched) {
    const lane = laneOf.get(source.id)!
    counts.set(lane, (counts.get(lane) ?? 0) + 1)
  }
  const lanes = readLaneStates(database)
  const stores: AgentStore[] = [...counts]
    .map(([laneKey, sources]) => {
      const lane = lanes.get(laneKey)
      const minGapMs = Math.max(
        lane?.minGapMs ?? 0,
        settings.pacing.minGapSeconds * 1000,
      )
      return {
        store: laneKey,
        sources,
        circuit: lane?.circuit ?? 'closed',
        pausedForMin: Math.max(
          0,
          minutesUntil(lane?.cooldownUntil ?? null, now) ?? 0,
        ),
        readyInMin: Math.max(0, minutesUntil(lane?.readyAt ?? null, now) ?? 0),
        minGapSec: Math.round(minGapMs / 1000),
        fullPassHours: Math.round(((minGapMs * sources) / HOUR_MS) * 10) / 10,
      }
    })
    .sort((a, b) => b.sources - a.sources || a.store.localeCompare(b.store))

  const sorted = [...all].sort(
    (a, b) =>
      urgency(a) - urgency(b) ||
      (b.checkedMinAgo ?? Infinity) - (a.checkedMinAgo ?? Infinity) ||
      a.id - b.id,
  )
  const today = readAiUsageToday(database, now)
  return {
    now: new Date(now).toISOString(),
    mode: input.mode,
    checkIntervalHours: Math.round((intervalMs / HOUR_MS) * 10) / 10,
    ai: {
      usage: settings.ai.usage.mode,
      today,
      dailyCalls: settings.ai.usage.dailyCalls,
      dailyTokens: settings.ai.usage.dailyTokens,
      readsPages: settings.ai.extractionFallback,
      solvesErrors: settings.ai.resolveErrors,
    },
    otherStores: discoveryActive(settings),
    coverage,
    stores,
    sources: sorted.slice(0, MAX_SNAPSHOT_SOURCES),
    omitted: Math.max(0, sorted.length - MAX_SNAPSHOT_SOURCES),
    recentRuns: readAgentRuns(database, 3).map((run) => ({
      at: run.startedAt,
      summary: run.summary,
      actions: run.actions.map((action) => ({
        kind: action.kind,
        target:
          action.sourceId !== undefined
            ? `source ${action.sourceId}`
            : `knife ${action.knifeId}`,
        status: action.status,
      })),
    })),
  }
}

// ------------------------------------------------------------- the plan

type PlanItem = { sourceId: number; reason: string }
export type AgentPlan = {
  summary: string
  check: PlanItem[]
  retryWithAi: PlanItem[]
  fetchMode: Array<PlanItem & { mode: FetchOverride }>
  pause: PlanItem[]
  searchOtherStore: Array<{ knifeId: string; reason: string }>
}

const item = (extra: Record<string, unknown> = {}) => ({
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['sourceId', 'reason', ...Object.keys(extra)],
    properties: {
      sourceId: { type: 'integer' },
      reason: { type: 'string' },
      ...extra,
    },
  },
})

export const AGENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'summary',
    'check',
    'retryWithAi',
    'fetchMode',
    'pause',
    'searchOtherStore',
  ],
  properties: {
    summary: { type: 'string' },
    check: item(),
    retryWithAi: item(),
    fetchMode: item({ mode: { type: 'string', enum: [...FETCH_OVERRIDES] } }),
    pause: item(),
    searchOtherStore: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['knifeId', 'reason'],
        properties: {
          knifeId: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const

export const AGENT_PROMPT = [
  'You supervise price monitoring for a knife collection. Each source is one store product page that BladeVault checks for price and stock.',
  "The input shows every source (most urgent first), each store's pacing, coverage, the AI budget and your recent runs. Decide what to do now so that every monitored source has a fresh, readable price.",
  'Answer with JSON only: {"summary", "check", "retryWithAi", "fetchMode", "pause", "searchOtherStore"}. Leave a list empty when nothing is needed.',
  `check (at most ${AGENT_LIMITS.check}): sources to move to the front of their store's queue: overdue or stale ones first, then failing ones worth another try. Sources marked queued (never checked, or moved forward before) are already at the front, so skip them, and skip sources checked in the last 30 minutes or not monitored.`,
  'A store checks one product at a time at its own safe pace (minGapSec, fullPassHours), and paused stores (circuit open) wait out their pause. You cannot speed a store up: many checks at one store simply wait in line, so spread requests over stores and do not ask for more than the stores can do before your next run.',
  `retryWithAi (at most ${AGENT_LIMITS.retryWithAi}): failed or price_unavailable sources where AI reading or working the page may get the price on the next check. Never for blocked sources: a bot check needs the user.`,
  `fetchMode (at most ${AGENT_LIMITS.fetchMode}): "browser" when a source keeps failing in a way a real browser may fix (scripts, empty pages, timeouts), "http" only for a fast simple page, "auto" to undo.`,
  `pause (at most ${AGENT_LIMITS.pause}): only sources that failed at least ${PAUSE_MIN_FAILURES} checks in a row and whose page seems gone (not_found, http_404, http_410, redirects). The user can resume them.`,
  `searchOtherStore (at most ${AGENT_LIMITS.searchOtherStore}): knives (knifeId) whose sources are all out of stock or failing, only when otherStores is true.`,
  'Every item needs a short reason. summary: one to three plain sentences for the user about the state and what you did.',
].join('\n')

const text = (value: unknown, max: number) =>
  typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, max)
    : ''

function readItems<T>(
  value: unknown,
  limit: number,
  read: (entry: Record<string, unknown>) => T | null,
): T[] {
  if (!Array.isArray(value)) return []
  const result: T[] = []
  for (const entry of value) {
    if (result.length >= limit) break
    if (!entry || typeof entry !== 'object') continue
    const parsed = read(entry as Record<string, unknown>)
    if (parsed) result.push(parsed)
  }
  return result
}

const sourceItem = (entry: Record<string, unknown>): PlanItem | null => {
  const id = entry.sourceId
  return typeof id === 'number' && Number.isInteger(id) && id > 0
    ? { sourceId: id, reason: text(entry.reason, REASON_MAX) }
    : null
}

/** The model's answer as a plan, capped per kind. Pure. */
export function readAgentPlan(answer: unknown): AgentPlan {
  const record = (answer && typeof answer === 'object' ? answer : {}) as Record<
    string,
    unknown
  >
  return {
    summary: text(record.summary, SUMMARY_MAX),
    check: readItems(record.check, AGENT_LIMITS.check, sourceItem),
    retryWithAi: readItems(
      record.retryWithAi,
      AGENT_LIMITS.retryWithAi,
      sourceItem,
    ),
    fetchMode: readItems(record.fetchMode, AGENT_LIMITS.fetchMode, (entry) => {
      const base = sourceItem(entry)
      const mode = entry.mode
      return base && (FETCH_OVERRIDES as readonly unknown[]).includes(mode)
        ? { ...base, mode: mode as FetchOverride }
        : null
    }),
    pause: readItems(record.pause, AGENT_LIMITS.pause, sourceItem),
    searchOtherStore: readItems(
      record.searchOtherStore,
      AGENT_LIMITS.searchOtherStore,
      (entry) => {
        const id = text(entry.knifeId, 100)
        return id
          ? { knifeId: id, reason: text(entry.reason, REASON_MAX) }
          : null
      },
    ),
  }
}

export type AgentActionKind =
  'check' | 'retryWithAi' | 'fetchMode' | 'pause' | 'searchOtherStore'

export type AgentAction = {
  kind: AgentActionKind
  sourceId?: number
  knifeId?: string
  mode?: FetchOverride
  reason: string
  /** applied (act), proposed (observe), refused (failed validation). */
  status: 'applied' | 'proposed' | 'refused'
  note: string | null
}

/**
 * Validates the plan against the snapshot. Pure: refused actions say why,
 * the others become `applied` (act) or `proposed` (observe) once applied.
 */
export function validateAgentPlan(
  plan: AgentPlan,
  snapshot: Pick<AgentSnapshot, 'sources' | 'ai' | 'otherStores'>,
): AgentAction[] {
  const byId = new Map(snapshot.sources.map((source) => [source.id, source]))
  const knives = new Set(snapshot.sources.map((source) => source.knifeId))
  const seen = new Set<string>()
  const actions: AgentAction[] = []
  const push = (
    action: Omit<AgentAction, 'status' | 'note'>,
    refusal: string | null,
  ) => {
    const key = `${action.kind}:${action.sourceId ?? action.knifeId}`
    if (seen.has(key)) refusal = 'asked twice'
    seen.add(key)
    actions.push({
      ...action,
      status: refusal ? 'refused' : 'proposed',
      note: refusal,
    })
  }
  const known = (id: number) => byId.get(id) ?? null

  for (const entry of plan.check) {
    const source = known(entry.sourceId)
    push(
      { kind: 'check', sourceId: entry.sourceId, reason: entry.reason },
      !source
        ? 'unknown source'
        : !source.monitored
          ? 'not monitored'
          : source.queued
            ? 'already queued'
            : source.checkedMinAgo !== null &&
                source.checkedMinAgo * MINUTE_MS < RECHECK_MIN_MS
              ? 'checked less than 30 minutes ago'
              : null,
    )
  }
  for (const entry of plan.retryWithAi) {
    const source = known(entry.sourceId)
    push(
      { kind: 'retryWithAi', sourceId: entry.sourceId, reason: entry.reason },
      !source
        ? 'unknown source'
        : !source.monitored
          ? 'not monitored'
          : !snapshot.ai.readsPages && !snapshot.ai.solvesErrors
            ? 'AI page reading and error solving are off'
            : !RETRYABLE.has(source.status)
              ? `status is ${source.status}`
              : null,
    )
  }
  for (const entry of plan.fetchMode) {
    const source = known(entry.sourceId)
    push(
      {
        kind: 'fetchMode',
        sourceId: entry.sourceId,
        mode: entry.mode,
        reason: entry.reason,
      },
      !source
        ? 'unknown source'
        : source.fetch === entry.mode
          ? `already ${entry.mode}`
          : null,
    )
  }
  for (const entry of plan.pause) {
    const source = known(entry.sourceId)
    push(
      { kind: 'pause', sourceId: entry.sourceId, reason: entry.reason },
      !source
        ? 'unknown source'
        : !source.monitored
          ? 'not monitored'
          : source.failures < PAUSE_MIN_FAILURES
            ? `only ${source.failures} failed checks in a row`
            : !RETRYABLE.has(source.status)
              ? `status is ${source.status}`
              : null,
    )
  }
  for (const entry of plan.searchOtherStore) {
    push(
      {
        kind: 'searchOtherStore',
        knifeId: entry.knifeId,
        reason: entry.reason,
      },
      !snapshot.otherStores
        ? 'Other stores is off'
        : !knives.has(entry.knifeId)
          ? 'unknown knife'
          : null,
    )
  }
  return actions
}

/** Applies validated actions in one write; returns them with results. */
export async function applyAgentActions(
  actions: readonly AgentAction[],
  context: { generation: string; now: number },
): Promise<AgentAction[]> {
  return withVaultWrite(async () => {
    assertVaultGeneration(context.generation)
    const database = getLocalDb()
    const now = new Date(context.now).toISOString()
    const expedite = database.prepare(
      `UPDATE price_sources
       SET priority = MAX(priority, 1), next_check_at = ?, updated_at = ?
       WHERE id = ? AND removed_at IS NULL AND enabled = 1`,
    )
    const clearAi = database.prepare(
      'UPDATE price_sources SET last_ai_at = NULL WHERE id = ?',
    )
    const fetchMode = database.prepare(
      `UPDATE price_sources SET fetch_override = ?, updated_at = ?
       WHERE id = ? AND removed_at IS NULL`,
    )
    const pause = database.prepare(
      `UPDATE price_sources SET enabled = 0, updated_at = ?
       WHERE id = ? AND removed_at IS NULL AND enabled = 1`,
    )
    const search = database.prepare(
      `UPDATE price_discovery SET next_attempt_at = ?
       WHERE knife_id = ? AND status <> 'found'`,
    )
    return database.transaction(() =>
      actions.map((action): AgentAction => {
        if (action.status === 'refused') return action
        let changes = 0
        switch (action.kind) {
          case 'check':
            changes = expedite.run(now, now, action.sourceId).changes
            break
          case 'retryWithAi':
            clearAi.run(action.sourceId)
            changes = expedite.run(now, now, action.sourceId).changes
            break
          case 'fetchMode':
            changes = fetchMode.run(action.mode, now, action.sourceId).changes
            break
          case 'pause':
            changes = pause.run(now, action.sourceId).changes
            break
          case 'searchOtherStore':
            changes = search.run(now, action.knifeId).changes
            // A knife never searched yet is due anyway; a found one stays.
            return {
              ...action,
              status: 'applied',
              note: changes ? null : 'already due, or already found',
            }
        }
        return changes
          ? { ...action, status: 'applied', note: null }
          : { ...action, status: 'refused', note: 'source changed meanwhile' }
      }),
    )()
  })
}

// ---------------------------------------------------------------- journal

export type AgentRun = {
  id: number
  startedAt: string
  trigger: AgentTrigger
  mode: Exclude<PriceAgentMode, 'off'>
  model: string
  durationMs: number
  ok: boolean
  summary: string | null
  coverage: AgentCoverage | null
  actions: AgentAction[]
  error: string | null
}

type RunRow = {
  id: number
  started_at: string
  trigger: AgentTrigger
  mode: Exclude<PriceAgentMode, 'off'>
  model: string
  duration_ms: number
  ok: number
  summary: string | null
  coverage: string | null
  actions: string | null
  error: string | null
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function readAgentRuns(
  database: Database.Database,
  limit = 20,
): AgentRun[] {
  return (
    database
      .prepare(
        `SELECT * FROM price_agent_runs ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(limit) as RunRow[]
  ).map((row) => ({
    id: row.id,
    startedAt: row.started_at,
    trigger: row.trigger,
    mode: row.mode,
    model: row.model,
    durationMs: row.duration_ms,
    ok: row.ok === 1,
    summary: row.summary,
    coverage: parseJson<AgentCoverage | null>(row.coverage, null),
    actions: parseJson<AgentAction[]>(row.actions, []),
    error: row.error,
  }))
}

export function lastAgentRunAt(database: Database.Database): number | null {
  const row = database
    .prepare('SELECT MAX(started_at) AS at FROM price_agent_runs')
    .get() as { at: string | null }
  return row.at ? Date.parse(row.at) : null
}

export function pruneAgentRuns(database: Database.Database, now = Date.now()) {
  database
    .prepare('DELETE FROM price_agent_runs WHERE started_at < ?')
    .run(new Date(now - AGENT_RETENTION_MS).toISOString())
}

async function recordAgentRun(
  run: Omit<AgentRun, 'id'>,
  generation: string,
): Promise<number> {
  return withVaultWrite(async () => {
    assertVaultGeneration(generation)
    return Number(
      getLocalDb()
        .prepare(
          `INSERT INTO price_agent_runs
            (started_at, trigger, mode, model, duration_ms, ok, summary,
             coverage, actions, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.startedAt,
          run.trigger,
          run.mode,
          run.model,
          run.durationMs,
          run.ok ? 1 : 0,
          run.summary,
          run.coverage ? JSON.stringify(run.coverage) : null,
          JSON.stringify(run.actions),
          run.error,
        ).lastInsertRowid,
    )
  })
}

// ----------------------------------------------------------------- runner

/** How often the supervisor runs: often when AI is unlimited. */
export function agentIntervalMs(settings: PriceMonitoringSettings): number {
  return settings.ai.usage.mode === 'unlimited'
    ? AGENT_INTERVAL_UNLIMITED_MS
    : AGENT_INTERVAL_LIMITED_MS
}

export function agentActive(settings: PriceMonitoringSettings): boolean {
  return settings.ai.agentMode !== 'off' && aiConfigured(settings.ai)
}

/** Whether a scheduled run is due. Pure. */
export function agentDue(input: {
  settings: PriceMonitoringSettings
  lastRunAt: number | null
  now: number
}): boolean {
  if (!agentActive(input.settings)) return false
  return (
    input.lastRunAt === null ||
    input.now - input.lastRunAt >= agentIntervalMs(input.settings)
  )
}

export type AgentRunResult =
  | { status: 'skipped'; reason: 'disabled' | 'read_only' | 'busy' }
  | { status: 'done'; run: AgentRun }

const RUNNING = Symbol.for('bladevault.price-monitor.agent-running')

function runningFlag(): { value: boolean } {
  const scope = globalThis as typeof globalThis & {
    [RUNNING]?: { value: boolean }
  }
  return (scope[RUNNING] ??= { value: false })
}

/**
 * One supervisor run: snapshot, one model answer, validation, then the
 * actions applied (act) or only journalled (observe). AI failures are
 * journalled and change nothing.
 */
export async function runPriceAgent(options: {
  trigger: AgentTrigger
  signal?: AbortSignal
  fetchImpl?: FetchLike
  now?: () => number
}): Promise<AgentRunResult> {
  const settings = getSettings().priceMonitoring
  if (!agentActive(settings)) return { status: 'skipped', reason: 'disabled' }
  const mode = settings.ai.agentMode as Exclude<PriceAgentMode, 'off'>
  const access = getVaultAccessState()
  if (access.readOnly) return { status: 'skipped', reason: 'read_only' }
  const flag = runningFlag()
  if (flag.value) return { status: 'skipped', reason: 'busy' }
  flag.value = true
  const clock = options.now ?? Date.now
  const started = clock()
  try {
    const snapshot = buildAgentSnapshot({
      database: getLocalDb(),
      settings,
      mode,
      now: started,
    })
    const base = {
      startedAt: new Date(started).toISOString(),
      trigger: options.trigger,
      mode,
      model: settings.ai.model,
      coverage: snapshot.coverage,
    }
    let plan: AgentPlan
    try {
      plan = readAgentPlan(
        await requestJsonCompletion(
          {
            baseUrl: settings.ai.baseUrl,
            apiKey: await readPriceAiKey(),
            headers: settings.ai.headers,
            maxAnswerTokens: settings.ai.maxAnswerTokens,
          },
          {
            model: settings.ai.model,
            system: AGENT_PROMPT,
            user: JSON.stringify(snapshot),
            schemaName: 'monitoring_plan',
            purpose: 'agent',
            schema: AGENT_SCHEMA,
            maxTokens: 2000,
          },
          {
            timeoutMs: AGENT_TIMEOUT_MS,
            signal: options.signal,
            fetchImpl: options.fetchImpl,
          },
        ),
      )
    } catch (error) {
      if (error instanceof Error && error.name === 'VaultAccessError')
        throw error
      const run = {
        ...base,
        durationMs: clock() - started,
        ok: false,
        summary: null,
        actions: [],
        error: redactSecrets(
          error instanceof Error ? error.message : 'The AI request failed.',
        ).slice(0, 300),
      }
      const id = await recordAgentRun(run, access.generation)
      return { status: 'done', run: { ...run, id } }
    }
    const validated = validateAgentPlan(plan, snapshot)
    const actions =
      mode === 'act'
        ? await applyAgentActions(validated, {
            generation: access.generation,
            now: clock(),
          })
        : validated
    const run = {
      ...base,
      durationMs: clock() - started,
      ok: true,
      summary: plan.summary || null,
      actions,
      error: null,
    }
    const id = await recordAgentRun(run, access.generation)
    return { status: 'done', run: { ...run, id } }
  } finally {
    flag.value = false
  }
}
