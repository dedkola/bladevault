import {
  requestJsonCompletion,
  type AiEndpoint,
  type FetchLike,
} from '@/lib/price-monitor/ai-client'
import { aiConfigured, AI_SOURCE_COOLDOWN_MS } from '@/lib/price-monitor/ai'
import type { PriceAiSettings } from '@/lib/settings-shared'

/**
 * The optional AI troubleshooter for checks that failed before a price could
 * be read (bot checks, HTTP errors, timeouts, redirects). It sends what went
 * wrong (store host name, error code, HTTP status and the source's recent
 * outcomes; no product URLs, knife names, page content or keys) and applies
 * the answer within hard bounds:
 *
 * - it may reset the store's saved browser cookies after a block,
 * - pin the store to the browser for 7 days instead of plain HTTP,
 * - move this source's next check (never earlier than the normal backoff
 *   after a block, at least 10 minutes otherwise, at most 7 days),
 * - pause the source when its page is gone (404/410 or a redirect) after
 *   repeated failures,
 * - and add one sentence for the check log.
 *
 * It never solves or bypasses a bot check, never speeds a store up and never
 * shortens a circuit-breaker pause. Pages the parsers could read but found no
 * usable price in go to the extraction fallback in ai.ts instead.
 */
export const TROUBLESHOOT_TIMEOUT_MS = 20_000
export const MIN_RETRY_MINUTES = 10
export const MAX_RETRY_MINUTES = 7 * 24 * 60
const MAX_EXPLANATION_LENGTH = 200
const MINUTE_MS = 60 * 1000

/** Failure codes the troubleshooter can help with. */
export const TROUBLESHOOT_CODES: ReadonlySet<string> = new Set([
  'challenge',
  'http',
  'timeout',
  'network',
  'redirect',
  'invalid_response',
])

export type TroubleshootInput = {
  /** Store host name such as "vosteed.com", or "amazon". */
  store: string
  errorCode: string
  httpStatus: number | null
  /** Our own error text for the code (never the page). */
  errorMessage: string
  /** Bot check, 403 or 429. */
  blocked: boolean
  consecutiveFailures: number
  trigger: string
  /** How BladeVault fetched the store: learned or user-chosen. */
  fetchMode: 'http' | 'browser' | 'auto'
  /** Minutes until the next check without AI. */
  defaultRetryMinutes: number
  /** Newest first: outcome and error code of the source's last checks. */
  recent: Array<{ outcome: string; errorCode: string | null; at: string }>
}

export type TroubleshootPlan = {
  resetCookies: boolean
  useBrowser: boolean
  /** The next check for this source, or null to keep the default. */
  nextCheckAt: string | null
  pauseSource: boolean
  explanation: string
  /** What the safety bounds changed or dropped. */
  adjustments: string[]
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** A page that is gone: the only failures AI may pause a source for. */
function pageMissing(input: TroubleshootInput): boolean {
  return (
    input.httpStatus === 404 ||
    input.httpStatus === 410 ||
    input.errorCode === 'redirect'
  )
}

/**
 * The model's answer clamped to the safety bounds. Pure.
 */
export function clampTroubleshootPlan(
  output: unknown,
  input: TroubleshootInput,
  now: number,
): TroubleshootPlan {
  const record =
    output && typeof output === 'object' && !Array.isArray(output)
      ? (output as Record<string, unknown>)
      : {}
  const adjustments: string[] = []

  let resetCookies = record.resetCookies === true
  if (resetCookies && !input.blocked) {
    resetCookies = false
    adjustments.push('cookies are reset only after a block')
  }

  let useBrowser = record.useBrowser === true
  if (useBrowser && input.fetchMode !== 'auto') {
    useBrowser = false
    adjustments.push('the fetch method was chosen by the user')
  }

  let pauseSource = record.pauseSource === true
  if (pauseSource && !(pageMissing(input) && input.consecutiveFailures >= 2)) {
    pauseSource = false
    adjustments.push('sources are paused only when the page is gone')
  }

  let nextCheckAt: string | null = null
  const minutes = finiteNumber(record.retryInMinutes)
  if (minutes !== null && minutes > 0 && !pauseSource) {
    // After a block, never sooner than the backoff; otherwise ≥ 10 minutes.
    const floor = input.blocked
      ? Math.max(MIN_RETRY_MINUTES, input.defaultRetryMinutes)
      : MIN_RETRY_MINUTES
    const clamped = Math.round(
      Math.min(MAX_RETRY_MINUTES, Math.max(floor, minutes)),
    )
    if (minutes < floor)
      adjustments.push(
        input.blocked
          ? 'a blocked store is never retried sooner than the backoff'
          : 'retries wait at least 10 minutes',
      )
    if (minutes > MAX_RETRY_MINUTES) adjustments.push('retry capped at 7 days')
    nextCheckAt = new Date(now + clamped * MINUTE_MS).toISOString()
  }

  const explanation =
    typeof record.explanation === 'string'
      ? record.explanation
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, MAX_EXPLANATION_LENGTH)
      : ''

  return {
    resetCookies,
    useBrowser,
    nextCheckAt,
    pauseSource,
    explanation,
    adjustments,
  }
}

