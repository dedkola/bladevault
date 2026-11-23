import type Database from 'better-sqlite3'
import { getLocalDb } from '@/lib/local-db'
import { aiConfigured, appearsLiterally } from '@/lib/price-monitor/ai'
import {
  PLANNING_TIMEOUT_MS,
  requestJsonCompletion,
  type AiEndpoint,
  type FetchLike,
} from '@/lib/price-monitor/ai-client'
import {
  readAiCallSummary,
  startOfLocalDay,
} from '@/lib/price-monitor/ai-journal'
import {
  formatMoney,
  normalizeCurrencyCode,
  parseStoredPrice,
  toMinorUnits,
} from '@/lib/price-monitor/money'
import type { EligibilitySettings } from '@/lib/price-monitor/eligibility'
import { readPriceAiKey } from '@/lib/price-monitor/secrets'
import { readQueueCandidates } from '@/lib/price-monitor/store'
import { reportServerError } from '@/lib/sentry/server'
import { getSettings } from '@/lib/settings'
import type { PriceMonitoringSettings } from '@/lib/settings-shared'
import {
  reportSystemMessage,
  resolveSystemMessages,
} from '@/lib/system-message-store'
import {
  assertVaultGeneration,
  getVaultAccessState,
  withVaultWrite,
} from '@/lib/vault-access'

/**
 * The daily Inbox digest: once a day AI writes a short summary of price
 * monitoring from aggregated vault data (best deals against the regular
 * price, the last 24 hours' drops and restocks, store pages that broke and
 * what AI fixed). Only knife names, store names and prices are sent: no
 * notes, photos, links or keys. Each day's digest replaces the previous one
 * in the Inbox, which then moves to Done.
 */
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/** No digest before this local hour, so it sums up the previous day. */
export const DIGEST_EARLIEST_HOUR = 6
/** A planning task: the model may reason (REASONING_PURPOSES). */
export const DIGEST_TIMEOUT_MS = PLANNING_TIMEOUT_MS
/** After a failed attempt, wait this long before trying again. */
export const DIGEST_RETRY_MS = HOUR_MS
const CHECK_EVERY_MS = 10 * MINUTE_MS
const LISTED = 5
/**
 * A price this far below the stored regular price is more likely a bad
 * stored price (a typo, another currency) than a deal: left out of the
 * digest's deals and drops.
 */
export const SUSPECT_BELOW_REGULAR_PCT = 90
export const DIGEST_TITLE_MAX = 80
export const DIGEST_SUMMARY_MAX = 800

export type DigestDeal = {
  knife: string
  store: string
  price: string
  regularPrice: string
  /** How far below the regular price, percent. */
  belowRegularPct: number
}

export type DigestData = {
  monitoredSources: number
  checks: { total: number; failed: number; blocked: number; noPrice: number }
  deals: DigestDeal[]
  drops: Array<{
    knife: string
    store: string
    from: string
    to: string
    pct: number
  }>
  increases: number
  restocks: Array<{ knife: string; store: string; price: string | null }>
  wentOutOfStock: number
  needAttention: Array<{ knife: string; store: string; problem: string }>
  needAttentionCount: number
  ai: {
    pricesRead: number
    storesHelped: string[]
    errorsWorked: number
    readingsUnconfirmed: number
    readingsDoubted: number
    requests: number
    failedRequests: number
  }
}

const PROBLEM: Record<string, string> = {
  failed: 'check failed',
  blocked: 'bot check',
  price_unavailable: 'no price found',
  needs_review: 'AI doubts the price',
}

const knifeLabel = (brand: string, name: string) =>
  [brand, name].filter((part) => part && part.trim()).join(' ')

const money = (minor: number, currency: string) =>
  formatMoney(minor, currency, 'en-US')

function storedPrice(specs: string): string | undefined {
  try {
    return (JSON.parse(specs) as { price?: string }).price
  } catch {
    return undefined
  }
}

/** More than SUSPECT_BELOW_REGULAR_PCT below the regular price. */
export function suspectBelowRegular(
  priceMinor: number,
  regularMinor: number,
): boolean {
  return (
    regularMinor > 0 &&
    priceMinor < regularMinor * (1 - SUSPECT_BELOW_REGULAR_PCT / 100)
  )
}

