import type Database from 'better-sqlite3'
import { getLocalDb } from '@/lib/local-db'
import {
  setAiBudgetGate,
  setAiCallObserver,
  type AiCallEvent,
  type AiPurpose,
} from '@/lib/price-monitor/ai-client'
import { getSettings } from '@/lib/settings'
import type { PriceAiChatSettings, PriceAiUsage } from '@/lib/settings-shared'
import { withVaultWriteSync } from '@/lib/vault-access'

/**
 * The AI call journal: one row per AI request price monitoring makes (what
 * for, how long, tokens, outcome), without prompts, answers or keys. It
 * shows whether AI actually works, which a disabled or failing endpoint
 * otherwise hides behind ordinary check results.
 */
export const AI_JOURNAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
/** A call the computer's sleep cut short is neutral, not a failure. */
const FAILED = `ok = 0 AND COALESCE(error_code, '') <> 'suspended'`

export function insertAiCall(
  database: Database.Database,
  event: AiCallEvent,
): void {
  database
    .prepare(
      `INSERT INTO price_ai_calls
        (started_at, purpose, model, duration_ms, attempts, ok, error_code,
         error, prompt_tokens, completion_tokens, reasoning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date(event.startedAt).toISOString(),
      event.purpose,
      event.model.slice(0, 200),
      Math.max(0, Math.round(event.durationMs)),
      event.attempts,
      event.ok ? 1 : 0,
      event.errorCode,
      event.error,
      event.promptTokens,
      event.completionTokens,
      event.reasoning ? 1 : 0,
    )
}

/** Records a call in the open vault; never throws (restore, lock, …). */
export function recordAiCall(event: AiCallEvent): void {
  try {
    withVaultWriteSync(() => insertAiCall(getLocalDb(), event))
  } catch {
    // A journal row is not worth failing or delaying a check for.
  }
}

/** Sends every AI call of this process to the journal. */
export function installAiCallJournal(): void {
  setAiCallObserver(recordAiCall)
  setAiBudgetGate((purpose) => checkAiBudget(purpose))
}

/** Midnight of the server's local day, epoch ms. */
export function startOfLocalDay(now = Date.now()): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export type AiUsageToday = { calls: number; tokens: number }

/**
 * Whose budget: price monitoring (every purpose but connection tests and
 * chat) or the Chat page (chat only). Each has its own daily caps, so a long
 * chat can never use up monitoring's budget.
 */
export type AiUsageScope = 'monitoring' | 'chat'

const SCOPE_FILTER: Record<AiUsageScope, string> = {
  monitoring: `purpose NOT IN ('test', 'chat')`,
  chat: `purpose = 'chat'`,
}

/** Requests and tokens since local midnight for one budget. */
export function readAiUsageToday(
  database: Database.Database,
  now = Date.now(),
  scope: AiUsageScope = 'monitoring',
): AiUsageToday {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(COALESCE(prompt_tokens, 0)
                + COALESCE(completion_tokens, 0)), 0) AS tokens
       FROM price_ai_calls WHERE started_at >= ? AND ${SCOPE_FILTER[scope]}`,
    )
    .get(new Date(startOfLocalDay(now)).toISOString()) as AiUsageToday
  return { calls: row.calls, tokens: row.tokens }
}

/** Why no more AI may run today, or null. Pure; 0 means no cap. */
export function aiBudgetRefusal(
  usage: PriceAiUsage,
  today: AiUsageToday,
): string | null {
  if (usage.mode === 'unlimited') return null
  if (usage.dailyCalls > 0 && today.calls >= usage.dailyCalls)
    return `The daily AI budget is used up (${usage.dailyCalls} requests). AI continues tomorrow, or choose Unlimited in Settings → Price monitoring → AI assistance.`
  if (usage.dailyTokens > 0 && today.tokens >= usage.dailyTokens)
    return `The daily AI budget is used up (${usage.dailyTokens.toLocaleString('en-US')} tokens). AI continues tomorrow, or choose Unlimited in Settings → Price monitoring → AI assistance.`
  return null
}

