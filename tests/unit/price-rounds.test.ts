import { describe, expect, it } from 'vitest'
import {
  LANE_WAIT_MS,
  RETRY_END_MARGIN_MS,
  STEP_ESTIMATE_MS,
  laneDecision,
  nextPassAt,
  nextRoundAt,
  planStep,
  plannedStepTimes,
  retryDueTimes,
  retryKey,
  retryableCheck,
  retryableSearch,
  tasksByLane,
  type StepSource,
} from '@/lib/price-monitor/rounds'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = Date.UTC(2026, 10, 25, 12)

const source = (patch: Partial<StepSource> & { sourceId: number }) => ({
  laneKey: 'shop.example',
  scheduled: true,
  checkedThisRound: false,
  restingOutOfStock: false,
  ...patch,
})

describe('next collection pass', () => {
  it('starts the first pass right away, and none while one runs', () => {
    expect(nextPassAt(null, NOW)).toBe(NOW)
    expect(
      nextPassAt({ startedAt: NOW - HOUR, finishedAt: null }, NOW),
    ).toBeNull()
  })

  it('waits a day from the last start, or none after a pass that took longer', () => {
    expect(
      nextPassAt(
        { startedAt: NOW - 3 * HOUR, finishedAt: NOW - 2 * HOUR },
        NOW,
      ),
    ).toBe(NOW + 21 * HOUR)
    expect(
      nextPassAt({ startedAt: NOW - 30 * HOUR, finishedAt: NOW - HOUR }, NOW),
    ).toBe(NOW - HOUR)
  })
})

describe('next round', () => {
  it('starts the first round right away', () => {
    expect(nextRoundAt(null, 6 * HOUR, NOW)).toBe(NOW)
  })

  it('waits while a round runs', () => {
    expect(
      nextRoundAt({ startedAt: NOW - HOUR, finishedAt: null }, 6 * HOUR, NOW),
    ).toBeNull()
  })

  it('starts one interval after the last start, never overlapping', () => {
    expect(
      nextRoundAt(
        { startedAt: NOW, finishedAt: NOW + 2 * HOUR },
        6 * HOUR,
        NOW,
      ),
    ).toBe(NOW + 6 * HOUR)
    // A round that ran longer than the interval: the next starts at its end.
    expect(
      nextRoundAt(
        { startedAt: NOW, finishedAt: NOW + 7 * HOUR },
        6 * HOUR,
        NOW,
      ),
    ).toBe(NOW + 7 * HOUR)
  })
})

describe('retry list times', () => {
  it('spreads retries at random between the round end and the next round', () => {
    const values = [0.9, 0, 0.5, 1]
    const times = retryDueTimes({
      count: 4,
      roundEnd: NOW,
      nextRoundAt: NOW + 6 * HOUR,
      random: () => values.shift()!,
    })
    const span = 6 * HOUR - RETRY_END_MARGIN_MS
    expect(times).toEqual([
      NOW,
      NOW + span / 2,
      NOW + Math.round(span * 0.9),
      NOW + span,
    ])
    expect(Math.max(...times)).toBeLessThanOrEqual(
      NOW + 6 * HOUR - RETRY_END_MARGIN_MS,
    )
  })

  it('retries right away when the round ran up to the next one', () => {
    expect(
      retryDueTimes({
        count: 2,
        roundEnd: NOW,
        nextRoundAt: NOW + 5 * MINUTE,
        random: () => 0.7,
      }),
    ).toEqual([NOW, NOW])
  })

  it('plans each knife a step plus the pause apart', () => {
    expect(
      plannedStepTimes({ count: 3, startAt: NOW, pauseMs: MINUTE }),
    ).toEqual([
      NOW,
      NOW + STEP_ESTIMATE_MS + MINUTE,
      NOW + 2 * (STEP_ESTIMATE_MS + MINUTE),
    ])
  })
})