/** The knife's stored regular price makes this price suspect. */
function suspectAgainstStored(
  priceMinor: number,
  currency: string,
  specs: string,
): boolean {
  const paid = parseStoredPrice(storedPrice(specs))
  const code = normalizeCurrencyCode(currency)
  if (!paid || !code || (paid.currency && paid.currency !== code)) return false
  return suspectBelowRegular(priceMinor, toMinorUnits(paid.amount, code))
}

/**
 * Aggregated monitoring data for the digest. Reads only. Only sources that
 * scheduled monitoring covers count: knives outside What to monitor keep
 * their last readings, which are not news.
 */
export function readDigestData(
  database: Database.Database,
  now = Date.now(),
  settings: EligibilitySettings = getSettings().priceMonitoring,
): DigestData {
  const since = new Date(now - DAY_MS).toISOString()
  const active = `s.removed_at IS NULL AND s.enabled = 1`
  const covered = new Set(
    readQueueCandidates(database, settings, now)
      .filter((candidate) => candidate.covered)
      .map((candidate) => candidate.sourceId),
  )
  const isCovered = (row: { source_id: number }) => covered.has(row.source_id)

  const monitoredSources = covered.size

  const checks = database
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(outcome = 'failed'), 0) AS failed,
              COALESCE(SUM(outcome = 'blocked'), 0) AS blocked,
              COALESCE(SUM(outcome = 'no_price'), 0) AS noPrice
       FROM price_check_log WHERE started_at >= ?`,
    )
    .get(since) as DigestData['checks']

  const priced = database
    .prepare(
      `SELECT s.id AS source_id, k.brand, k.name, k.specs, s.store_name,
              s.last_price_minor, s.last_currency
       FROM price_sources s JOIN knives k ON k.id = s.knife_id
       WHERE ${active} AND s.status = 'ok' AND k.sold = 0
         AND s.last_price_minor IS NOT NULL AND s.last_currency IS NOT NULL`,
    )
    .all() as Array<{
    source_id: number
    brand: string
    name: string
    specs: string
    store_name: string
    last_price_minor: number
    last_currency: string
  }>
  const deals: DigestDeal[] = []
  for (const row of priced.filter(isCovered)) {
    const paid = parseStoredPrice(storedPrice(row.specs))
    const currency = normalizeCurrencyCode(row.last_currency)
    if (!paid || !currency || (paid.currency && paid.currency !== currency))
      continue
    const paidMinor = toMinorUnits(paid.amount, currency)
    if (paidMinor <= 0 || row.last_price_minor >= paidMinor) continue
    if (suspectBelowRegular(row.last_price_minor, paidMinor)) continue
    deals.push({
      knife: knifeLabel(row.brand, row.name),
      store: row.store_name,
      price: money(row.last_price_minor, currency),
      regularPrice: money(paidMinor, currency),
      belowRegularPct:
        Math.round(((paidMinor - row.last_price_minor) / paidMinor) * 1000) /
        10,
    })
  }
  deals.sort((a, b) => b.belowRegularPct - a.belowRegularPct)

  const changes = (
    database
      .prepare(
        `SELECT e.source_id, e.direction, e.previous_price_minor, e.price_minor,
              e.currency, e.delta_pct, e.store_name, k.brand, k.name, k.specs
       FROM price_change_events e JOIN knives k ON k.id = e.knife_id
       WHERE e.occurred_at >= ?
       ORDER BY e.delta_pct ASC`,
      )
      .all(since) as Array<{
      source_id: number
      direction: 'drop' | 'increase'
      previous_price_minor: number
      price_minor: number
      currency: string
      delta_pct: number
      store_name: string
      brand: string
      name: string
      specs: string
    }>
  ).filter(isCovered)
  const drops = changes
    .filter(
      (row) =>
        row.direction === 'drop' &&
        !suspectAgainstStored(row.price_minor, row.currency, row.specs),
    )
    .slice(0, LISTED)
    .map((row) => ({
      knife: knifeLabel(row.brand, row.name),
      store: row.store_name,
      from: money(row.previous_price_minor, row.currency),
      to: money(row.price_minor, row.currency),
      pct: row.delta_pct,
    }))

  const stock = (
    database
      .prepare(
        `SELECT e.source_id, e.kind, e.price_minor, e.currency, e.store_name,
              k.brand, k.name
       FROM stock_events e JOIN knives k ON k.id = e.knife_id
       WHERE e.occurred_at >= ? ORDER BY e.occurred_at DESC`,
      )
      .all(since) as Array<{
      source_id: number
      kind: 'out_of_stock' | 'back_in_stock'
      price_minor: number | null
      currency: string | null
      store_name: string
      brand: string
      name: string
    }>
  ).filter(isCovered)
  const restocks = stock
    .filter((row) => row.kind === 'back_in_stock')
    .slice(0, LISTED)
    .map((row) => ({
      knife: knifeLabel(row.brand, row.name),
      store: row.store_name,
      price:
        row.price_minor !== null && row.currency
          ? money(row.price_minor, row.currency)
          : null,
    }))

  const attention = (
    database
      .prepare(
        `SELECT s.id AS source_id, k.brand, k.name, s.store_name, s.status
       FROM price_sources s JOIN knives k ON k.id = s.knife_id
       WHERE ${active}
         AND s.status IN ('failed', 'blocked', 'price_unavailable',
                          'needs_review')
       ORDER BY s.last_checked_at DESC, s.id DESC`,
      )
      .all() as Array<{
      source_id: number
      brand: string
      name: string
      store_name: string
      status: string
    }>
  ).filter(isCovered)

  const log = database
    .prepare(
      `SELECT l.outcome, l.method, l.error_code, l.solver_steps,
              s.store_name
       FROM price_check_log l LEFT JOIN price_sources s ON s.id = l.source_id
       WHERE l.started_at >= ?`,
    )
    .all(since) as Array<{
    outcome: string
    method: string | null
    error_code: string | null
    solver_steps: string | null
    store_name: string | null
  }>
  const readByAi = log.filter(
    (row) =>
      row.outcome === 'ok' && (row.method === 'ai' || row.method === 'solver'),
  )
  const calls = readAiCallSummary(database, now)

  return {
    monitoredSources,
    checks,
    deals: deals.slice(0, LISTED),
    drops,
    increases: changes.filter((row) => row.direction === 'increase').length,
    restocks,
    wentOutOfStock: stock.filter((row) => row.kind === 'out_of_stock').length,
    needAttention: attention.slice(0, LISTED).map((row) => ({
      knife: knifeLabel(row.brand, row.name),
      store: row.store_name,
      problem: PROBLEM[row.status] ?? row.status,
    })),
    needAttentionCount: attention.length,
    ai: {
      pricesRead: readByAi.length,
      storesHelped: [
        ...new Set(
          readByAi.flatMap((row) => (row.store_name ? [row.store_name] : [])),
        ),
      ].slice(0, LISTED),
      errorsWorked: log.filter((row) => row.solver_steps).length,
      readingsUnconfirmed: log.filter(
        (row) => row.error_code === 'ai_unconfirmed',
      ).length,
      readingsDoubted: log.filter((row) => row.error_code === 'ai_review')
        .length,
      requests: calls.calls,
      failedRequests: calls.failed,
    },
  }
}

export const DIGEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary'],
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
  },
} as const

const SYSTEM_PROMPT = [
  "You write a short daily summary for the Inbox of a knife collector's price tracker.",
  'The data covers the last 24 hours: current prices below the stored regular price (deals), price drops, restocks, store pages that need attention, and what AI did (prices it read when the page parsers could not, checks it worked through, readings it doubted).',
  'Answer with JSON only: {"title", "summary"}.',
  `title: at most 60 characters, naming the most useful news. summary: plain text, no markdown, at most 5 short sentences and ${DIGEST_SUMMARY_MAX - 200} characters.`,
  'Lead with what is worth acting on: a good deal or a notable drop, then restocks, then problems and what AI fixed. Skip empty topics.',
  'Use only knives, stores, prices and numbers from the data, written exactly as given. Never invent or compute prices.',
].join('\n')

const clean = (text: string) =>
  text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[*_#`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const MONEY_PATTERN =
  /(?:[$€£¥]\s?\d[\d,]*(?:\.\d+)?)|(?:\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|CAD|AUD|JPY))/g

