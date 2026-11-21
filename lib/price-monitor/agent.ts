import type Database from 'better-sqlite3'
import { getLocalDb } from '@/lib/local-db'
import { aiConfigured } from '@/lib/price-monitor/ai'
import {
  PLANNING_TIMEOUT_MS,
  requestJsonCompletion,
  type FetchLike,
} from '@/lib/price-monitor/ai-client'
import { readAiUsageToday } from '@/lib/price-monitor/ai-journal'
import {
  discoveryActive,
  enabledDiscoveryStores,
} from '@/lib/price-monitor/discovery'
import type { DiscoveryStatus } from '@/lib/price-monitor/discovery-store'
import { DISCOVERY_STORES } from '@/lib/price-monitor/discovery-stores'
import { readOutOfStockSince } from '@/lib/price-monitor/insights'
import {
  currencyFractionDigits,
  fromMinorUnits,
  parseStoredPrice,
  toMinorUnits,
} from '@/lib/price-monitor/money'
import { byUrgency } from '@/lib/price-monitor/queue'
import { frequencyMs } from '@/lib/price-monitor/schedule'
import { redactSecrets } from '@/lib/price-monitor/secret-registry'
import { readPriceAiKey } from '@/lib/price-monitor/secrets'
import {
  FETCH_OVERRIDES,
  type Availability,
  type FetchOverride,
  type PriceSourceStatus,
} from '@/lib/price-monitor/shared'
import {
  readLaneStates,
  readQueueCandidates,
  startKnifeFocus,
} from '@/lib/price-monitor/store'
import { getSettings } from '@/lib/settings'
import type {
  PriceAgentMode,
  PriceMonitoringSettings,
} from '@/lib/settings-shared'
import { writeSystemMessageReports } from '@/lib/system-message-store'
import {
  PRICE_ADVICE_TOPICS,
  PRICE_QUESTION_ASKS,
  readPriceAgentNote,
  type PriceAdviceTopic,
  type PriceAgentNote,
  type PriceQuestionAsk,
  type SystemMessageReport,
} from '@/lib/system-messages'
import {
  assertVaultGeneration,
  getVaultAccessState,
  withVaultWrite,
} from '@/lib/vault-access'

/**
 * The AI supervisor. On a schedule it shows the model the whole state of
 * price monitoring (every knife's market and sources, every store's pacing,
 * coverage, the AI budget and how its last actions turned out) and the
 * model answers with actions from a fixed set:
 *
 * - check: move sources to the front of their store's queue,
 * - retryWithAi: let AI read or solve a failing page on its next check,
 * - fetchMode: load a source in the browser or over plain HTTP,
 * - pause: stop a source whose page keeps failing as gone,
 * - searchOtherStore: look for a knife on other stores (Other stores),
 * - watchClosely: check a knife's sources more often for a while,
 * - crossCheck: read a knife's other stores now,
 * - advise: leave the collector a note in the Inbox,
 * - ask: ask the collector a yes/no question in the Inbox,
 * - remember / forget: keep short notes for its later runs.
 *
 * Every action is validated and capped here, never trusted. Checks still run
 * through the paced queue: one product at a time per store, with store gaps,
 * Retry-After, AI pacing advice and the circuit breaker all in force, so the
 * agent can reorder work but never speed a store up. It sees knife names,
 * store names and prices (current, regular and target), never URLs, keys
 * or notes. In observe mode it only journals what it would do.
 */
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/** A run at least this often, with or without events (the heartbeat). */
export const AGENT_HEARTBEAT_UNLIMITED_MS = 60 * MINUTE_MS
export const AGENT_HEARTBEAT_LIMITED_MS = 6 * 60 * MINUTE_MS
/** Events wake the supervisor, but no sooner than this after its last run. */
export const AGENT_EVENT_GAP_UNLIMITED_MS = 10 * MINUTE_MS
export const AGENT_EVENT_GAP_LIMITED_MS = 60 * MINUTE_MS
/** The first event waits this long, so a burst of changes is seen at once. */
export const AGENT_EVENT_BATCH_MS = 2 * MINUTE_MS
/** Events shown per run, newest first. */
export const MAX_AGENT_EVENTS = 40
/** A first run looks back this far for events. */
const FIRST_RUN_EVENTS_MS = 24 * 60 * MINUTE_MS
/** Failed checks in a row that count as an event (the streak crossing). */
const FAILING_EVENT_STREAKS = [3, 5] as const
export const AGENT_RETENTION_MS = 30 * 24 * HOUR_MS
/** The market window for a knife's recent low and high. */
export const MARKET_WINDOW_DAYS = 90
/** Sources shown to the model, most urgent first. */
export const MAX_SNAPSHOT_SOURCES = 600
/** Actions per kind and run. */
export const AGENT_LIMITS = {
  check: 25,
  retryWithAi: 10,
  fetchMode: 5,
  pause: 3,
  searchOtherStore: 5,
  watchClosely: 5,
  crossCheck: 5,
  advise: 3,
  ask: 2,
  remember: 3,
  forget: 5,
} as const
/** Notes the supervisor keeps at once, how long, and how long each is. */
export const MAX_AGENT_NOTES = 30
export const NOTE_MAX_DAYS = 30
export const NOTE_MAX_LENGTH = 200
/** Advice notes per day, and how long one knife's topic then stays quiet. */
export const ADVICE_PER_DAY = 6
export const ADVICE_REPEAT_DAYS = 3
/** Open questions at once; the same question is not asked again this long. */
export const MAX_OPEN_QUESTIONS = 3
export const QUESTION_REPEAT_DAYS = 30
/** Unanswered questions close on their own after this many days. */
export const QUESTION_EXPIRY_DAYS = 7
const TITLE_MAX = 120
const DETAIL_MAX = 400
/** Knives the supervisor may watch closely at once. */
export const MAX_FOCUSED_KNIVES = 20
/** A close watch lasts at most this long (hours). */
export const FOCUS_MAX_HOURS = 72
/** And checks at most this often (hours). */
export const FOCUS_MIN_EVERY_HOURS = 1
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
/**
 * Last errors that mean the product page seems gone: the only ones the agent
 * may pause a source for. Timeouts, network trouble, 5xx and bot checks pass.
 * HTTP 404 and 410 are not among them: the engine pauses those pages itself
 * after three in a row (MISSING_PAGE_PAUSE_AFTER).
 */
export const PAGE_GONE_ERRORS: ReadonlySet<string> = new Set([
  'not_found',
  'redirect',
])
const MISSING_PAGE_ERRORS: ReadonlySet<string> = new Set([
  'http_404',
  'http_410',
])

/** scheduled: the heartbeat; event: changes since the last run woke it. */
export type AgentTrigger = 'scheduled' | 'manual' | 'event'

export type AgentEventType =
  | 'drop'
  | 'increase'
  | 'out_of_stock'
  | 'back_in_stock'
  | 'failing'
  | 'bot_check'
  | 'found_listing'

/** Something that changed since the supervisor's last run. */
export type AgentEvent = {
  type: AgentEventType
  /** When it happened (ISO). */
  at: string
  store: string
  knifeId?: string
  knife?: string
  sourceId?: number
  /** drop and increase: "129.00 USD" to "99.00 USD", and by how much. */
  from?: string
  to?: string
  pct?: number
  /** Stock changes: the price shown, if any. */
  price?: string
  /** failing: failed checks in a row and the last error. */
  failures?: number
  error?: string
}

/** The events since a moment, newest first and capped, with the total. */
export type AgentEvents = {
  list: AgentEvent[]
  total: number
  /** Epoch ms of the oldest event; null without events. */
  oldestAt: number | null
}

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
  /** Last error code; HTTP errors carry their status, e.g. "http_404". */
  error: string | null
  failures: number
  dueInMin: number | null
  aiMinAgo: number | null
  /**
   * Already waiting at the front of its store's queue: never checked, Check
   * now, or moved forward by an earlier run.
   */
  queued: boolean
  /**
   * Due checks at the same store that run before this one (0: it is next);
   * null when it is not due.
   */
  ahead: number | null
  /** The store's current price, e.g. "129.00 USD"; null when unknown. */
  price: string | null
  stock: Availability | null
  /** Days in the current out-of-stock run; null when not out of stock. */
  outOfStockDays: number | null
  /** A listing Other stores found (only present when true). */
  foundByAi?: true
}

/** An Other stores search for a knife at one store. */
export type AgentSearch = {
  store: string
  /** not_searched: never searched there yet (it is due). */
  status: DiscoveryStatus | 'not_searched'
  /** Days until it searches again: ≤ 0 is due, null never (found). */
  nextInDays: number | null
}

