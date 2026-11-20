import { describe, expect, it } from 'vitest'
import {
  AGENT_EVENT_BATCH_MS,
  AGENT_EVENT_GAP_LIMITED_MS,
  AGENT_EVENT_GAP_UNLIMITED_MS,
  AGENT_HEARTBEAT_LIMITED_MS,
  AGENT_HEARTBEAT_UNLIMITED_MS,
  AGENT_LIMITS,
  agentDue,
  agentNextRunAt,
  quotedAmounts,
  readAgentPlan,
  validateAgentPlan,
  type AgentInbox,
  type AgentKnife,
  type AgentPlan,
  type AgentSource,
} from '@/lib/price-monitor/agent'
import { DEFAULT_PRICE_MONITORING } from '@/lib/settings-shared'
import type { PriceAdviceTopic } from '@/lib/system-messages'

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
        remember: [],
        forget: [],
        advise: [],
        ask: [],
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
        remember: [],
        forget: [],
        advise: [],
        ask: [],
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
        remember: [],
        forget: [],
        advise: [],
        ask: [],
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
      remember: [],
      forget: [],
      advise: [],
      ask: [],
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
      remember: [],
      forget: [],
      advise: [],
      ask: [],
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
        remember: [],
        forget: [],
        advise: [],
        ask: [],
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