/**
 * The model's digest, or null when it is unusable: empty, or quoting a
 * price that is not in the data it was given.
 */
export function parseDigestAnswer(
  answer: unknown,
  dataText: string,
): { title: string; summary: string } | null {
  const record =
    answer && typeof answer === 'object' && !Array.isArray(answer)
      ? (answer as Record<string, unknown>)
      : {}
  const title =
    typeof record.title === 'string'
      ? clean(record.title).slice(0, DIGEST_TITLE_MAX)
      : ''
  let summary = typeof record.summary === 'string' ? clean(record.summary) : ''
  if (!title || !summary) return null
  if (summary.length > DIGEST_SUMMARY_MAX)
    summary = `${summary.slice(0, DIGEST_SUMMARY_MAX - 1).trimEnd()}…`
  for (const match of `${title} ${summary}`.matchAll(MONEY_PATTERN)) {
    const quoted = match[0]
    // "$129" stands for "$129.00" in the data.
    const candidates = /\.\d/.test(quoted)
      ? [quoted]
      : [quoted, quoted.replace(/(\d)(?=\s?[A-Z]{3}$|$)/, '$1.00')]
    if (!candidates.some((text) => appearsLiterally(text, dataText)))
      return null
  }
  return { title, summary }
}

/** Whether there is anything to tell. */
export function digestHasNews(data: DigestData): boolean {
  return (
    data.deals.length > 0 ||
    data.drops.length > 0 ||
    data.increases > 0 ||
    data.restocks.length > 0 ||
    data.wentOutOfStock > 0 ||
    data.needAttentionCount > 0 ||
    data.ai.pricesRead > 0 ||
    data.ai.errorsWorked > 0 ||
    data.ai.readingsUnconfirmed > 0 ||
    data.ai.readingsDoubted > 0
  )
}