/** One knife's market: what the collector cares about. */
export type AgentKnife = {
  knifeId: string
  knife: string
  /** The knife's stored regular price, e.g. "129.00 USD". */
  regular: string | null
  /** The user's alert target: drops notify at or below it. */
  target: string | null
  /** Notifications for this knife are muted. */
  muted: boolean
  /** The cheapest in-stock price now and its store. */
  best: string | null
  bestStore: string | null
  /** Lowest trusted in-stock price ever, in the best price's currency. */
  low: string | null
  /** Lowest and highest in-stock price over MARKET_WINDOW_DAYS. */
  low90d: string | null
  high90d: string | null
  lastPriceChange: {
    direction: 'drop' | 'increase'
    from: string
    to: string
    pct: number
    store: string
    daysAgo: number
  } | null
  lastStockChange: {
    kind: 'out_of_stock' | 'back_in_stock'
    store: string
    daysAgo: number
  } | null
  /** Other stores searches (only while Other stores is on). */
  search: AgentSearch[]
  /** Your close watch on the knife, while it lasts. */
  watching: {
    everyHours: number
    endsInHours: number
    reason: string
  } | null
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

export type AgentRecentRun = {
  at: string
  summary: string | null
  actions: Array<{
    kind: string
    target: string
    status: string
    /** Why it was refused. */
    note?: string
    /** What came of it: the next check, or the search it started. */
    outcome?: string
  }>
}

/** Your recent Inbox notes and questions, and what came of them. */
export type AgentInbox = {
  /** Advice of the last ADVICE_REPEAT_DAYS days. */
  advice: Array<{
    knifeId: string
    topic: PriceAdviceTopic
    hoursAgo: number
    status: 'unread' | 'read' | 'dismissed'
  }>
  /** Questions of the last QUESTION_REPEAT_DAYS days. */
  questions: Array<{
    knifeId: string
    ask: PriceQuestionAsk
    daysAgo: number
    status: 'open' | 'yes' | 'no' | 'dismissed' | 'expired'
  }>
}

const EMPTY_INBOX: AgentInbox = { advice: [], questions: [] }

/** A note the supervisor keeps for its later runs. */
export type AgentNote = {
  id: number
  /** The knife it is about; absent for a general note. */
  knifeId?: string
  knife?: string
  note: string
  createdAt: string
  expiresAt: string
}

export type AgentSnapshot = {
  now: string
  /** Why this run started. */
  trigger: AgentTrigger
  /** What changed since your last run, newest first. */
  events: Array<AgentEvent & { minutesAgo: number }>
  /** Events left out of `events` (only over MAX_AGENT_EVENTS). */
  eventsOmitted: number
  /** The server's local date and time, e.g. "Fri, 27 Nov 2026, 09:00". */
  localTime: string
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
  /** Most urgent first; the model sees them grouped under `knives`. */
  sources: AgentSource[]
  /** The market of every knife with a source in `sources`. */
  knives: AgentKnife[]
  /** Sources left out of `sources` (only when over MAX_SNAPSHOT_SOURCES). */
  omitted: number
  recentRuns: AgentRecentRun[]
  inbox: AgentInbox
  /** Your notes from earlier runs, oldest first. */
  notes: Array<
    Omit<AgentNote, 'createdAt' | 'expiresAt'> & {
      daysAgo: number
      expiresInDays: number
    }
  >
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
  last_http_status: number | null
  consecutive_failures: number
  next_check_at: string | null
  last_ai_at: string | null
  priority: number
  last_price_minor: number | null
  last_currency: string | null
  last_availability: Availability | null
  found_by_ai: number
}

type KnifeQueryRow = {
  id: string
  brand: string
  name: string
  specs: string
  target_price_minor: number | null
  target_currency: string | null
  muted: number
  focus_until: string | null
  focus_interval_ms: number | null
  focus_reason: string | null
}

/** "129.00 USD": plain amounts the model can compare, in any currency. */
export function moneyText(minor: number, currency: string): string {
  return `${fromMinorUnits(minor, currency).toFixed(currencyFractionDigits(currency))} ${currency}`
}

function storedPrice(specs: string): string | undefined {
  try {
    return (JSON.parse(specs) as { price?: string }).price
  } catch {
    return undefined
  }
}

function mostCommon(values: readonly string[]): string | null {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best: string | null = null
  for (const [value, count] of counts)
    if (best === null || count > (counts.get(best) ?? 0)) best = value
  return best
}

const daysSince = (value: string, now: number) =>
  Math.max(0, Math.round(((now - Date.parse(value)) / DAY_MS) * 10) / 10)

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

/** The last error code, with the HTTP status for HTTP errors (http_404). */
function errorLabel(code: string | null, status: number | null): string | null {
  if (code === 'http' && status !== null && Number.isInteger(status))
    return `http_${status}`
  return code
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
  trigger?: AgentTrigger
}): AgentSnapshot {
  const { database, settings, now } = input
  const lastRunAt = lastAgentRunAt(database)
  const events = readAgentEvents(
    database,
    lastRunAt ?? now - FIRST_RUN_EVENTS_MS,
  )
  const intervalMs = frequencyMs(settings.schedule)
  const monitored = new Set(
    readQueueCandidates(database, settings, now)
      .filter((candidate) => candidate.scheduled)
      .map((candidate) => candidate.sourceId),
  )
  const rows = database
    .prepare(
      `SELECT s.id, s.knife_id, k.brand, k.name, s.lane_key, s.store_name,
              s.enabled, s.status, s.fetch_override, s.last_checked_at,
              s.last_success_at, s.last_error_code, s.consecutive_failures,
              s.next_check_at, s.last_ai_at, s.priority, s.last_price_minor,
              s.last_currency, s.last_availability,
              EXISTS (SELECT 1 FROM price_discovery d
                      WHERE d.source_id = s.id) AS found_by_ai,
              (SELECT l.http_status FROM price_check_log l
               WHERE l.source_id = s.id
               ORDER BY l.started_at DESC, l.id DESC LIMIT 1) AS last_http_status
       FROM price_sources s JOIN knives k ON k.id = s.knife_id
       WHERE s.removed_at IS NULL`,
    )
    .all() as SourceQueryRow[]

  // Each store's line of due checks, in the queue's own order.
  const isDue = (row: SourceQueryRow) =>
    row.priority >= 2 ||
    (monitored.has(row.id) &&
      (row.next_check_at === null || Date.parse(row.next_check_at) <= now))
  const lines = new Map<string, SourceQueryRow[]>()
  for (const row of rows.filter(isDue)) {
    const line = lines.get(row.lane_key) ?? []
    line.push(row)
    lines.set(row.lane_key, line)
  }
  const ahead = new Map<number, number>()
  for (const line of lines.values())
    line
      .map((row) => ({
        sourceId: row.id,
        priority: row.priority,
        nextCheckAt: row.next_check_at ? Date.parse(row.next_check_at) : null,
      }))
      .sort(byUrgency)
      .forEach((entry, index) => ahead.set(entry.sourceId, index))

  const outOfStockSince = readOutOfStockSince(database)
  const all: AgentSource[] = rows.map((row) => {
    const since =
      row.last_availability === 'out_of_stock'
        ? outOfStockSince.get(row.id)
        : undefined
    return {
      id: row.id,
      knifeId: row.knife_id,
      knife: [row.brand, row.name].filter(Boolean).join(' ').slice(0, 120),
      store: row.store_name || row.lane_key,
      status: row.status,
      monitored: monitored.has(row.id),
      fetch: row.fetch_override,
      checkedMinAgo: minutesAgo(row.last_checked_at, now),
      okMinAgo: minutesAgo(row.last_success_at, now),
      error: errorLabel(row.last_error_code, row.last_http_status),
      failures: row.consecutive_failures,
      dueInMin: minutesUntil(row.next_check_at, now),
      aiMinAgo: minutesAgo(row.last_ai_at, now),
      // Never-checked sources and earlier agent picks wait at the front.
      queued: row.priority >= 1,
      ahead: ahead.get(row.id) ?? null,
      price:
        row.last_price_minor !== null && row.last_currency
          ? moneyText(row.last_price_minor, row.last_currency)
          : null,
      stock: row.last_availability,
      outOfStockDays: since ? Math.floor(daysSince(since, now)) : null,
      ...(row.found_by_ai ? { foundByAi: true as const } : {}),
    }
  })

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
  const shown = sorted.slice(0, MAX_SNAPSHOT_SOURCES)
  return {
    now: new Date(now).toISOString(),
    trigger: input.trigger ?? 'manual',
    events: events.list.map((event) => ({
      ...event,
      minutesAgo: Math.max(
        0,
        Math.round((now - Date.parse(event.at)) / MINUTE_MS),
      ),
    })),
    eventsOmitted: events.total - events.list.length,
    localTime: new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(now),
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
    sources: shown,
    knives: readAgentKnives({
      database,
      settings,
      sources: shown,
      now,
    }),
    omitted: Math.max(0, sorted.length - MAX_SNAPSHOT_SOURCES),
    recentRuns: readRecentRuns(database, 3),
    inbox: readAgentInbox(database, now),
    notes: readAgentNotes(database, now).map(
      ({ createdAt, expiresAt, ...note }) => ({
        ...note,
        daysAgo: Math.floor((now - Date.parse(createdAt)) / DAY_MS),
        expiresInDays: Math.max(
          0,
          Math.ceil((Date.parse(expiresAt) - now) / DAY_MS),
        ),
      }),
    ),
  }
}

/** The supervisor's notes that have not expired, oldest first. */
export function readAgentNotes(
  database: Database.Database,
  now = Date.now(),
): AgentNote[] {
  return (
    database
      .prepare(
        `SELECT n.id, n.knife_id, k.brand, k.name, n.note, n.created_at,
                n.expires_at
         FROM price_agent_notes n LEFT JOIN knives k ON k.id = n.knife_id
         WHERE n.expires_at > ? AND (n.knife_id IS NULL OR k.id IS NOT NULL)
         ORDER BY n.created_at, n.id`,
      )
      .all(new Date(now).toISOString()) as Array<{
      id: number
      knife_id: string | null
      brand: string | null
      name: string | null
      note: string
      created_at: string
      expires_at: string
    }>
  ).map((row) => ({
    id: row.id,
    ...(row.knife_id
      ? {
          knifeId: row.knife_id,
          knife: [row.brand, row.name].filter(Boolean).join(' '),
        }
      : {}),
    note: row.note,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }))
}

/** Forgets one note (the collector's Forget). Returns whether it existed. */
export async function forgetAgentNote(id: number): Promise<boolean> {
  return withVaultWrite(
    async () =>
      getLocalDb().prepare('DELETE FROM price_agent_notes WHERE id = ?').run(id)
        .changes > 0,
  )
}

