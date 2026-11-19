import { describe, expect, it } from 'vitest'
import {
  AGENT_INTERVAL_LIMITED_MS,
  AGENT_INTERVAL_UNLIMITED_MS,
  AGENT_LIMITS,
  agentDue,
  readAgentPlan,
  validateAgentPlan,
  type AgentSource,
} from '@/lib/price-monitor/agent'
import { DEFAULT_PRICE_MONITORING } from '@/lib/settings-shared'

const NOW = Date.UTC(2026, 10, 19, 12)

function source(patch: Partial<AgentSource> = {}): AgentSource {
  return {
    id: 1,
    knifeId: 'k1',
    knife: 'Kizer Drop Bear',
    store: 'kizer.example',
    status: 'ok',
    monitored: true,
    fetch: 'auto',
    checkedMinAgo: 600,
    okMinAgo: 600,
    error: null,
    failures: 0,
    dueInMin: -5,
    aiMinAgo: null,
    queued: false,
    ...patch,
  }
}

const ai = {
  usage: 'unlimited' as const,
  today: { calls: 0, tokens: 0 },
  dailyCalls: 200,
  dailyTokens: 2_000_000,
  readsPages: true,
  solvesErrors: true,
}

describe('readAgentPlan', () => {
  it('keeps only well-formed items, capped per kind', () => {
    const plan = readAgentPlan({
      summary: '  All   good.  ',
      check: [
        ...Array.from({ length: 40 }, (_, index) => ({
          sourceId: index + 1,
          reason: 'stale',
        })),
      ],
      retryWithAi: [{ sourceId: 'x' }, { sourceId: 3.5 }, { sourceId: 4 }],
      fetchMode: [
        { sourceId: 2, mode: 'browser', reason: 'scripts' },
        { sourceId: 3, mode: 'turbo', reason: 'no' },
      ],
      pause: 'nope',
      searchOtherStore: [{ knifeId: 'k1', reason: 'sold out' }, {}],
    })
    expect(plan.summary).toBe('All good.')
    expect(plan.check).toHaveLength(AGENT_LIMITS.check)
    expect(plan.retryWithAi).toEqual([{ sourceId: 4, reason: '' }])
    expect(plan.fetchMode).toEqual([
      { sourceId: 2, mode: 'browser', reason: 'scripts' },
    ])
    expect(plan.pause).toEqual([])
    expect(plan.searchOtherStore).toEqual([
      { knifeId: 'k1', reason: 'sold out' },
    ])
    expect(readAgentPlan(null).check).toEqual([])
  })
})

describe('validateAgentPlan', () => {
  it('refuses actions outside the fixed limits and explains why', () => {
    const sources = [
      source({ id: 1 }),
      source({ id: 2, checkedMinAgo: 10 }),
      source({ id: 3, queued: true }),
      source({ id: 4, monitored: false }),
      source({ id: 5, status: 'failed', failures: 2 }),
      source({ id: 6, status: 'blocked', failures: 9 }),
      source({ id: 7, status: 'failed', failures: 6, fetch: 'browser' }),
    ]
    const actions = validateAgentPlan(
      {
        summary: '',
        check: [1, 2, 3, 4, 99, 1].map((sourceId) => ({
          sourceId,
          reason: '',
        })),
        retryWithAi: [5, 6].map((sourceId) => ({ sourceId, reason: '' })),
        fetchMode: [
          { sourceId: 7, mode: 'browser', reason: '' },
          { sourceId: 5, mode: 'browser', reason: '' },
        ],
        pause: [5, 6, 7].map((sourceId) => ({ sourceId, reason: '' })),
        searchOtherStore: [
          { knifeId: 'k1', reason: '' },
          { knifeId: 'nope', reason: '' },
        ],
      },
      { sources, ai, otherStores: true },
    )
    const result = actions.map((action) => [
      action.kind,
      action.sourceId ?? action.knifeId,
      action.note,
    ])
    expect(result).toEqual([
      ['check', 1, null],
      ['check', 2, 'checked less than 30 minutes ago'],
      ['check', 3, 'already queued'],
      ['check', 4, 'not monitored'],
      ['check', 99, 'unknown source'],
      ['check', 1, 'asked twice'],
      ['retryWithAi', 5, null],
      ['retryWithAi', 6, 'status is blocked'],
      ['fetchMode', 7, 'already browser'],
      ['fetchMode', 5, null],
      ['pause', 5, 'only 2 failed checks in a row'],
      ['pause', 6, 'status is blocked'],
      ['pause', 7, null],
      ['searchOtherStore', 'k1', null],
      ['searchOtherStore', 'nope', 'unknown knife'],
    ])
    expect(
      actions.filter((action) => action.status === 'proposed'),
    ).toHaveLength(5)

    // AI reading off, Other stores off.
    const off = validateAgentPlan(
      {
        summary: '',
        check: [],
        retryWithAi: [{ sourceId: 5, reason: '' }],
        fetchMode: [],
        pause: [],
        searchOtherStore: [{ knifeId: 'k1', reason: '' }],
      },
      {
        sources,
        ai: { ...ai, readsPages: false, solvesErrors: false },
        otherStores: false,
      },
    )
    expect(off.map((action) => action.note)).toEqual([
      'AI page reading and error solving are off',
      'Other stores is off',
    ])
  })
})

describe('agentDue', () => {
  const configured = {
    ...DEFAULT_PRICE_MONITORING,
    ai: {
      ...DEFAULT_PRICE_MONITORING.ai,
      enabled: true,
      baseUrl: 'http://localhost:11434/v1',
      model: 'm',
      agentMode: 'act' as const,
    },
  }
  it('runs hourly with Limited AI and every 10 minutes with Unlimited', () => {
    expect(agentDue({ settings: configured, lastRunAt: null, now: NOW })).toBe(
      true,
    )
    expect(
      agentDue({
        settings: configured,
        lastRunAt: NOW - AGENT_INTERVAL_LIMITED_MS + 1,
        now: NOW,
      }),
    ).toBe(false)
    const unlimited = {
      ...configured,
      ai: {
        ...configured.ai,
        usage: { ...configured.ai.usage, mode: 'unlimited' as const },
      },
    }
    expect(
      agentDue({
        settings: unlimited,
        lastRunAt: NOW - AGENT_INTERVAL_UNLIMITED_MS,
        now: NOW,
      }),
    ).toBe(true)
  })
  it('never runs when off or without AI', () => {
    expect(
      agentDue({
        settings: { ...configured, ai: { ...configured.ai, agentMode: 'off' } },
        lastRunAt: null,
        now: NOW,
      }),
    ).toBe(false)
    expect(
      agentDue({
        settings: { ...configured, ai: { ...configured.ai, model: '' } },
        lastRunAt: null,
        now: NOW,
      }),
    ).toBe(false)
  })
})