/**
 * Asks the model for the digest. Throws AiClientError for configuration,
 * network and endpoint problems, and with code 'budget' when the daily AI
 * budget refuses it. Null when the answer was unusable.
 */
export async function writeDigestWithAi(input: {
  data: DigestData
  endpoint: AiEndpoint
  model: string
  signal?: AbortSignal
  fetchImpl?: FetchLike
  timeoutMs?: number
}): Promise<{ title: string; summary: string } | null> {
  const dataText = JSON.stringify(input.data)
  const answer = await requestJsonCompletion(
    input.endpoint,
    {
      model: input.model,
      system: SYSTEM_PROMPT,
      user: dataText,
      schemaName: 'price_digest',
      purpose: 'digest',
      schema: DIGEST_SCHEMA,
      maxTokens: 500,
    },
    {
      timeoutMs: input.timeoutMs ?? DIGEST_TIMEOUT_MS,
      signal: input.signal,
      fetchImpl: input.fetchImpl,
    },
  )
  return parseDigestAnswer(answer, dataText)
}

/** When the last digest was written, from the Inbox. */
export function readLastDigestAt(database: Database.Database): string | null {
  const row = database
    .prepare(
      `SELECT MAX(occurred_at) AS at FROM system_messages
       WHERE kind = 'price-digest'`,
    )
    .get() as { at: string | null } | undefined
  return row?.at ?? null
}

/** Due once per local day, from DIGEST_EARLIEST_HOUR on. Pure. */
export function digestDue(lastAt: string | null, now: number): boolean {
  if (new Date(now).getHours() < DIGEST_EARLIEST_HOUR) return false
  if (!lastAt) return true
  const last = Date.parse(lastAt)
  return !Number.isFinite(last) || last < startOfLocalDay(now)
}

export function digestActive(settings: PriceMonitoringSettings): boolean {
  return aiConfigured(settings.ai) && settings.ai.dailyDigest
}

export type DigestRunResult =
  | { status: 'written'; title: string }
  | {
      status: 'skipped'
      reason:
        'disabled' | 'read_only' | 'not_due' | 'no_sources' | 'no_news' | 'busy'
    }
  | { status: 'failed'; reason: 'ai' | 'budget' | 'unusable'; message: string }