/**
 * What changed since `since` (epoch ms): price and stock changes, sources
 * whose failure streak just reached 3 or 5, first bot checks, and listings
 * Other stores found. Read from the tables the checks already write.
 */
export function readAgentEvents(
  database: Database.Database,
  since: number,
  limit = MAX_AGENT_EVENTS,
): AgentEvents {
  const after = new Date(since).toISOString()
  const label = (brand: string, name: string) =>
    [brand, name].filter(Boolean).join(' ').slice(0, 120)
  const events: AgentEvent[] = []
  for (const row of database
    .prepare(
      `SELECT e.knife_id, k.brand, k.name, e.source_id, e.store_name,
              e.direction, e.previous_price_minor, e.price_minor, e.currency,
              e.delta_pct, e.occurred_at
       FROM price_change_events e JOIN knives k ON k.id = e.knife_id
       WHERE e.occurred_at > ?`,
    )
    .all(after) as Array<{
    knife_id: string
    brand: string
    name: string
    source_id: number
    store_name: string
    direction: 'drop' | 'increase'
    previous_price_minor: number
    price_minor: number
    currency: string
    delta_pct: number
    occurred_at: string
  }>)
    events.push({
      type: row.direction,
      at: row.occurred_at,
      store: row.store_name,
      knifeId: row.knife_id,
      knife: label(row.brand, row.name),
      sourceId: row.source_id,
      from: moneyText(row.previous_price_minor, row.currency),
      to: moneyText(row.price_minor, row.currency),
      pct: Math.round(row.delta_pct * 10) / 10,
    })
  for (const row of database
    .prepare(
      `SELECT e.knife_id, k.brand, k.name, e.source_id, e.store_name, e.kind,
              e.price_minor, e.currency, e.occurred_at
       FROM stock_events e JOIN knives k ON k.id = e.knife_id
       WHERE e.occurred_at > ?`,
    )
    .all(after) as Array<{
    knife_id: string
    brand: string
    name: string
    source_id: number
    store_name: string
    kind: 'out_of_stock' | 'back_in_stock'
    price_minor: number | null
    currency: string | null
    occurred_at: string
  }>)
    events.push({
      type: row.kind,
      at: row.occurred_at,
      store: row.store_name,
      knifeId: row.knife_id,
      knife: label(row.brand, row.name),
      sourceId: row.source_id,
      ...(row.price_minor !== null && row.currency
        ? { price: moneyText(row.price_minor, row.currency) }
        : {}),
    })
  // A failure streak crossing 3 or 5, or a first bot check, since then.
  for (const row of database
    .prepare(
      `SELECT s.id, s.knife_id, k.brand, k.name, s.store_name, s.lane_key,
              s.status, s.consecutive_failures, s.last_error_code,
              s.last_checked_at
       FROM price_sources s JOIN knives k ON k.id = s.knife_id
       WHERE s.removed_at IS NULL AND s.enabled = 1 AND s.last_checked_at > ?
         AND ((s.status IN ('failed', 'price_unavailable')
               AND s.consecutive_failures IN (${FAILING_EVENT_STREAKS.join(', ')}))
           OR (s.status = 'blocked' AND s.consecutive_failures = 1))`,
    )
    .all(after) as Array<{
    id: number
    knife_id: string
    brand: string
    name: string
    store_name: string
    lane_key: string
    status: PriceSourceStatus
    consecutive_failures: number
    last_error_code: string | null
    last_checked_at: string
  }>)
    events.push(
      row.status === 'blocked'
        ? {
            type: 'bot_check',
            at: row.last_checked_at,
            store: row.store_name || row.lane_key,
            knifeId: row.knife_id,
            knife: label(row.brand, row.name),
            sourceId: row.id,
          }
        : {
            type: 'failing',
            at: row.last_checked_at,
            store: row.store_name || row.lane_key,
            knifeId: row.knife_id,
            knife: label(row.brand, row.name),
            sourceId: row.id,
            failures: row.consecutive_failures,
            ...(row.last_error_code ? { error: row.last_error_code } : {}),
          },
    )
  for (const row of database
    .prepare(
      `SELECT d.knife_id, k.brand, k.name, d.store, d.source_id,
              d.last_attempt_at
       FROM price_discovery d JOIN knives k ON k.id = d.knife_id
       WHERE d.status = 'found' AND d.last_attempt_at > ?`,
    )
    .all(after) as Array<{
    knife_id: string
    brand: string
    name: string
    store: string
    source_id: number | null
    last_attempt_at: string
  }>)
    events.push({
      type: 'found_listing',
      at: row.last_attempt_at,
      store: row.store,
      knifeId: row.knife_id,
      knife: label(row.brand, row.name),
      ...(row.source_id !== null ? { sourceId: row.source_id } : {}),
    })
  events.sort((a, b) => b.at.localeCompare(a.at))
  const oldest = events.at(-1)
  return {
    list: events.slice(0, limit),
    total: events.length,
    oldestAt: oldest ? Date.parse(oldest.at) : null,
  }
}

