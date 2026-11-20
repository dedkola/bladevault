import { describe, expect, it } from 'vitest'
import {
  AGENT_INTERVAL_LIMITED_MS,
  AGENT_INTERVAL_UNLIMITED_MS,
  AGENT_LIMITS,
  agentDue,
  readAgentPlan,
  validateAgentPlan,
  type AgentKnife,
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
    ahead: null,
    price: null,
    stock: null,
    outOfStockDays: null,
    ...patch,
  }
}

function knife(patch: Partial<AgentKnife> = {}): AgentKnife {
  return {
    knifeId: 'k1',
    knife: 'Kizer Drop Bear',
    regular: '129.00 USD',
    target: null,
    muted: false,
    best: '99.00 USD',
    bestStore: 'Kizer',
    low: '95.00 USD',
    low90d: '99.00 USD',
    high90d: '129.00 USD',
    lastPriceChange: null,
    lastStockChange: null,
    search: [{ store: 'Amazon', status: 'not_found', nextInDays: 20 }],
    watching: null,
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
      source({
        id: 7,
        status: 'failed',
        failures: 6,
        fetch: 'browser',
        error: 'not_found',
      }),
    ]
    const actions = validateAgentPlan(
      {
        summary: '',
        watchClosely: [],
        crossCheck: [],
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
      {
        sources,
        knives: [knife()],
        ai,
        otherStores: true,
        checkIntervalHours: 6,
      },
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
        watchClosely: [],
        crossCheck: [],
        check: [],
        retryWithAi: [{ sourceId: 5, reason: '' }],
        fetchMode: [],
        pause: [],
        searchOtherStore: [{ knifeId: 'k1', reason: '' }],
      },
      {
        sources,
        knives: [knife()],
        ai: { ...ai, readsPages: false, solvesErrors: false },
        otherStores: false,
        checkIntervalHours: 6,
      },
    )
    expect(off.map((action) => action.note)).toEqual([
      'AI page reading and error solving are off',
      'Other stores is off',
    ])
  })

  it('refuses checks that change nothing and searches that wait for nothing', () => {
    const actions = validateAgentPlan(
      {
        summary: '',
        watchClosely: [],
        crossCheck: [],
        check: [
          { sourceId: 1, reason: 'overdue' },
          { sourceId: 2, reason: 'near target' },
          { sourceId: 3, reason: 'not due yet, Black Friday' },
        ],
        retryWithAi: [],
        fetchMode: [],
        pause: [],
        searchOtherStore: ['k1', 'k2', 'k3', 'k4'].map((knifeId) => ({
          knifeId,
          reason: '',
        })),
      },
      {
        sources: [
          source({ id: 1, ahead: 0 }),
          source({ id: 2, ahead: 3 }),
          source({ id: 3, dueInMin: 240, ahead: null }),
        ],
        knives: [
          knife(),
          knife({
            knifeId: 'k2',
            search: [
              { store: 'Amazon', status: 'not_searched', nextInDays: 0 },
              { store: 'Blade HQ', status: 'failed', nextInDays: -1 },
            ],
          }),
          knife({
            knifeId: 'k3',
            search: [{ store: 'Amazon', status: 'found', nextInDays: null }],
          }),
          knife({ knifeId: 'k4', search: [] }),
        ],
        ai,
        otherStores: true,
        checkIntervalHours: 6,
      },
    )
    expect(
      actions.map((action) => [action.sourceId ?? action.knifeId, action.note]),
    ).toEqual([
      [1, 'already next at its store'],
      [2, null],
      [3, null],
      ['k1', null],
      ['k2', 'already due'],
      ['k3', 'already found'],
      ['k4', 'no other store to search'],
    ])
  })
})