const RUNNING = Symbol.for('bladevault.price-monitor.digest')

type DigestState = {
  running: Promise<DigestRunResult> | null
  notBefore: number
  lastCheck: number
}

function state(): DigestState {
  const scope = globalThis as typeof globalThis & { [RUNNING]?: DigestState }
  return (scope[RUNNING] ??= { running: null, notBefore: 0, lastCheck: 0 })
}

/**
 * Writes today's digest when it is due: reads the data, asks the model and
 * replaces the previous digest in the Inbox. Nothing is written into a vault
 * restored or switched meanwhile.
 */
export async function runPriceDigest(
  options: {
    now?: number
    force?: boolean
    signal?: AbortSignal
    fetchImpl?: FetchLike
  } = {},
): Promise<DigestRunResult> {
  const settings = getSettings().priceMonitoring
  if (!digestActive(settings)) return { status: 'skipped', reason: 'disabled' }
  const access = getVaultAccessState()
  if (access.readOnly) return { status: 'skipped', reason: 'read_only' }
  const now = options.now ?? Date.now()
  const database = getLocalDb()
  if (!options.force && !digestDue(readLastDigestAt(database), now))
    return { status: 'skipped', reason: 'not_due' }
  const data = readDigestData(database, now, settings)
  if (!data.monitoredSources) return { status: 'skipped', reason: 'no_sources' }
  if (!digestHasNews(data)) return { status: 'skipped', reason: 'no_news' }

  let digest
  try {
    const apiKey = await readPriceAiKey()
    digest = await writeDigestWithAi({
      data,
      endpoint: {
        baseUrl: settings.ai.baseUrl,
        apiKey,
        headers: settings.ai.headers,
        maxAnswerTokens: settings.ai.maxAnswerTokens,
      },
      model: settings.ai.model,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'VaultAccessError') throw error
    const budget =
      error instanceof Error &&
      error.name === 'AiClientError' &&
      (error as { code?: unknown }).code === 'budget'
    return {
      status: 'failed',
      reason: budget ? 'budget' : 'ai',
      message:
        error instanceof Error ? error.message : 'The AI request failed.',
    }
  }
  if (!digest)
    return {
      status: 'failed',
      reason: 'unusable',
      message: 'The AI summary quoted prices that are not in the data.',
    }

  const at = new Date(now)
  await withVaultWrite(async () => {
    assertVaultGeneration(access.generation)
    await resolveSystemMessages('price-digest', at)
    await reportSystemMessage(
      { kind: 'price-digest', title: digest.title, detail: digest.summary },
      at,
    )
  })
  return { status: 'written', title: digest.title }
}

/**
 * The worker's hook: starts the digest in the background when it may be
 * due, at most every 10 minutes, and waits after a failure (until midnight
 * when the daily AI budget is used up). Never blocks the caller.
 */
export function startPriceDigestIfDue(
  settings: PriceMonitoringSettings,
  now = Date.now(),
): Promise<DigestRunResult> | null {
  const current = state()
  if (!digestActive(settings) || current.running) return null
  if (now < current.notBefore || now - current.lastCheck < CHECK_EVERY_MS)
    return null
  current.lastCheck = now
  current.running = runPriceDigest({ now })
    .then((result) => {
      if (result.status === 'failed')
        current.notBefore =
          result.reason === 'budget'
            ? startOfLocalDay(now) + DAY_MS
            : now + DIGEST_RETRY_MS
      return result
    })
    .catch((error: unknown) => {
      if (!(error instanceof Error && error.name === 'VaultAccessError'))
        reportServerError(error, 'price-monitor/digest')
      current.notBefore = now + DIGEST_RETRY_MS
      return {
        status: 'failed',
        reason: 'ai',
        message: 'The digest failed.',
      } as const
    })
    .finally(() => {
      current.running = null
    })
  return current.running
}

/** Forgets the worker hook's pacing; for tests. */
export function resetPriceDigestState() {
  const current = state()
  current.running = null
  current.notBefore = 0
  current.lastCheck = 0
}