/** The supervisor's own recent Inbox messages, so it does not repeat itself. */
function readAgentInbox(database: Database.Database, now: number): AgentInbox {
  const rows = database
    .prepare(
      `SELECT kind, payload, created_at, read_at, dismissed_at, resolved_at,
              answer
       FROM system_messages
       WHERE kind IN ('price-advice', 'price-question') AND created_at >= ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(
      new Date(
        now - Math.max(ADVICE_REPEAT_DAYS, QUESTION_REPEAT_DAYS) * DAY_MS,
      ).toISOString(),
    ) as Array<{
    kind: string
    payload: string | null
    created_at: string
    read_at: string | null
    dismissed_at: string | null
    resolved_at: string | null
    answer: string | null
  }>
  const inbox: AgentInbox = { advice: [], questions: [] }
  for (const row of rows) {
    let note: PriceAgentNote | null = null
    try {
      note = row.payload ? readPriceAgentNote(JSON.parse(row.payload)) : null
    } catch {
      note = null
    }
    if (!note) continue
    const age = now - Date.parse(row.created_at)
    if (note.type === 'advice' && row.kind === 'price-advice') {
      if (age > ADVICE_REPEAT_DAYS * DAY_MS) continue
      inbox.advice.push({
        knifeId: note.knifeId,
        topic: note.topic,
        hoursAgo: Math.round((age / HOUR_MS) * 10) / 10,
        status: row.dismissed_at
          ? 'dismissed'
          : row.read_at
            ? 'read'
            : 'unread',
      })
    } else if (note.type === 'question' && row.kind === 'price-question') {
      inbox.questions.push({
        knifeId: note.knifeId,
        ask: note.ask,
        daysAgo: Math.floor(age / DAY_MS),
        status:
          row.answer === 'yes' || row.answer === 'no'
            ? row.answer
            : row.resolved_at
              ? 'expired'
              : row.dismissed_at
                ? 'dismissed'
                : 'open',
      })
    }
  }
  return inbox
}

/** Every listed knife's market, in the order its first source appears. */
function readAgentKnives(input: {
  database: Database.Database
  settings: PriceMonitoringSettings
  sources: readonly AgentSource[]
  now: number
}): AgentKnife[] {
  const { database, settings, sources, now } = input
  const knifeIds = [...new Set(sources.map((source) => source.knifeId))]
  if (!knifeIds.length) return []
  const knives = new Map(
    (
      database
        .prepare(
          `SELECT k.id, k.brand, k.name, k.specs, w.target_price_minor,
                  w.target_currency, COALESCE(w.notify_muted, 0) AS muted,
                  w.focus_until, w.focus_interval_ms, w.focus_reason
           FROM knives k LEFT JOIN price_watch w ON w.knife_id = k.id
           WHERE k.id IN (SELECT knife_id FROM price_sources
                          WHERE removed_at IS NULL)`,
        )
        .all() as KnifeQueryRow[]
    ).map((row) => [row.id, row]),
  )
  const windowStart = new Date(now - MARKET_WINDOW_DAYS * DAY_MS).toISOString()
  // Trusted in-stock prices only: readings AI did not confirm never count.
  const ranges = database
    .prepare(
      `SELECT knife_id, currency, MIN(price_minor) AS low,
              MIN(CASE WHEN last_seen_at >= ? THEN price_minor END) AS low90,
              MAX(CASE WHEN last_seen_at >= ? THEN price_minor END) AS high90
       FROM price_snapshots
       WHERE price_minor IS NOT NULL AND currency IS NOT NULL
         AND availability <> 'out_of_stock'
         AND (ai_review IS NULL OR ai_review <> 'unconfirmed')
       GROUP BY knife_id, currency`,
    )
    .all(windowStart, windowStart) as Array<{
    knife_id: string
    currency: string
    low: number
    low90: number | null
    high90: number | null
  }>
  const rangeOf = new Map(
    ranges.map((row) => [`${row.knife_id}\n${row.currency}`, row]),
  )
  const lastPrice = new Map(
    (
      database
        .prepare(
          `SELECT * FROM (
             SELECT knife_id, direction, previous_price_minor, price_minor,
                    currency, delta_pct, store_name, occurred_at,
                    ROW_NUMBER() OVER (
                      PARTITION BY knife_id ORDER BY occurred_at DESC, id DESC
                    ) AS rank
             FROM price_change_events
           ) WHERE rank = 1`,
        )
        .all() as Array<{
        knife_id: string
        direction: 'drop' | 'increase'
        previous_price_minor: number
        price_minor: number
        currency: string
        delta_pct: number
        store_name: string
        occurred_at: string
      }>
    ).map((row) => [row.knife_id, row]),
  )
  const lastStock = new Map(
    (
      database
        .prepare(
          `SELECT * FROM (
             SELECT knife_id, kind, store_name, occurred_at,
                    ROW_NUMBER() OVER (
                      PARTITION BY knife_id ORDER BY occurred_at DESC, id DESC
                    ) AS rank
             FROM stock_events
           ) WHERE rank = 1`,
        )
        .all() as Array<{
        knife_id: string
        kind: 'out_of_stock' | 'back_in_stock'
        store_name: string
        occurred_at: string
      }>
    ).map((row) => [row.knife_id, row]),
  )
  const searchStores = enabledDiscoveryStores(settings).map(
    (id) => DISCOVERY_STORES[id],
  )
  const searches = new Map<
    string,
    { status: DiscoveryStatus; next_attempt_at: string | null }
  >()
  if (searchStores.length)
    for (const row of database
      .prepare(
        `SELECT knife_id, store, marketplace, status, next_attempt_at
         FROM price_discovery`,
      )
      .all() as Array<{
      knife_id: string
      store: string
      marketplace: string
      status: DiscoveryStatus
      next_attempt_at: string | null
    }>)
      searches.set(`${row.knife_id}\n${row.store}\n${row.marketplace}`, row)
  // Lanes of every active source, not only the listed ones.
  const knifeLanes = new Map<string, Set<string>>()
  for (const row of database
    .prepare(
      'SELECT knife_id, lane_key FROM price_sources WHERE removed_at IS NULL',
    )
    .all() as Array<{ knife_id: string; lane_key: string }>) {
    const lanes = knifeLanes.get(row.knife_id) ?? new Set<string>()
    lanes.add(row.lane_key)
    knifeLanes.set(row.knife_id, lanes)
  }

  const sourcesOf = new Map<string, AgentSource[]>()
  for (const source of sources) {
    const list = sourcesOf.get(source.knifeId) ?? []
    list.push(source)
    sourcesOf.set(source.knifeId, list)
  }
  const priced = database.prepare(
    `SELECT store_name, lane_key, last_price_minor, last_currency
     FROM price_sources
     WHERE knife_id = ? AND removed_at IS NULL
       AND last_price_minor IS NOT NULL AND last_currency IS NOT NULL
       AND (last_availability IS NULL OR last_availability <> 'out_of_stock')
     ORDER BY last_price_minor, id`,
  )

  return knifeIds.map((knifeId): AgentKnife => {
    const knife = knives.get(knifeId)
    const listed = sourcesOf.get(knifeId) ?? []
    const offers = priced.all(knifeId) as Array<{
      store_name: string
      lane_key: string
      last_price_minor: number
      last_currency: string
    }>
    const paid = knife ? parseStoredPrice(storedPrice(knife.specs)) : null
    const currency =
      mostCommon(offers.map((offer) => offer.last_currency)) ??
      (paid?.currency || null)
    const best = offers.find((offer) => offer.last_currency === currency)
    const range = currency ? rangeOf.get(`${knifeId}\n${currency}`) : undefined
    const regularCurrency = paid ? paid.currency || currency : null
    const change = lastPrice.get(knifeId)
    const stock = lastStock.get(knifeId)
    const lanes = knifeLanes.get(knifeId) ?? new Set<string>()
    const focusUntil = knife?.focus_until ? Date.parse(knife.focus_until) : NaN
    const watching =
      knife?.focus_interval_ms && focusUntil > now
        ? {
            everyHours:
              Math.round((knife.focus_interval_ms / HOUR_MS) * 10) / 10,
            endsInHours: Math.round(((focusUntil - now) / HOUR_MS) * 10) / 10,
            reason: knife.focus_reason ?? '',
          }
        : null
    return {
      knifeId,
      knife: listed[0]?.knife ?? knifeId,
      regular:
        paid && regularCurrency
          ? `${paid.amount.toFixed(currencyFractionDigits(regularCurrency))} ${regularCurrency}`
          : null,
      target:
        typeof knife?.target_price_minor === 'number' && knife.target_currency
          ? moneyText(knife.target_price_minor, knife.target_currency)
          : null,
      muted: knife?.muted === 1,
      best: best ? moneyText(best.last_price_minor, best.last_currency) : null,
      bestStore: best ? best.store_name || best.lane_key : null,
      low: range && currency ? moneyText(range.low, currency) : null,
      low90d:
        typeof range?.low90 === 'number' && currency
          ? moneyText(range.low90, currency)
          : null,
      high90d:
        typeof range?.high90 === 'number' && currency
          ? moneyText(range.high90, currency)
          : null,
      lastPriceChange: change
        ? {
            direction: change.direction,
            from: moneyText(change.previous_price_minor, change.currency),
            to: moneyText(change.price_minor, change.currency),
            pct: Math.round(change.delta_pct * 10) / 10,
            store: change.store_name,
            daysAgo: daysSince(change.occurred_at, now),
          }
        : null,
      lastStockChange: stock
        ? {
            kind: stock.kind,
            store: stock.store_name,
            daysAgo: daysSince(stock.occurred_at, now),
          }
        : null,
      // A store the knife already has a source at is never searched.
      search: searchStores
        .filter((store) => !lanes.has(store.laneKey))
        .map((store): AgentSearch => {
          const row = searches.get(
            `${knifeId}\n${store.id}\n${store.marketplace}`,
          )
          if (!row)
            return { store: store.label, status: 'not_searched', nextInDays: 0 }
          return {
            store: store.label,
            status: row.status,
            nextInDays: row.next_attempt_at
              ? Math.round(
                  ((Date.parse(row.next_attempt_at) - now) / DAY_MS) * 10,
                ) / 10
              : null,
          }
        }),
      watching,
    }
  })
}

/** Whether searchOtherStore would bring a waiting search forward. */
function searchRefusal(knife: AgentKnife | undefined): string | null {
  if (!knife) return 'unknown knife'
  if (!knife.search.length) return 'no other store to search'
  if (knife.search.some((search) => (search.nextInDays ?? 0) > 0)) return null
  return knife.search.every((search) => search.status === 'found')
    ? 'already found'
    : 'already due'
}

/** The last runs, each action with why it was refused or what came of it. */
function readRecentRuns(
  database: Database.Database,
  limit: number,
): AgentRecentRun[] {
  const nextCheck = database.prepare(
    `SELECT outcome, error_code, http_status, started_at FROM price_check_log
     WHERE source_id = ? AND started_at >= ?
     ORDER BY started_at, id LIMIT 1`,
  )
  const searched = database.prepare(
    `SELECT store, status FROM price_discovery
     WHERE knife_id = ? AND last_attempt_at >= ? ORDER BY store`,
  )
  const knifeChecks = database.prepare(
    `SELECT COUNT(*) AS count FROM price_check_log
     WHERE knife_id = ? AND started_at >= ?`,
  )
  const message = database.prepare(
    `SELECT read_at, dismissed_at, resolved_at, answer FROM system_messages
     WHERE kind = ? AND dedupe_key = ?`,
  )
  type CheckRow = {
    outcome: string
    error_code: string | null
    http_status: number | null
    started_at: string
  }
  const result = (check: CheckRow) => {
    const error =
      check.outcome === 'ok'
        ? null
        : errorLabel(check.error_code, check.http_status)
    return `${check.outcome}${error ? ` (${error})` : ''}`
  }
  const noteKept = database.prepare(
    'SELECT expires_at FROM price_agent_notes WHERE id = ?',
  )
  const outcome = (run: AgentRun, action: AgentAction): string | undefined => {
    if (action.status === 'refused') return undefined
    if (action.kind === 'forget') return undefined
    if (action.kind === 'remember')
      return action.noteId !== undefined && noteKept.get(action.noteId)
        ? `kept as note ${action.noteId}`
        : action.noteId === undefined
          ? undefined
          : 'forgotten or expired'
    if (action.kind === 'advise' || action.kind === 'ask') {
      if (!action.message?.key) return undefined
      const row = message.get(
        action.kind === 'advise' ? 'price-advice' : 'price-question',
        action.message.key,
      ) as
        | {
            read_at: string | null
            dismissed_at: string | null
            resolved_at: string | null
            answer: string | null
          }
        | undefined
      if (!row) return 'no longer in the Inbox'
      if (action.kind === 'advise')
        return row.dismissed_at ? 'dismissed' : row.read_at ? 'read' : 'unread'
      return row.answer
        ? `answered ${row.answer}`
        : row.resolved_at
          ? 'expired unanswered'
          : row.dismissed_at
            ? 'dismissed'
            : 'waiting for an answer'
    }
    if (action.kind === 'crossCheck') {
      const ids = action.sourceIds ?? []
      const checks = ids
        .map((id) => nextCheck.get(id, run.startedAt) as CheckRow | undefined)
        .filter((check): check is CheckRow => Boolean(check))
      return checks.length
        ? `read ${checks.length} of ${ids.length}: ${checks.map(result).join(', ')}`
        : 'not checked since'
    }
    if (action.kind === 'watchClosely' && action.knifeId !== undefined) {
      const { count } = knifeChecks.get(action.knifeId, run.startedAt) as {
        count: number
      }
      return `${count} check${count === 1 ? '' : 's'} since`
    }
    if (action.sourceId !== undefined) {
      const check = nextCheck.get(action.sourceId, run.startedAt) as
        CheckRow | undefined
      if (!check) return 'not checked since'
      const after = Math.max(
        0,
        Math.round(
          (Date.parse(check.started_at) - Date.parse(run.startedAt)) /
            MINUTE_MS,
        ),
      )
      return `next check: ${result(check)}, ${after} min later`
    }
    if (action.knifeId === undefined) return undefined
    const rows = searched.all(action.knifeId, run.startedAt) as Array<{
      store: string
      status: string
    }>
    return rows.length
      ? `searched: ${rows.map((row) => `${row.store} ${row.status}`).join(', ')}`
      : 'not searched since'
  }
  return readAgentRuns(database, limit).map((run) => ({
    at: run.startedAt,
    summary: run.summary,
    actions: run.actions.map((action) => ({
      kind: action.kind,
      target:
        action.sourceId !== undefined
          ? `source ${action.sourceId}`
          : action.knifeId !== undefined
            ? `knife ${action.knifeId}`
            : action.noteId !== undefined
              ? `note ${action.noteId}`
              : 'general',
      status: action.status,
      note: action.note ?? undefined,
      outcome: outcome(run, action),
    })),
  }))
}

/**
 * What the model reads: knives with their market and their sources nested
 * (without the knife fields repeated), empty values left out.
 */
export function agentModelInput(snapshot: AgentSnapshot): string {
  const sourcesOf = new Map<string, Array<Record<string, unknown>>>()
  for (const { knifeId, knife: _knife, ...source } of snapshot.sources) {
    const list = sourcesOf.get(knifeId) ?? []
    list.push(source)
    sourcesOf.set(knifeId, list)
  }
  const { sources: _sources, knives, events, ...rest } = snapshot
  return JSON.stringify(
    {
      ...rest,
      events: events.map(({ at: _at, ...event }) => event),
      knives: knives.map((knife) => ({
        ...knife,
        sources: sourcesOf.get(knife.knifeId) ?? [],
      })),
    },
    (_key, value: unknown) => (value === null ? undefined : value),
  )
}

// ------------------------------------------------------------- the plan

type PlanItem = { sourceId: number; reason: string }
export type AgentPlan = {
  summary: string
  check: PlanItem[]
  retryWithAi: PlanItem[]
  fetchMode: Array<PlanItem & { mode: FetchOverride }>
  pause: PlanItem[]
  searchOtherStore: KnifeItem[]
  watchClosely: Array<KnifeItem & { hours: number; everyHours: number }>
  crossCheck: KnifeItem[]
  advise: AdviceItem[]
  ask: AskItem[]
  remember: RememberItem[]
  forget: Array<{ noteId: number; reason: string }>
}
type KnifeItem = { knifeId: string; reason: string }
type RememberItem = {
  /** The knife it is about, or null for a general note. */
  knifeId: string | null
  note: string
  /** How long to keep it (days, at most NOTE_MAX_DAYS). */
  days: number
}
type AdviceItem = {
  knifeId: string
  topic: PriceAdviceTopic
  title: string
  detail: string
}
type AskItem = {
  knifeId: string
  ask: PriceQuestionAsk
  question: string
  /** set_target: the suggested target, e.g. "95.00 USD". */
  price: string | null
  /** keep_listing: the listing in question. */
  sourceId: number | null
  /** watch_closely: for how long, and how often. */
  hours: number | null
  everyHours: number | null
}

const knifeItems = (extra: Record<string, unknown> = {}) => ({
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['knifeId', 'reason', ...Object.keys(extra)],
    properties: {
      knifeId: { type: 'string' },
      reason: { type: 'string' },
      ...extra,
    },
  },
})

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
    'watchClosely',
    'crossCheck',
    'advise',
    'ask',
    'remember',
    'forget',
  ],
  properties: {
    summary: { type: 'string' },
    check: item(),
    retryWithAi: item(),
    fetchMode: item({ mode: { type: 'string', enum: [...FETCH_OVERRIDES] } }),
    pause: item(),
    searchOtherStore: knifeItems(),
    watchClosely: knifeItems({
      hours: { type: 'number' },
      everyHours: { type: 'number' },
    }),
    crossCheck: knifeItems(),
    advise: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['knifeId', 'topic', 'title', 'detail'],
        properties: {
          knifeId: { type: 'string' },
          topic: { type: 'string', enum: [...PRICE_ADVICE_TOPICS] },
          title: { type: 'string' },
          detail: { type: 'string' },
        },
      },
    },
    ask: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'knifeId',
          'ask',
          'question',
          'price',
          'sourceId',
          'hours',
          'everyHours',
        ],
        properties: {
          knifeId: { type: 'string' },
          ask: { type: 'string', enum: [...PRICE_QUESTION_ASKS] },
          question: { type: 'string' },
          price: { type: ['string', 'null'] },
          sourceId: { type: ['integer', 'null'] },
          hours: { type: ['number', 'null'] },
          everyHours: { type: ['number', 'null'] },
        },
      },
    },
    remember: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['knifeId', 'note', 'days'],
        properties: {
          knifeId: { type: ['string', 'null'] },
          note: { type: 'string' },
          days: { type: 'number' },
        },
      },
    },
    forget: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['noteId', 'reason'],
        properties: {
          noteId: { type: 'integer' },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const

export const AGENT_PROMPT = [
  'You supervise price monitoring for a knife collector. Each source is one store product page that BladeVault checks for price and stock. Keep every monitored source fresh and readable, and spend checks where they matter most to the collector right now.',
  "trigger says why you run: event (events woke you: react to them), scheduled (your regular look over everything) or manual (the collector asked). events lists what changed since your last run, newest first: drop and increase (from, to, pct), out_of_stock and back_in_stock, failing (a source's failures in a row reached 3 or 5), bot_check (a store showed a bot check), found_listing (Other stores found the knife at a store). After a move at one store, crossCheck the knife's other stores; after a drop near the target or a restock, consider watchClosely or advise.",
  "The input lists knives, most urgent first. Each knife has its market: regular (the knife's stored regular price), target (the collector's alert price), best (the cheapest in-stock price now) and bestStore, low (lowest in-stock price ever), low90d and high90d, lastPriceChange, lastStockChange, muted, and search (Other stores searches). Under it are its sources: status, price, stock, outOfStockDays, timing in minutes, failures, error, queued and ahead. The input also has each store's pace, coverage, the AI budget, localTime and your recent runs, each action with its note (why it was refused) or outcome (what its next check or search found). Missing fields are unknown.",
  'Answer with JSON only: {"summary", "check", "retryWithAi", "fetchMode", "pause", "searchOtherStore", "watchClosely", "crossCheck", "advise", "ask", "remember", "forget"}. Leave a list empty when nothing is needed: often nothing is.',
  `check (at most ${AGENT_LIMITS.check}): move sources to the front of their store's line. Each store already checks its most overdue source first, so a due source with ahead 0 is next anyway and a check changes nothing. Use check to put a source that matters more ahead of others (ahead above 0), or to read a source that is not due yet now: a knife near or below its target or regular price, a price that just moved at another store, a restock to confirm, a sale period (look at localTime, e.g. Black Friday and holiday sales). Skip sources marked queued, checked in the last 30 minutes, or not monitored.`,
  'A store checks one product at a time at its own safe pace (minGapSec, fullPassHours), and paused stores (circuit open) wait out their pause. You cannot speed a store up: many checks at one store simply wait in line, so do not ask for more than the stores can do before your next run.',
  `retryWithAi (at most ${AGENT_LIMITS.retryWithAi}): failed or price_unavailable sources where AI reading or working the page may get the price on the next check. Never for blocked sources: a bot check needs the user.`,
  `fetchMode (at most ${AGENT_LIMITS.fetchMode}): "browser" when a source keeps failing in a way a real browser may fix (scripts, empty pages, timeouts), "http" only for a fast simple page, "auto" to undo. Look at a source's fetch first.`,
  `pause (at most ${AGENT_LIMITS.pause}): only sources that failed at least ${PAUSE_MIN_FAILURES} checks in a row and whose page seems gone (not_found or redirect). Pages not found with HTTP 404 or 410 pause on their own. The user can resume them.`,
  `searchOtherStore (at most ${AGENT_LIMITS.searchOtherStore}): bring a waiting Other stores search forward (a search with nextInDays above 0), for knives whose sources are all out of stock or failing, or that the collector watches closely (a target, a recent drop) and that have a single store. Only when otherStores is true. A search that is due (not_searched, nextInDays 0 or less) or found needs nothing.`,
  `watchClosely (at most ${AGENT_LIMITS.watchClosely}, ${MAX_FOCUSED_KNIVES} knives at once): check a knife's sources every everyHours (at least ${FOCUS_MIN_EVERY_HOURS}, below checkIntervalHours) for the next hours (at most ${FOCUS_MAX_HOURS}): a knife near or below its target or regular price, a fresh drop that may go lower, a restock to catch, a sale period. Asking again for a watched knife replaces its watch. The stores' pace still applies.`,
  `crossCheck (at most ${AGENT_LIMITS.crossCheck}): read all other sources of a knife now, for example after its price moved or it came back in stock at one store, so the collector sees the whole market. Sources checked in the last 30 minutes, queued or blocked are left out.`,
  `advise (at most ${AGENT_LIMITS.advise}, ${ADVICE_PER_DAY} a day): a short note in the collector's Inbox when something is worth acting on: topic "deal" (a price at or below the target or regular price, a new 90-day low, a big drop), "restock" (back in stock after a long time, or the only store in stock), "watch" (a trend to keep an eye on). title: one line naming the knife; detail: one or two plain sentences. Quote only prices that appear in the input, exactly as written there, never computed amounts (say "23% below regular" for differences). Never for muted knives, and not again for the same knife and topic within ${ADVICE_REPEAT_DAYS} days (see inbox.advice). Fewer, better notes: the collector already gets an alert for every drop.`,
  `ask (at most ${AGENT_LIMITS.ask}, ${MAX_OPEN_QUESTIONS} open at once, one per knife): a yes/no question in the Inbox when the collector's answer changes what you do. "set_target" proposes an alert target price (price, e.g. "95.00 USD", in the currency of the knife's prices) for a knife without a fitting target. "watch_closely" asks to watch a knife closely (hours, everyHours, as for watchClosely) when you are not sure it is wanted. "keep_listing" asks whether a listing Other stores found (sourceId of a source with foundByAi) is the right knife, when its price or stock looks off; No pauses it. question: one plain sentence. Never repeat a question from inbox.questions within ${QUESTION_REPEAT_DAYS} days, and respect its answer. Use null for fields an ask does not use.`,
  `remember (at most ${AGENT_LIMITS.remember}, ${MAX_AGENT_NOTES} kept at once): a short note (at most ${NOTE_MAX_LENGTH} characters) for your later runs, about one knife (knifeId) or in general (knifeId null), kept for days (at most ${NOTE_MAX_DAYS}): what you are waiting for, a pattern you noticed (a store that restocks on Mondays, a knife whose price moves before sales), what the collector's answers told you. Not facts the input already shows. Your notes are in notes; forget (at most ${AGENT_LIMITS.forget}) notes that are done or wrong, by noteId.`,
  'Learn from your recent runs, inbox and notes: do not repeat actions that were refused or did not help.',
  'Every item needs a short reason. summary: one to three plain sentences for the collector: notable market news (drops, prices at or below target or regular price, restocks) and what you did. If nothing changed since your last run, say so in one short sentence.',
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
      knifeItem,
    ),
    watchClosely: readItems(
      record.watchClosely,
      AGENT_LIMITS.watchClosely,
      (entry) => {
        const base = knifeItem(entry)
        const { hours, everyHours } = entry
        if (
          !base ||
          typeof hours !== 'number' ||
          typeof everyHours !== 'number' ||
          !Number.isFinite(hours) ||
          !Number.isFinite(everyHours)
        )
          return null
        return {
          ...base,
          hours: Math.min(FOCUS_MAX_HOURS, Math.max(1, hours)),
          everyHours: Math.max(FOCUS_MIN_EVERY_HOURS, everyHours),
        }
      },
    ),
    crossCheck: readItems(
      record.crossCheck,
      AGENT_LIMITS.crossCheck,
      knifeItem,
    ),
    advise: readItems(record.advise, AGENT_LIMITS.advise, (entry) => {
      const knifeId = text(entry.knifeId, 100)
      const title = text(entry.title, TITLE_MAX)
      const detail = text(entry.detail, DETAIL_MAX)
      return knifeId &&
        title &&
        (PRICE_ADVICE_TOPICS as readonly unknown[]).includes(entry.topic)
        ? {
            knifeId,
            topic: entry.topic as PriceAdviceTopic,
            title,
            detail,
          }
        : null
    }),
    remember: readItems(record.remember, AGENT_LIMITS.remember, (entry) => {
      const note = text(entry.note, NOTE_MAX_LENGTH)
      const days =
        typeof entry.days === 'number' && Number.isFinite(entry.days)
          ? Math.min(NOTE_MAX_DAYS, Math.max(1, Math.round(entry.days)))
          : NOTE_MAX_DAYS
      return note
        ? { knifeId: text(entry.knifeId, 100) || null, note, days }
        : null
    }),
    forget: readItems(record.forget, AGENT_LIMITS.forget, (entry) =>
      typeof entry.noteId === 'number' &&
      Number.isInteger(entry.noteId) &&
      entry.noteId > 0
        ? { noteId: entry.noteId, reason: text(entry.reason, REASON_MAX) }
        : null,
    ),
    ask: readItems(record.ask, AGENT_LIMITS.ask, (entry) => {
      const knifeId = text(entry.knifeId, 100)
      const question = text(entry.question, DETAIL_MAX)
      if (
        !knifeId ||
        !question ||
        !(PRICE_QUESTION_ASKS as readonly unknown[]).includes(entry.ask)
      )
        return null
      const finite = (value: unknown) =>
        typeof value === 'number' && Number.isFinite(value) ? value : null
      const hours = finite(entry.hours)
      const everyHours = finite(entry.everyHours)
      const sourceId = finite(entry.sourceId)
      return {
        knifeId,
        ask: entry.ask as PriceQuestionAsk,
        question,
        price: text(entry.price, 40) || null,
        sourceId:
          sourceId !== null && Number.isInteger(sourceId) && sourceId > 0
            ? sourceId
            : null,
        hours:
          hours === null ? null : Math.min(FOCUS_MAX_HOURS, Math.max(1, hours)),
        everyHours:
          everyHours === null
            ? null
            : Math.max(FOCUS_MIN_EVERY_HOURS, everyHours),
      }
    }),
  }
}