describe('watchClosely and crossCheck', () => {
  it('clamps a watch to 72 hours and at least hourly checks', () => {
    const plan = readAgentPlan({
      summary: '',
      watchClosely: [
        { knifeId: 'k1', hours: 500, everyHours: 0.1, reason: 'drop' },
        { knifeId: 'k2', hours: 'x', everyHours: 2 },
        { knifeId: 7, hours: 5, everyHours: 2 },
      ],
      crossCheck: [{ knifeId: 'k1', reason: 'moved' }, { reason: 'none' }],
    })
    expect(plan.watchClosely).toEqual([
      { knifeId: 'k1', hours: 72, everyHours: 1, reason: 'drop' },
    ])
    expect(plan.crossCheck).toEqual([{ knifeId: 'k1', reason: 'moved' }])
  })

  it('refuses watches that change nothing or go too far', () => {
    const empty = {
      summary: '',
      check: [],
      retryWithAi: [],
      fetchMode: [],
      pause: [],
      searchOtherStore: [],
      crossCheck: [],
    }
    const watch = (knifeId: string, everyHours = 2) => ({
      knifeId,
      hours: 24,
      everyHours,
      reason: '',
    })
    const knives = [
      knife({ knifeId: 'k1' }),
      knife({ knifeId: 'k2' }),
      knife({
        knifeId: 'k3',
        watching: { everyHours: 2, endsInHours: 10, reason: '' },
      }),
      ...Array.from({ length: 18 }, (_, index) =>
        knife({
          knifeId: `w${index}`,
          watching: { everyHours: 2, endsInHours: 10, reason: '' },
        }),
      ),
    ]
    const sources = [
      source({ id: 1, knifeId: 'k1' }),
      source({ id: 2, knifeId: 'k2', monitored: false }),
      source({ id: 3, knifeId: 'k3' }),
    ]
    const actions = validateAgentPlan(
      {
        ...empty,
        watchClosely: [
          watch('k1', 6),
          watch('k2'),
          watch('nope'),
          watch('k1'),
          watch('k3'),
        ],
      },
      { sources, knives, ai, otherStores: false, checkIntervalHours: 6 },
    )
    expect(actions.map((action) => [action.knifeId, action.note])).toEqual([
      ['k1', 'not more often than the schedule (every 6 h)'],
      ['k2', 'no monitored source'],
      ['nope', 'unknown knife'],
      ['k1', 'asked twice'],
      // Already watched: a new watch replaces it without counting twice.
      ['k3', null],
    ])

    // 19 knives watched + k1 = 20: a 21st is refused.
    const full = validateAgentPlan(
      {
        ...empty,
        watchClosely: [watch('k1'), watch('k2')],
      },
      {
        sources: [
          source({ id: 1, knifeId: 'k1' }),
          source({ id: 2, knifeId: 'k2' }),
        ],
        knives,
        ai,
        otherStores: false,
        checkIntervalHours: 6,
      },
    )
    expect(full.map((action) => action.note)).toEqual([
      null,
      'already watching 20 knives',
    ])
  })

  it('cross-checks only the sources that can be read now', () => {
    const actions = validateAgentPlan(
      {
        summary: '',
        check: [],
        retryWithAi: [],
        fetchMode: [],
        pause: [],
        searchOtherStore: [],
        watchClosely: [],
        crossCheck: [
          { knifeId: 'k1', reason: 'moved at Kizer' },
          { knifeId: 'k2', reason: '' },
          { knifeId: 'nope', reason: '' },
        ],
      },
      {
        sources: [
          source({ id: 1, knifeId: 'k1', dueInMin: 300 }),
          source({ id: 2, knifeId: 'k1', checkedMinAgo: 5, dueInMin: 300 }),
          source({ id: 3, knifeId: 'k1', queued: true, dueInMin: 300 }),
          source({
            id: 4,
            knifeId: 'k1',
            status: 'blocked',
            dueInMin: 300,
          }),
          source({ id: 5, knifeId: 'k2', checkedMinAgo: 1, dueInMin: 300 }),
        ],
        knives: [knife({ knifeId: 'k1' }), knife({ knifeId: 'k2' })],
        ai,
        otherStores: false,
        checkIntervalHours: 6,
      },
    )
    expect(
      actions.map((action) => [action.knifeId, action.sourceIds, action.note]),
    ).toEqual([
      ['k1', [1], null],
      ['k2', [], 'no source to read now'],
      ['nope', [], 'unknown knife'],
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