/** Why chat may not send more today (its own caps), or null. Pure. */
export function chatBudgetRefusal(
  usage: PriceAiUsage,
  chat: PriceAiChatSettings,
  today: AiUsageToday,
): string | null {
  if (usage.mode === 'unlimited') return null
  if (chat.dailyCalls > 0 && today.calls >= chat.dailyCalls)
    return `The daily chat limit is used up (${chat.dailyCalls} AI requests). Chat continues tomorrow, or raise the limit in Settings → AI connection → Chat.`
  if (chat.dailyTokens > 0 && today.tokens >= chat.dailyTokens)
    return `The daily chat limit is used up (${chat.dailyTokens.toLocaleString('en-US')} tokens). Chat continues tomorrow, or raise the limit in Settings → AI connection → Chat.`
  return null
}

/** The budget gate for the AI client, from the saved settings. */
export function checkAiBudget(
  purpose: AiPurpose = 'agent',
  now = Date.now(),
): string | null {
  const ai = getSettings().priceMonitoring.ai
  if (ai.usage.mode === 'unlimited') return null
  if (purpose === 'chat')
    return chatBudgetRefusal(
      ai.usage,
      ai.chat,
      readAiUsageToday(getLocalDb(), now, 'chat'),
    )
  return aiBudgetRefusal(ai.usage, readAiUsageToday(getLocalDb(), now))
}

export function pruneAiCalls(database: Database.Database, now = Date.now()) {
  database
    .prepare('DELETE FROM price_ai_calls WHERE started_at < ?')
    .run(new Date(now - AI_JOURNAL_RETENTION_MS).toISOString())
}

export type AiPurposeStats = {
  purpose: AiPurpose
  calls: number
  failed: number
}

export type AiCallSummary = {
  /** The last 24 hours. */
  calls: number
  failed: number
  /** Median duration of successful calls, ms. */
  medianMs: number | null
  promptTokens: number
  completionTokens: number
  byPurpose: AiPurposeStats[]
  lastCallAt: string | null
  lastError: { at: string; purpose: AiPurpose; message: string } | null
  /** The latest call's model was known to reason before answering. */
  reasoning: boolean
  /** Since local midnight, connection tests and chat excluded (the daily budget). */
  today: AiUsageToday
  /** Chat's own usage since local midnight (its separate limit). */
  chatToday: AiUsageToday
}

/** What AI did in the last 24 hours. */
export function readAiCallSummary(
  database: Database.Database,
  now = Date.now(),
): AiCallSummary {
  const since = new Date(now - DAY_MS).toISOString()
  const totals = database
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(${FAILED}), 0) AS failed,
              COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
              COALESCE(SUM(completion_tokens), 0) AS completionTokens
       FROM price_ai_calls WHERE started_at >= ?`,
    )
    .get(since) as {
    calls: number
    failed: number
    promptTokens: number
    completionTokens: number
  }
  const durations = (
    database
      .prepare(
        `SELECT duration_ms AS ms FROM price_ai_calls
         WHERE started_at >= ? AND ok = 1 ORDER BY duration_ms`,
      )
      .all(since) as Array<{ ms: number }>
  ).map((row) => row.ms)
  const byPurpose = database
    .prepare(
      `SELECT purpose, COUNT(*) AS calls, COALESCE(SUM(${FAILED}), 0) AS failed
       FROM price_ai_calls WHERE started_at >= ?
       GROUP BY purpose ORDER BY calls DESC, purpose`,
    )
    .all(since) as AiPurposeStats[]
  const last = database
    .prepare(
      `SELECT started_at AS at, reasoning FROM price_ai_calls
       ORDER BY started_at DESC, id DESC LIMIT 1`,
    )
    .get() as { at: string; reasoning: number } | undefined
  const lastError = database
    .prepare(
      `SELECT started_at AS at, purpose, error AS message FROM price_ai_calls
       WHERE ${FAILED} AND started_at >= ?
       ORDER BY started_at DESC, id DESC LIMIT 1`,
    )
    .get(since) as
    { at: string; purpose: AiPurpose; message: string | null } | undefined
  return {
    calls: totals.calls,
    failed: totals.failed,
    medianMs: durations.length
      ? durations[Math.floor((durations.length - 1) / 2)]
      : null,
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    byPurpose,
    lastCallAt: last?.at ?? null,
    lastError: lastError
      ? {
          at: lastError.at,
          purpose: lastError.purpose,
          message: lastError.message ?? 'The AI request failed.',
        }
      : null,
    reasoning: Boolean(last?.reasoning),
    today: readAiUsageToday(database, now),
    chatToday: readAiUsageToday(database, now, 'chat'),
  }
}