const knifeItem = (entry: Record<string, unknown>): KnifeItem | null => {
  const id = text(entry.knifeId, 100)
  return id ? { knifeId: id, reason: text(entry.reason, REASON_MAX) } : null
}

export type AgentActionKind =
  | 'check'
  | 'retryWithAi'
  | 'fetchMode'
  | 'pause'
  | 'searchOtherStore'
  | 'watchClosely'
  | 'crossCheck'
  | 'advise'
  | 'ask'
  | 'remember'
  | 'forget'

/** The Inbox message an advise or ask action leaves. */
export type AgentMessage = {
  title: string
  detail: string
  payload: PriceAgentNote
  /** Set once posted (Act), to look up what came of it. */
  key?: string
}

export type AgentAction = {
  kind: AgentActionKind
  sourceId?: number
  knifeId?: string
  /** crossCheck: the knife's sources it reads now. */
  sourceIds?: number[]
  mode?: FetchOverride
  /** watchClosely: for how long, and how often. */
  hours?: number
  everyHours?: number
  /** advise and ask: the Inbox message. */
  message?: AgentMessage
  /** remember: the note and for how many days; forget: which note. */
  memory?: string
  days?: number
  noteId?: number
  reason: string
  /** applied (act), proposed (observe), refused (failed validation). */
  status: 'applied' | 'proposed' | 'refused'
  note: string | null
}