describe('advise and ask', () => {
  const empty: AgentPlan = {
    summary: '',
    remember: [],
    forget: [],
    check: [],
    retryWithAi: [],
    fetchMode: [],
    pause: [],
    searchOtherStore: [],
    watchClosely: [],
    crossCheck: [],
    advise: [],
    ask: [],
  }
  const snapshot = (inbox?: AgentInbox) => ({
    sources: [
      source({ id: 1, knifeId: 'k1', price: '99.00 USD' }),
      source({ id: 2, knifeId: 'k1', store: 'amazon.com', foundByAi: true }),
      source({ id: 3, knifeId: 'k2', knife: 'Begleiter' }),
    ],
    knives: [
      knife({ knifeId: 'k1' }),
      knife({ knifeId: 'k2', knife: 'Begleiter', muted: true }),
      knife({ knifeId: 'k3', knife: 'Mini', regular: '80.00 EUR' }),
    ],
    ai,
    otherStores: false,
    checkIntervalHours: 6,
    inbox,
  })
  const advice = (
    knifeId: string,
    detail: string,
    topic: PriceAdviceTopic = 'deal',
  ) => ({
    knifeId,
    topic,
    title: 'Drop Bear at its 90-day low',
    detail,
  })

  it('finds the amounts a text quotes', () => {
    expect(
      quotedAmounts('Now $99, was 129.00 USD (1,299.50 JPY), 23% off'),
    ).toEqual([99, 129, 1299.5])
    expect(quotedAmounts('Watch it for 72 hours')).toEqual([])
  })

  it('posts advice only with prices from the data, and not too often', () => {
    const actions = validateAgentPlan(
      {
        ...empty,
        advise: [
          advice('k1', 'Kizer has it at 99.00 USD, 23% below regular.'),
          advice('k2', 'Begleiter dropped.'),
          advice('k3', 'Mini is down to 59.99 EUR.'),
          advice('nope', ''),
        ],
      },
      snapshot(),
    )
    expect(actions.map((action) => [action.knifeId, action.note])).toEqual([
      ['k1', null],
      ['k2', 'notifications for this knife are muted'],
      ['k3', 'quotes a price not in the data (59.99)'],
      ['nope', 'unknown knife'],
    ])
    expect(actions[0].message).toEqual({
      title: 'Drop Bear at its 90-day low',
      detail: 'Kizer has it at 99.00 USD, 23% below regular.',
      payload: { type: 'advice', knifeId: 'k1', topic: 'deal' },
    })

    const recent = validateAgentPlan(
      {
        ...empty,
        advise: [
          advice('k1', 'See https://kizer.example', 'watch'),
          advice('k1', 'Again.', 'deal'),
          advice('k3', 'Mini is back.', 'restock'),
        ],
      },
      snapshot({
        advice: [
          { knifeId: 'k1', topic: 'deal', hoursAgo: 30, status: 'read' },
          ...Array.from({ length: 5 }, () => ({
            knifeId: 'x',
            topic: 'watch' as const,
            hoursAgo: 2,
            status: 'unread' as const,
          })),
        ],
        questions: [],
      }),
    )
    expect(recent.map((action) => action.note)).toEqual([
      'links are not allowed',
      'asked twice',
      // Five today, plus none accepted in this run: the sixth is the cap.
      null,
    ])
    const capped = validateAgentPlan(
      { ...empty, advise: [advice('k3', 'Mini is back.', 'restock')] },
      snapshot({
        advice: Array.from({ length: 6 }, () => ({
          knifeId: 'x',
          topic: 'watch' as const,
          hoursAgo: 2,
          status: 'unread' as const,
        })),
        questions: [],
      }),
    )
    expect(capped[0].note).toBe('already 6 notes today')
    const repeated = validateAgentPlan(
      { ...empty, advise: [advice('k1', 'Kizer has it at 99.00 USD.')] },
      snapshot({
        advice: [
          { knifeId: 'k1', topic: 'deal', hoursAgo: 30, status: 'read' },
        ],
        questions: [],
      }),
    )
    expect(repeated[0].note).toBe('same advice in the last 3 days')
  })

  it('asks only answerable questions, one per knife', () => {
    const ask = (patch: Partial<AgentPlan['ask'][number]>) => ({
      knifeId: 'k1',
      ask: 'set_target' as const,
      question: 'Alert me at this price?',
      price: null,
      sourceId: null,
      hours: null,
      everyHours: null,
      ...patch,
    })
    const actions = validateAgentPlan(
      {
        ...empty,
        ask: [
          ask({ price: '95.00 EUR' }),
          ask({ knifeId: 'k3', price: 'cheap' }),
          ask({ knifeId: 'k3', ask: 'keep_listing', sourceId: 1 }),
        ],
      },
      snapshot(),
    )
    expect(actions.map((action) => action.note)).toEqual([
      "not in the knife's currency (USD)",
      'no valid price',
      'asked twice',
    ])

    const ok = validateAgentPlan(
      {
        ...empty,
        ask: [
          ask({
            price: '95.00 USD',
            question: 'It sold for 95.00 USD before.',
          }),
          ask({ knifeId: 'k3', ask: 'keep_listing', sourceId: 2 }),
        ],
      },
      snapshot(),
    )
    expect(ok.map((action) => action.note)).toEqual([
      null,
      'unknown source for this knife',
    ])
    expect(ok[0].message).toEqual({
      title: 'Set a 95.00 USD target for Kizer Drop Bear?',
      detail: 'It sold for 95.00 USD before.',
      payload: {
        type: 'question',
        knifeId: 'k1',
        ask: 'set_target',
        priceMinor: 9500,
        currency: 'USD',
      },
    })

    const listing = validateAgentPlan(
      {
        ...empty,
        ask: [
          ask({ ask: 'keep_listing', sourceId: 1 }),
          ask({
            knifeId: 'k3',
            ask: 'watch_closely',
            hours: 24,
            everyHours: 2,
          }),
        ],
      },
      snapshot(),
    )
    expect(listing.map((action) => action.note)).toEqual([
      'only for listings Other stores found',
      // k3 has no source in the snapshot.
      'no monitored source',
    ])
    const found = validateAgentPlan(
      { ...empty, ask: [ask({ ask: 'keep_listing', sourceId: 2 })] },
      snapshot(),
    )
    expect(found[0].message?.payload).toEqual({
      type: 'question',
      knifeId: 'k1',
      ask: 'keep_listing',
      sourceId: 2,
      store: 'amazon.com',
    })

    const waiting = validateAgentPlan(
      {
        ...empty,
        ask: [
          ask({ price: '95.00 USD' }),
          ask({ knifeId: 'k3', ask: 'watch_closely', hours: 5, everyHours: 1 }),
        ],
      },
      snapshot({
        advice: [],
        questions: [
          { knifeId: 'k1', ask: 'watch_closely', daysAgo: 1, status: 'open' },
          { knifeId: 'a', ask: 'set_target', daysAgo: 1, status: 'open' },
          { knifeId: 'b', ask: 'set_target', daysAgo: 1, status: 'open' },
        ],
      }),
    )
    expect(waiting.map((action) => action.note)).toEqual([
      'a question about this knife is waiting',
      'already 3 open questions',
    ])
    const answered = validateAgentPlan(
      { ...empty, ask: [ask({ price: '95.00 USD' })] },
      snapshot({
        advice: [],
        questions: [
          { knifeId: 'k1', ask: 'set_target', daysAgo: 12, status: 'no' },
        ],
      }),
    )
    expect(answered[0].note).toBe('asked the same in the last 30 days')
  })

  it('reads advise and ask items, dropping malformed ones', () => {
    const plan = readAgentPlan({
      advise: [
        { knifeId: 'k1', topic: 'deal', title: ' Low ', detail: 'x' },
        { knifeId: 'k1', topic: 'gossip', title: 'Hi', detail: '' },
        { knifeId: 'k1', topic: 'deal', title: '', detail: 'no title' },
      ],
      ask: [
        {
          knifeId: 'k1',
          ask: 'watch_closely',
          question: 'Watch?',
          price: null,
          sourceId: null,
          hours: 900,
          everyHours: 0,
        },
        { knifeId: 'k1', ask: 'sell_it', question: 'Sell?' },
      ],
    })
    expect(plan.advise).toEqual([
      { knifeId: 'k1', topic: 'deal', title: 'Low', detail: 'x' },
    ])
    expect(plan.ask).toEqual([
      {
        knifeId: 'k1',
        ask: 'watch_closely',
        question: 'Watch?',
        price: null,
        sourceId: null,
        hours: 72,
        everyHours: 1,
      },
    ])
  })
})