/** Whether a failed check may ask AI now (shares the 24 h AI pause). */
export function troubleshootAllowed(input: {
  settings: PriceAiSettings
  errorCode: string
  lastAiAt: string | null
  now: number
}): boolean {
  if (!aiConfigured(input.settings) || !input.settings.resolveErrors)
    return false
  if (!TROUBLESHOOT_CODES.has(input.errorCode)) return false
  if (!input.lastAiAt) return true
  const last = Date.parse(input.lastAiAt)
  return !Number.isFinite(last) || input.now - last >= AI_SOURCE_COOLDOWN_MS
}

export const TROUBLESHOOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'resetCookies',
    'useBrowser',
    'retryInMinutes',
    'pauseSource',
    'explanation',
  ],
  properties: {
    resetCookies: { type: 'boolean' },
    useBrowser: { type: 'boolean' },
    retryInMinutes: { type: ['number', 'null'] },
    pauseSource: { type: 'boolean' },
    explanation: { type: 'string' },
  },
} as const

const TROUBLESHOOT_PROMPT = [
  'You help a personal app that checks the price of one product in an online store. A check just failed.',
  'You get the store host name, the error code (challenge = the store showed a bot check or CAPTCHA, http = error status, timeout, network, redirect = the page moved somewhere the app cannot follow, invalid_response), the HTTP status, how the app fetched the store, how many checks failed in a row, the outcomes of the last checks, and the minutes until the next check without your help.',
  'Choose how to recover, as JSON: {"resetCookies", "useBrowser", "retryInMinutes", "pauseSource", "explanation"}.',
  'resetCookies: true to forget the saved browser cookies for the store, for example when a bot check keeps coming back. useBrowser: true to stop plain HTTP requests and load the store in a browser.',
  'retryInMinutes: when to check this product again, or null to keep the default. Back off after a bot check or 403/429; retry sooner only for passing trouble such as timeouts, network errors or 5xx.',
  'pauseSource: true only when the product page is gone (404, 410 or a redirect away from the product) and keeps failing; the user then checks the link.',
  'explanation: one short sentence for the user about what went wrong and what happens next. Never suggest solving or bypassing a CAPTCHA.',
].join('\n')

/**
 * Asks the model how to recover from one failed check. Throws
 * AiClientError for configuration, network and endpoint problems.
 */
export async function troubleshootCheck(input: {
  failure: TroubleshootInput
  endpoint: AiEndpoint
  model: string
  now?: number
  signal?: AbortSignal
  fetchImpl?: FetchLike
  timeoutMs?: number
}): Promise<TroubleshootPlan> {
  const answer = await requestJsonCompletion(
    input.endpoint,
    {
      model: input.model,
      system: TROUBLESHOOT_PROMPT,
      user: JSON.stringify(input.failure),
      schemaName: 'check_recovery',
      purpose: 'troubleshoot',
      schema: TROUBLESHOOT_SCHEMA,
      maxTokens: 300,
    },
    {
      timeoutMs: input.timeoutMs ?? TROUBLESHOOT_TIMEOUT_MS,
      signal: input.signal,
      fetchImpl: input.fetchImpl,
    },
  )
  return clampTroubleshootPlan(answer, input.failure, input.now ?? Date.now())
}