/** Why a source may not be moved forward now, or null. */
function checkRefusal(source: AgentSource | null): string | null {
  return !source
    ? 'unknown source'
    : !source.monitored
      ? 'not monitored'
      : source.queued
        ? 'already queued'
        : source.checkedMinAgo !== null &&
            source.checkedMinAgo * MINUTE_MS < RECHECK_MIN_MS
          ? 'checked less than 30 minutes ago'
          : source.status === 'blocked' &&
              source.dueInMin !== null &&
              source.dueInMin > 0
            ? 'blocked: waits for its backoff'
            : null
}

/**
 * Validates the plan against the snapshot. Pure: refused actions say why,
 * the others become `applied` (act) or `proposed` (observe) once applied.
 */
export function validateAgentPlan(
  plan: AgentPlan,
  snapshot: Pick<
    AgentSnapshot,
    'sources' | 'knives' | 'ai' | 'otherStores' | 'checkIntervalHours'
  > & {
    inbox?: AgentInbox
    notes?: Pick<AgentSnapshot['notes'][number], 'id' | 'knifeId' | 'note'>[]
  },
): AgentAction[] {
  const inbox = snapshot.inbox ?? EMPTY_INBOX
  const notes = snapshot.notes ?? []
  const byId = new Map(snapshot.sources.map((source) => [source.id, source]))
  const knives = new Map(snapshot.knives.map((knife) => [knife.knifeId, knife]))
  const seen = new Set<string>()
  const actions: AgentAction[] = []
  const push = (
    action: Omit<AgentAction, 'status' | 'note'>,
    refusal: string | null,
  ) => {
    const key = [
      action.kind,
      action.sourceId ?? action.knifeId ?? '',
      action.noteId ?? '',
      action.kind === 'remember' ? action.memory : '',
    ].join(':')
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
      checkRefusal(source) ??
        (source?.ahead === 0 ? 'already next at its store' : null),
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
              : source.error && MISSING_PAGE_ERRORS.has(source.error)
                ? 'pages not found (HTTP 404 or 410) pause on their own'
                : !source.error || !PAGE_GONE_ERRORS.has(source.error)
                  ? `the page is not gone (${source.error ?? 'no error'})`
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
        : searchRefusal(knives.get(entry.knifeId)),
    )
  }
  let watched = snapshot.knives.filter((knife) => knife.watching).length
  for (const entry of plan.watchClosely) {
    const knife = knives.get(entry.knifeId)
    push(
      {
        kind: 'watchClosely',
        knifeId: entry.knifeId,
        hours: entry.hours,
        everyHours: entry.everyHours,
        reason: entry.reason,
      },
      !knife
        ? 'unknown knife'
        : !snapshot.sources.some(
              (source) => source.knifeId === entry.knifeId && source.monitored,
            )
          ? 'no monitored source'
          : entry.everyHours >= snapshot.checkIntervalHours
            ? `not more often than the schedule (every ${snapshot.checkIntervalHours} h)`
            : !knife.watching && watched >= MAX_FOCUSED_KNIVES
              ? `already watching ${MAX_FOCUSED_KNIVES} knives`
              : null,
    )
    if (actions.at(-1)?.status !== 'refused' && !knife?.watching) watched += 1
  }
  for (const entry of plan.crossCheck) {
    const sourceIds = snapshot.sources
      .filter(
        (source) =>
          source.knifeId === entry.knifeId && checkRefusal(source) === null,
      )
      .map((source) => source.id)
    push(
      {
        kind: 'crossCheck',
        knifeId: entry.knifeId,
        sourceIds,
        reason: entry.reason,
      },
      !knives.has(entry.knifeId)
        ? 'unknown knife'
        : !sourceIds.length
          ? 'no source to read now'
          : null,
    )
  }

  let adviceToday = inbox.advice.filter((entry) => entry.hoursAgo < 24).length
  for (const entry of plan.advise) {
    const knife = knives.get(entry.knifeId)
    const invented = knife
      ? inventedAmount(
          `${entry.title} ${entry.detail}`,
          knownAmounts(knife, snapshot.sources),
        )
      : null
    push(
      {
        kind: 'advise',
        knifeId: entry.knifeId,
        reason: entry.detail || entry.title,
        message: {
          title: entry.title,
          detail: entry.detail,
          payload: {
            type: 'advice',
            knifeId: entry.knifeId,
            topic: entry.topic,
          },
        },
      },
      !knife
        ? 'unknown knife'
        : knife.muted
          ? 'notifications for this knife are muted'
          : adviceToday >= ADVICE_PER_DAY
            ? `already ${ADVICE_PER_DAY} notes today`
            : inbox.advice.some(
                  (note) =>
                    note.knifeId === entry.knifeId &&
                    note.topic === entry.topic,
                )
              ? `same advice in the last ${ADVICE_REPEAT_DAYS} days`
              : LINK.test(`${entry.title} ${entry.detail}`)
                ? 'links are not allowed'
                : invented
                  ? `quotes a price not in the data (${invented})`
                  : null,
    )
    if (actions.at(-1)?.status !== 'refused') adviceToday += 1
  }

  const waiting = new Set(
    inbox.questions
      .filter((question) => question.status === 'open')
      .map((question) => question.knifeId),
  )
  for (const entry of plan.ask) {
    const knife = knives.get(entry.knifeId)
    let refusal: string | null = !knife
      ? 'unknown knife'
      : knife.muted
        ? 'notifications for this knife are muted'
        : waiting.has(entry.knifeId)
          ? 'a question about this knife is waiting'
          : waiting.size >= MAX_OPEN_QUESTIONS
            ? `already ${MAX_OPEN_QUESTIONS} open questions`
            : inbox.questions.some(
                  (question) =>
                    question.knifeId === entry.knifeId &&
                    question.ask === entry.ask,
                )
              ? `asked the same in the last ${QUESTION_REPEAT_DAYS} days`
              : LINK.test(entry.question)
                ? 'links are not allowed'
                : null
    let message: AgentMessage | undefined
    if (knife && !refusal) {
      const asked = askMessage(entry, knife, snapshot, byId)
      if (typeof asked === 'string') refusal = asked
      else message = asked
    }
    push(
      {
        kind: 'ask',
        knifeId: entry.knifeId,
        reason: entry.question,
        ...(message ? { message } : {}),
      },
      refusal,
    )
    if (actions.at(-1)?.status !== 'refused') waiting.add(entry.knifeId)
  }

  // Forgetting first frees room for new notes.
  let kept = notes.length
  for (const entry of plan.forget) {
    push(
      { kind: 'forget', noteId: entry.noteId, reason: entry.reason },
      notes.some((note) => note.id === entry.noteId) ? null : 'unknown note',
    )
    if (actions.at(-1)?.status !== 'refused') kept -= 1
  }
  const allAmounts = new Set(
    snapshot.knives.flatMap((knife) => [
      ...knownAmounts(knife, snapshot.sources),
    ]),
  )
  for (const entry of plan.remember) {
    const knife = entry.knifeId ? knives.get(entry.knifeId) : undefined
    const invented = inventedAmount(
      entry.note,
      knife ? knownAmounts(knife, snapshot.sources) : allAmounts,
    )
    push(
      {
        kind: 'remember',
        ...(entry.knifeId ? { knifeId: entry.knifeId } : {}),
        memory: entry.note,
        days: entry.days,
        reason: entry.note,
      },
      entry.knifeId && !knife
        ? 'unknown knife'
        : LINK.test(entry.note)
          ? 'links are not allowed'
          : invented
            ? `quotes a price not in the data (${invented})`
            : notes.some(
                  (note) =>
                    note.note === entry.note &&
                    (note.knifeId ?? null) === entry.knifeId,
                )
              ? 'already noted'
              : kept >= MAX_AGENT_NOTES
                ? `already ${MAX_AGENT_NOTES} notes: forget one first`
                : null,
    )
    if (actions.at(-1)?.status !== 'refused') kept += 1
  }
  return actions
}