describe('remember and forget', () => {
  const plan = (patch: Partial<AgentPlan>): AgentPlan => ({
    summary: '',
    check: [],
    retryWithAi: [],
    fetchMode: [],
    pause: [],
    searchOtherStore: [],
    watchClosely: [],
    crossCheck: [],
    advise: [],
    ask: [],
    remember: [],
    forget: [],
    ...patch,
  })
  const base = {
    sources: [source({ id: 1, knifeId: 'k1', price: '99.00 USD' })],
    knives: [knife({ knifeId: 'k1' })],
    ai,
    otherStores: false,
    checkIntervalHours: 6,
  }
  const note = (id: number, text: string, knifeId?: string) => ({
    id,
    note: text,
    ...(knifeId ? { knifeId } : {}),
  })

  it('reads notes, clamping how long they are kept', () => {
    const read = readAgentPlan({
      remember: [
        { knifeId: 'k1', note: '  Waits for Black Friday. ', days: 90 },
        { knifeId: null, note: 'Kizer restocks on Mondays.', days: 0.2 },
        { knifeId: null, note: '', days: 3 },
      ],
      forget: [{ noteId: 4, reason: 'done' }, { noteId: 'x' }],
    })
    expect(read.remember).toEqual([
      { knifeId: 'k1', note: 'Waits for Black Friday.', days: 30 },
      { knifeId: null, note: 'Kizer restocks on Mondays.', days: 1 },
    ])
    expect(read.forget).toEqual([{ noteId: 4, reason: 'done' }])
  })

  it('keeps useful notes within the limit and forgets known ones', () => {
    const remember = (knifeId: string | null, text: string) => ({
      knifeId,
      note: text,
      days: 10,
    })
    const actions = validateAgentPlan(
      plan({
        forget: [
          { noteId: 1, reason: 'restocked' },
          { noteId: 9, reason: '' },
        ],
        remember: [
          remember('k1', 'Below target at 99.00 USD: watch for 90.00 USD.'),
          remember('nope', 'Unknown.'),
          remember(null, 'Kizer restocks on Mondays.'),
        ],
      }),
      {
        ...base,
        notes: [
          note(1, 'Waits for the restock.', 'k1'),
          note(2, 'Kizer restocks on Mondays.'),
        ],
      },
    )
    expect(actions.map((action) => [action.kind, action.note])).toEqual([
      ['forget', null],
      ['forget', 'unknown note'],
      ['remember', 'quotes a price not in the data (90)'],
      ['remember', 'unknown knife'],
      ['remember', 'already noted'],
    ])

    const full = Array.from({ length: 30 }, (_, index) =>
      note(index + 1, `Note ${index + 1}`),
    )
    const capped = validateAgentPlan(
      plan({ remember: [remember(null, 'One more.')] }),
      { ...base, notes: full },
    )
    expect(capped[0].note).toBe('already 30 notes: forget one first')
    // Forgetting one in the same run makes room.
    const room = validateAgentPlan(
      plan({
        forget: [{ noteId: 3, reason: 'old' }],
        remember: [remember('k1', 'Sold at 99.00 USD for a week.')],
      }),
      { ...base, notes: full },
    )
    expect(room.map((action) => action.note)).toEqual([null, null])
    expect(room[1]).toMatchObject({
      knifeId: 'k1',
      memory: 'Sold at 99.00 USD for a week.',
      days: 10,
    })
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
  const unlimited = {
    ...configured,
    ai: {
      ...configured.ai,
      usage: { ...configured.ai.usage, mode: 'unlimited' as const },
    },
  }
  const MIN = 60_000

  it('beats every 6 hours with Limited AI and hourly with Unlimited', () => {
    expect(agentDue({ settings: configured, lastRunAt: null, now: NOW })).toBe(
      'scheduled',
    )
    expect(
      agentDue({
        settings: configured,
        lastRunAt: NOW - AGENT_HEARTBEAT_LIMITED_MS + 1,
        now: NOW,
      }),
    ).toBeNull()
    expect(
      agentDue({
        settings: configured,
        lastRunAt: NOW - AGENT_HEARTBEAT_LIMITED_MS,
        now: NOW,
      }),
    ).toBe('scheduled')
    expect(
      agentDue({
        settings: unlimited,
        lastRunAt: NOW - AGENT_HEARTBEAT_UNLIMITED_MS,
        now: NOW,
      }),
    ).toBe('scheduled')
  })

  it('wakes for changes after a short batch and the gap since the last run', () => {
    const due = (lastAgo: number, oldestAgo: number | null, total = 1) =>
      agentDue({
        settings: unlimited,
        lastRunAt: NOW - lastAgo,
        now: NOW,
        events: {
          total,
          oldestAt: oldestAgo === null ? null : NOW - oldestAgo,
        },
      })
    expect(due(30 * MIN, 5 * MIN)).toBe('event')
    // The first change is not 2 minutes old yet: more may follow.
    expect(due(30 * MIN, AGENT_EVENT_BATCH_MS - 1)).toBeNull()
    // Too soon after the last run (10 minutes with Unlimited).
    expect(due(AGENT_EVENT_GAP_UNLIMITED_MS - 1, 5 * MIN)).toBeNull()
    expect(due(30 * MIN, null, 0)).toBeNull()
    // Limited waits an hour between runs, even for changes.
    expect(
      agentDue({
        settings: configured,
        lastRunAt: NOW - 30 * MIN,
        now: NOW,
        events: { total: 3, oldestAt: NOW - 20 * MIN },
      }),
    ).toBeNull()
    expect(
      agentDue({
        settings: configured,
        lastRunAt: NOW - AGENT_EVENT_GAP_LIMITED_MS,
        now: NOW,
        events: { total: 3, oldestAt: NOW - 20 * MIN },
      }),
    ).toBe('event')
  })

  it('knows when the next run starts at the latest', () => {
    const next = (oldestAgo: number | null) =>
      agentNextRunAt({
        settings: unlimited,
        lastRunAt: NOW - 5 * MIN,
        now: NOW,
        events: {
          total: oldestAgo === null ? 0 : 1,
          oldestAt: oldestAgo === null ? null : NOW - oldestAgo,
        },
      })
    expect(next(null)).toBe(NOW - 5 * MIN + AGENT_HEARTBEAT_UNLIMITED_MS)
    // The gap ends 5 minutes from now; the batch already passed.
    expect(next(4 * MIN)).toBe(NOW + 5 * MIN)
  })

  it('never runs when off or without AI', () => {
    expect(
      agentDue({
        settings: { ...configured, ai: { ...configured.ai, agentMode: 'off' } },
        lastRunAt: null,
        now: NOW,
      }),
    ).toBeNull()
    expect(
      agentDue({
        settings: { ...configured, ai: { ...configured.ai, model: '' } },
        lastRunAt: null,
        now: NOW,
      }),
    ).toBeNull()
  })
})