describe('one knife step', () => {
  it('checks every scheduled store and searches the stores without a listing', () => {
    const tasks = planStep({
      sources: [
        source({ sourceId: 1, laneKey: 'maker.example' }),
        source({ sourceId: 2, laneKey: 'www.bladehq.com' }),
        // Paused store or out of scope: not scheduled.
        source({ sourceId: 3, laneKey: 'paused.example', scheduled: false }),
        // Check now already read it in this round.
        source({
          sourceId: 4,
          laneKey: 'fresh.example',
          checkedThisRound: true,
        }),
        // Out of stock for weeks and checked today.
        source({
          sourceId: 5,
          laneKey: 'old.example',
          restingOutOfStock: true,
        }),
      ],
      searches: [
        { store: 'bladehq', laneKey: 'www.bladehq.com' },
        { store: 'smkw', laneKey: 'www.smkw.com' },
        { store: 'amazon', laneKey: 'www.amazon.com' },
      ],
    })
    expect(tasks).toEqual([
      { kind: 'check', sourceId: 1, laneKey: 'maker.example' },
      { kind: 'check', sourceId: 2, laneKey: 'www.bladehq.com' },
      { kind: 'search', store: 'smkw', laneKey: 'www.smkw.com' },
      { kind: 'search', store: 'amazon', laneKey: 'www.amazon.com' },
    ])
  })

  it('never searches a store that has a listing, even a paused one', () => {
    expect(
      planStep({
        sources: [
          source({ sourceId: 7, laneKey: 'www.smkw.com', scheduled: false }),
        ],
        searches: [{ store: 'smkw', laneKey: 'www.smkw.com' }],
      }),
    ).toEqual([])
  })

  it('runs stores in parallel and one store’s tasks in order', () => {
    const lanes = tasksByLane([
      { kind: 'check', sourceId: 1, laneKey: 'a.example' },
      { kind: 'check', sourceId: 2, laneKey: 'b.example' },
      { kind: 'check', sourceId: 3, laneKey: 'a.example' },
    ])
    expect([...lanes.keys()]).toEqual(['a.example', 'b.example'])
    expect(
      lanes
        .get('a.example')!
        .map((task) => task.kind === 'check' && task.sourceId),
    ).toEqual([1, 3])
  })
})

describe('store readiness', () => {
  it('runs at a ready store and probes one whose pause is over', () => {
    expect(laneDecision({ state: 'ready' }, NOW)).toEqual({ action: 'run' })
    expect(laneDecision({ state: 'probe' }, NOW)).toEqual({ action: 'run' })
  })

  it('waits a little for a store that is ready soon', () => {
    expect(
      laneDecision({ state: 'waiting', until: NOW + MINUTE }, NOW),
    ).toEqual({ action: 'wait', until: NOW + MINUTE })
    expect(
      laneDecision({ state: 'waiting', until: NOW + LANE_WAIT_MS }, NOW),
    ).toEqual({ action: 'wait', until: NOW + LANE_WAIT_MS })
  })

  it('skips a store that needs longer onto the retry list', () => {
    expect(
      laneDecision({ state: 'waiting', until: NOW + 15 * MINUTE }, NOW),
    ).toEqual({ action: 'skip' })
    expect(laneDecision({ state: 'cooling', until: NOW + HOUR }, NOW)).toEqual({
      action: 'skip',
    })
    // Inside a step, the wait already spent counts against the allowance.
    expect(
      laneDecision({ state: 'waiting', until: NOW + MINUTE }, NOW, 30_000),
    ).toEqual({ action: 'skip' })
  })
})

describe('what goes on the retry list', () => {
  it('retries failed, blocked and unread checks', () => {
    expect(retryableCheck('failed')).toBe(true)
    expect(retryableCheck('blocked')).toBe(true)
    expect(retryableCheck('no_price')).toBe(true)
    expect(retryableCheck('ok')).toBe(false)
  })

  it('retries failed and blocked searches, not answers', () => {
    expect(retryableSearch('failed')).toBe(true)
    expect(retryableSearch('blocked')).toBe(true)
    expect(retryableSearch('not_found')).toBe(false)
    expect(retryableSearch('found')).toBe(false)
    expect(retryableSearch('variant')).toBe(false)
  })

  it('keys one item per source and per knife and store', () => {
    expect(retryKey({ kind: 'check', sourceId: 12 })).toBe('check:12')
    expect(retryKey({ kind: 'search', knifeId: 'k1', store: 'smkw' })).toBe(
      'search:k1:smkw',
    )
  })
})
