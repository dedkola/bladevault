import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getLocalDb } from '@/lib/local-db'
import type { AiCallEvent } from '@/lib/price-monitor/ai-client'
import {
  AI_JOURNAL_RETENTION_MS,
  pruneAiCalls,
  readAiCallSummary,
  recordAiCall,
} from '@/lib/price-monitor/ai-journal'
import { createTempVault, type TempVault } from '../helpers/temp-vault'

const NOW = Date.UTC(2026, 10, 19, 12)
const HOUR = 60 * 60 * 1000

function event(patch: Partial<AiCallEvent> = {}): AiCallEvent {
  return {
    purpose: 'extraction',
    model: 'glm-5.3',
    startedAt: NOW - HOUR,
    durationMs: 4000,
    attempts: 1,
    ok: true,
    errorCode: null,
    error: null,
    promptTokens: 1000,
    completionTokens: 50,
    reasoning: false,
    ...patch,
  }
}

describe('AI call journal', () => {
  let vault: TempVault
  beforeEach(async () => {
    vault = await createTempVault()
  })
  afterEach(async () => {
    await vault.cleanup()
  })

  it('summarizes the last 24 hours', () => {
    recordAiCall(event({ durationMs: 2000 }))
    recordAiCall(event({ durationMs: 6000, purpose: 'solver' }))
    recordAiCall(
      event({
        startedAt: NOW - 30 * 60 * 1000,
        purpose: 'discovery_search',
        ok: false,
        errorCode: 'timeout',
        error: 'The AI endpoint did not answer in time.',
        promptTokens: null,
        completionTokens: null,
        reasoning: true,
      }),
    )
    // Older than a day: not counted.
    recordAiCall(event({ startedAt: NOW - 30 * HOUR }))

    const summary = readAiCallSummary(getLocalDb(), NOW)
    expect(summary).toMatchObject({
      calls: 3,
      failed: 1,
      medianMs: 2000,
      promptTokens: 2000,
      completionTokens: 100,
      reasoning: true,
      lastError: {
        purpose: 'discovery_search',
        message: 'The AI endpoint did not answer in time.',
      },
    })
    expect(summary.byPurpose).toHaveLength(3)
  })

  it('is empty without calls and prunes old rows', () => {
    expect(readAiCallSummary(getLocalDb(), NOW)).toMatchObject({
      calls: 0,
      failed: 0,
      medianMs: null,
      lastCallAt: null,
      lastError: null,
    })
    recordAiCall(event({ startedAt: NOW - AI_JOURNAL_RETENTION_MS - HOUR }))
    recordAiCall(event())
    pruneAiCalls(getLocalDb(), NOW)
    const rows = getLocalDb()
      .prepare('SELECT COUNT(*) AS count FROM price_ai_calls')
      .get() as { count: number }
    expect(rows.count).toBe(1)
  })
})