const LINK = /https?:\/\/|www\./i
const CURRENCY_CODES =
  'USD|EUR|GBP|JPY|CAD|AUD|NZD|CHF|SEK|NOK|DKK|PLN|CZK|HUF|CNY|HKD|SGD|KRW|INR|RUB|UAH|BRL|MXN|ZAR|TRY|ILS'
const QUOTED_AMOUNT = new RegExp(
  `[$€£¥]\\s?(\\d[\\d,]*(?:\\.\\d+)?)|(\\d[\\d,]*(?:\\.\\d+)?)\\s?(?:${CURRENCY_CODES})\\b`,
  'g',
)

/** Amounts written with a currency, e.g. "$99" or "129.00 USD", as numbers. */
export function quotedAmounts(value: string): number[] {
  return [...value.matchAll(QUOTED_AMOUNT)].flatMap((match) => {
    const amount = Number.parseFloat((match[1] ?? match[2]).replace(/,/g, ''))
    return Number.isFinite(amount) ? [amount] : []
  })
}

/** Every price the model saw for a knife, in hundredths. */
function knownAmounts(
  knife: AgentKnife,
  sources: readonly AgentSource[],
): Set<number> {
  return new Set(
    [
      knife.regular,
      knife.target,
      knife.best,
      knife.low,
      knife.low90d,
      knife.high90d,
      knife.lastPriceChange?.from,
      knife.lastPriceChange?.to,
      ...sources
        .filter((source) => source.knifeId === knife.knifeId)
        .map((source) => source.price),
    ].flatMap((value) => {
      const amount = value ? Number.parseFloat(value) : Number.NaN
      return Number.isFinite(amount) ? [Math.round(amount * 100)] : []
    }),
  )
}

/** The first quoted amount the model did not see, or null. */
function inventedAmount(value: string, known: Set<number>): string | null {
  const invented = quotedAmounts(value).find(
    (amount) => !known.has(Math.round(amount * 100)),
  )
  return invented === undefined ? null : String(invented)
}

/** The currencies a knife's prices are in, e.g. ["USD"]. */
function knifeCurrencies(
  knife: AgentKnife,
  sources: readonly AgentSource[],
): Set<string> {
  return new Set(
    [
      knife.regular,
      knife.best,
      ...sources
        .filter((source) => source.knifeId === knife.knifeId)
        .map((source) => source.price),
    ].flatMap((value) => {
      const code = value?.split(' ')[1]
      return code ? [code] : []
    }),
  )
}

/** The Inbox question an ask leaves, or why it is refused. */
function askMessage(
  entry: AskItem,
  knife: AgentKnife,
  snapshot: Pick<AgentSnapshot, 'sources' | 'checkIntervalHours'>,
  byId: ReadonlyMap<number, AgentSource>,
): AgentMessage | string {
  const known = knownAmounts(knife, snapshot.sources)
  let message: AgentMessage
  switch (entry.ask) {
    case 'set_target': {
      const parsed = entry.price ? parseStoredPrice(entry.price) : null
      if (!parsed) return 'no valid price'
      const currencies = knifeCurrencies(knife, snapshot.sources)
      if (currencies.size && !currencies.has(parsed.currency))
        return `not in the knife's currency (${[...currencies].join(', ')})`
      const priceMinor = toMinorUnits(parsed.amount, parsed.currency)
      const price = moneyText(priceMinor, parsed.currency)
      if (knife.target === price) return 'already the target'
      known.add(Math.round(parsed.amount * 100))
      message = {
        title: `Set a ${price} target for ${knife.knife}?`,
        detail: entry.question,
        payload: {
          type: 'question',
          knifeId: knife.knifeId,
          ask: 'set_target',
          priceMinor,
          currency: parsed.currency,
        },
      }
      break
    }
    case 'watch_closely': {
      if (entry.hours === null || entry.everyHours === null)
        return 'hours and everyHours are needed'
      if (knife.watching) return 'already watched closely'
      if (
        !snapshot.sources.some(
          (source) => source.knifeId === knife.knifeId && source.monitored,
        )
      )
        return 'no monitored source'
      if (entry.everyHours >= snapshot.checkIntervalHours)
        return `not more often than the schedule (every ${snapshot.checkIntervalHours} h)`
      message = {
        title: `Watch ${knife.knife} closely?`,
        detail: entry.question,
        payload: {
          type: 'question',
          knifeId: knife.knifeId,
          ask: 'watch_closely',
          hours: entry.hours,
          everyHours: entry.everyHours,
        },
      }
      break
    }
    case 'keep_listing': {
      const source =
        entry.sourceId === null ? undefined : byId.get(entry.sourceId)
      if (!source || source.knifeId !== knife.knifeId)
        return 'unknown source for this knife'
      if (!source.foundByAi) return 'only for listings Other stores found'
      if (!source.monitored) return 'not monitored'
      message = {
        title: `Is the ${source.store} listing the right ${knife.knife}?`,
        detail: entry.question,
        payload: {
          type: 'question',
          knifeId: knife.knifeId,
          ask: 'keep_listing',
          sourceId: source.id,
          store: source.store,
        },
      }
      break
    }
  }
  const invented = inventedAmount(entry.question, known)
  return invented ? `quotes a price not in the data (${invented})` : message
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
      `UPDATE price_sources SET last_ai_at = NULL
       WHERE id = ? AND removed_at IS NULL AND enabled = 1`,
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
    const remember = database.prepare(
      `INSERT INTO price_agent_notes (knife_id, note, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
    const forget = database.prepare(
      'DELETE FROM price_agent_notes WHERE id = ?',
    )
    // Questions nobody answered close after a week.
    const expireQuestions = database.prepare(
      `UPDATE system_messages SET resolved_at = ?, updated_at = ?
       WHERE kind = 'price-question' AND resolved_at IS NULL
         AND dismissed_at IS NULL AND answer IS NULL AND created_at < ?`,
    )
    const reports: SystemMessageReport[] = []
    return database.transaction(() => {
      expireQuestions.run(
        now,
        now,
        new Date(context.now - QUESTION_EXPIRY_DAYS * DAY_MS).toISOString(),
      )
      const result = actions.map((action): AgentAction => {
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
          case 'watchClosely':
            changes = startKnifeFocus(
              database,
              action.knifeId!,
              {
                hours: action.hours ?? 0,
                everyHours: action.everyHours ?? 0,
                reason: action.reason,
              },
              context.now,
            )
              ? 1
              : 0
            break
          case 'crossCheck':
            for (const id of action.sourceIds ?? [])
              changes += expedite.run(now, now, id).changes
            break
          case 'searchOtherStore':
            changes = search.run(now, action.knifeId).changes
            // A knife never searched yet is due anyway; a found one stays.
            return {
              ...action,
              status: 'applied',
              note: changes ? null : 'already due, or already found',
            }
          case 'forget':
            changes = forget.run(action.noteId).changes
            if (!changes)
              return { ...action, status: 'refused', note: 'already gone' }
            return { ...action, status: 'applied', note: null }
          case 'remember': {
            const noteId = Number(
              remember.run(
                action.knifeId ?? null,
                action.memory ?? '',
                now,
                new Date(
                  context.now + (action.days ?? NOTE_MAX_DAYS) * DAY_MS,
                ).toISOString(),
              ).lastInsertRowid,
            )
            return { ...action, status: 'applied', note: null, noteId }
          }
          case 'advise':
          case 'ask': {
            if (!action.message)
              return { ...action, status: 'refused', note: 'no message' }
            const key = `${action.kind}:${action.knifeId}:${now}`
            reports.push({
              kind:
                action.kind === 'advise' ? 'price-advice' : 'price-question',
              key,
              title: action.message.title,
              detail: action.message.detail,
              payload: action.message.payload,
            })
            return {
              ...action,
              status: 'applied',
              note: null,
              message: { ...action.message, key },
            }
          }
        }
        return changes
          ? { ...action, status: 'applied', note: null }
          : { ...action, status: 'refused', note: 'source changed meanwhile' }
      })
      if (reports.length)
        writeSystemMessageReports(database, reports, new Date(context.now))
      return result
    })()
  })
}

// ---------------------------------------------------------------- journal

export type AgentRun = {
  id: number
  startedAt: string
  trigger: AgentTrigger
  /** What changed since the run before (newest first, capped). */
  events: AgentEvent[]
  /** All events since the run before, shown or not. */
  eventTotal: number
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
  events: string | null
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
    ...readRunEvents(row.events),
  }))
}

function readRunEvents(value: string | null): {
  events: AgentEvent[]
  eventTotal: number
} {
  const stored = parseJson<{ list?: unknown; total?: unknown } | null>(
    value,
    null,
  )
  const events = Array.isArray(stored?.list)
    ? (stored.list as AgentEvent[])
    : []
  return {
    events,
    eventTotal:
      typeof stored?.total === 'number' ? stored.total : events.length,
  }
}

export function lastAgentRunAt(database: Database.Database): number | null {
  const row = database
    .prepare('SELECT MAX(started_at) AS at FROM price_agent_runs')
    .get() as { at: string | null }
  return row.at ? Date.parse(row.at) : null
}

/** Drops old runs, expired notes and notes about deleted knives. */
export function pruneAgentRuns(database: Database.Database, now = Date.now()) {
  database
    .prepare('DELETE FROM price_agent_runs WHERE started_at < ?')
    .run(new Date(now - AGENT_RETENTION_MS).toISOString())
  database
    .prepare(
      `DELETE FROM price_agent_notes
       WHERE expires_at <= ?
          OR (knife_id IS NOT NULL
              AND knife_id NOT IN (SELECT id FROM knives))`,
    )
    .run(new Date(now).toISOString())
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
             coverage, actions, error, events)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          JSON.stringify({ list: run.events, total: run.eventTotal }),
        ).lastInsertRowid,
    )
  })
}

// ----------------------------------------------------------------- runner

/** The heartbeat: how long the supervisor goes at most without a run. */
export function agentHeartbeatMs(settings: PriceMonitoringSettings): number {
  return settings.ai.usage.mode === 'unlimited'
    ? AGENT_HEARTBEAT_UNLIMITED_MS
    : AGENT_HEARTBEAT_LIMITED_MS
}

/** How soon after a run events may wake the supervisor again. */
export function agentEventGapMs(settings: PriceMonitoringSettings): number {
  return settings.ai.usage.mode === 'unlimited'
    ? AGENT_EVENT_GAP_UNLIMITED_MS
    : AGENT_EVENT_GAP_LIMITED_MS
}

export function agentActive(settings: PriceMonitoringSettings): boolean {
  return settings.ai.agentMode !== 'off' && aiConfigured(settings.ai)
}

/**
 * Whether a run is due, and why: the heartbeat, or events waiting since the
 * last run (once the first is AGENT_EVENT_BATCH_MS old and the event gap
 * has passed). Null when no run is due. Pure.
 */
export function agentDue(input: {
  settings: PriceMonitoringSettings
  lastRunAt: number | null
  now: number
  /** Events since the last run; omitted when not read. */
  events?: Pick<AgentEvents, 'total' | 'oldestAt'>
}): Exclude<AgentTrigger, 'manual'> | null {
  const { settings, lastRunAt, now, events } = input
  if (!agentActive(settings)) return null
  if (lastRunAt === null || now - lastRunAt >= agentHeartbeatMs(settings))
    return 'scheduled'
  if (
    events &&
    events.total > 0 &&
    events.oldestAt !== null &&
    now - events.oldestAt >= AGENT_EVENT_BATCH_MS &&
    now - lastRunAt >= agentEventGapMs(settings)
  )
    return 'event'
  return null
}

/** When the next run starts at the latest: the heartbeat, or sooner for events. */
export function agentNextRunAt(input: {
  settings: PriceMonitoringSettings
  lastRunAt: number | null
  now: number
  events: Pick<AgentEvents, 'total' | 'oldestAt'>
}): number {
  const { settings, lastRunAt, now, events } = input
  if (lastRunAt === null) return now
  const heartbeat = lastRunAt + agentHeartbeatMs(settings)
  if (!events.total || events.oldestAt === null) return heartbeat
  return Math.min(
    heartbeat,
    Math.max(
      lastRunAt + agentEventGapMs(settings),
      events.oldestAt + AGENT_EVENT_BATCH_MS,
    ),
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

/** A run is in progress in this process. */
export function agentRunning(): boolean {
  return runningFlag().value
}

export type AgentLabels = {
  sources: Record<string, { knifeId: string; knife: string; store: string }>
  knives: Record<string, string>
}

/** Knife and store names for the actions of these runs (for the UI). */
export function readAgentLabels(
  database: Database.Database,
  runs: readonly AgentRun[],
): AgentLabels {
  const sourceIds = new Set<number>()
  const knifeIds = new Set<string>()
  for (const run of runs)
    for (const action of run.actions) {
      if (action.sourceId !== undefined) sourceIds.add(action.sourceId)
      if (action.knifeId !== undefined) knifeIds.add(action.knifeId)
    }
  const labels: AgentLabels = { sources: {}, knives: {} }
  const source = database.prepare(
    `SELECT s.knife_id AS knifeId, k.brand, k.name, s.store_name AS store
     FROM price_sources s JOIN knives k ON k.id = s.knife_id WHERE s.id = ?`,
  )
  for (const id of sourceIds) {
    const row = source.get(id) as
      | { knifeId: string; brand: string; name: string; store: string }
      | undefined
    if (row)
      labels.sources[id] = {
        knifeId: row.knifeId,
        knife: [row.brand, row.name].filter(Boolean).join(' '),
        store: row.store,
      }
  }
  const knife = database.prepare('SELECT brand, name FROM knives WHERE id = ?')
  for (const id of knifeIds) {
    const row = knife.get(id) as { brand: string; name: string } | undefined
    if (row) labels.knives[id] = [row.brand, row.name].filter(Boolean).join(' ')
  }
  return labels
}

/** Stores whose checks hit a bot check: only the user can pass it. */
export function readBlockedStores(database: Database.Database): string[] {
  return (
    database
      .prepare(
        `SELECT DISTINCT store_name AS store FROM price_sources
         WHERE status = 'blocked' AND enabled = 1 AND removed_at IS NULL
         ORDER BY store_name`,
      )
      .all() as Array<{ store: string }>
  ).map((row) => row.store)
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
      trigger: options.trigger,
    })
    const base = {
      startedAt: new Date(started).toISOString(),
      trigger: options.trigger,
      events: snapshot.events.map(
        ({ minutesAgo: _minutes, ...event }) => event,
      ),
      eventTotal: snapshot.events.length + snapshot.eventsOmitted,
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
            user: agentModelInput(snapshot),
            schemaName: 'monitoring_plan',
            purpose: 'agent',
            schema: AGENT_SCHEMA,
            maxTokens: 2000,
          },
          {
            timeoutMs: PLANNING_TIMEOUT_MS,
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
