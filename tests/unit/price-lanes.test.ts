import { describe, expect, it } from 'vitest'
import {
  applyLaneOutcome,
  COOLDOWNS_MS,
  defaultLaneState,
  fullPassMs,
  laneAvailability,
  laneFloorMs,
  laneGapMs,
  manualReadyAt,
  MAX_SPREAD_GAP_MS,
  type LaneOutcome,
  type LaneState,
} from '@/lib/price-monitor/lanes'
import { DEFAULT_PRICE_MONITORING } from '@/lib/settings-shared'

const MIN = 60_000
const HOUR = 60 * MIN
const pacing = DEFAULT_PRICE_MONITORING.pacing
const NOW = Date.UTC(2026, 10, 18, 12)
const noJitter = () => 0

function lane(patch: Partial<LaneState> = {}): LaneState {
  return { ...defaultLaneState('shop.example', pacing, NOW), ...patch }
}

const outcome = (
  kind: LaneOutcome['kind'],
  patch: Partial<LaneOutcome> = {},
): LaneOutcome => ({ kind, durationMs: 4000, retryAfterMs: null, ...patch })

function apply(state: LaneState, result: LaneOutcome, gapMs = 10 * MIN) {
  return applyLaneOutcome(state, result, {
    now: NOW,
    gapMs,
    floorMs: laneFloorMs(pacing),
    random: noJitter,
  })
}

describe('lane pacing', () => {
  it('uses the minimum pause per store as every store’s floor', () => {
    expect(laneFloorMs(pacing)).toBe(MIN)
    expect(laneFloorMs({ minGapSeconds: 300 })).toBe(5 * MIN)
  })

  it('spreads a store’s checks over the active window', () => {
    // 100 products once a day: about one check every 11.5 minutes.
    const store = laneGapMs({
      minGapMs: 5 * MIN,
      floorMs: 5 * MIN,
      activeWindowMs: 24 * HOUR,
      sourceCount: 100,
    })
    expect(store).toBeCloseTo(11.52 * MIN, -2)
    expect(fullPassMs(store, 100)).toBeCloseTo(19.2 * HOUR, -3)
    // Few products: at most two hours apart, never idle all day.
    expect(
      laneGapMs({
        minGapMs: MIN,
        floorMs: MIN,
        activeWindowMs: 24 * HOUR,
        sourceCount: 5,
      }),
    ).toBe(MAX_SPREAD_GAP_MS)
    // 1000 products cannot fit: the minimum gap wins and the pass is longer.
    const crowded = laneGapMs({
      minGapMs: 5 * MIN,
      floorMs: 5 * MIN,
      activeWindowMs: 24 * HOUR,
      sourceCount: 1000,
    })
    expect(crowded).toBe(5 * MIN)
    expect(fullPassMs(crowded, 1000) / (24 * HOUR)).toBeCloseTo(3.47, 2)
  })

  it('speeds up after five successes, never below the floor', () => {
    let state = lane({ minGapMs: 4 * MIN })
    for (let i = 0; i < 5; i += 1) state = apply(state, outcome('success')).lane
    expect(state.minGapMs).toBeCloseTo(3.6 * MIN)
    expect(state.successStreak).toBe(0)
    state = lane({ minGapMs: MIN, successStreak: 4 })
    expect(apply(state, outcome('success')).lane.minGapMs).toBe(MIN)
  })

  it('slows down for slow answers and rate limits, honoring Retry-After', () => {
    expect(
      apply(
        lane({ minGapMs: 2 * MIN }),
        outcome('success', { durationMs: 20_000 }),
      ).lane.minGapMs,
    ).toBe(2.5 * MIN)
    const throttled = apply(
      lane({ minGapMs: 2 * MIN }),
      outcome('throttled', { retryAfterMs: HOUR }),
    ).lane
    expect(throttled.minGapMs).toBe(4 * MIN)
    expect(throttled.readyAt).toBe(NOW + HOUR)
    expect(throttled.circuit).toBe('closed')
  })

  it('jitters the next start by up to 20 %', () => {
    const update = applyLaneOutcome(lane(), outcome('success'), {
      now: NOW,
      gapMs: 10 * MIN,
      floorMs: MIN,
      random: () => 1,
    })
    expect(update.lane.readyAt).toBe(NOW + 12 * MIN)
  })
})

describe('circuit breaker', () => {
  it('opens on a bot check with escalating cooldowns', () => {
    let state = apply(lane(), outcome('blocked')).lane
    expect(state).toMatchObject({
      circuit: 'open',
      openCount: 1,
      cooldownUntil: NOW + COOLDOWNS_MS[0],
    })
    expect(laneAvailability(state, NOW + MIN)).toEqual({
      state: 'cooling',
      until: NOW + COOLDOWNS_MS[0],
    })
    // After the cooldown one probe runs; a failed probe reopens it longer.
    expect(laneAvailability(state, NOW + COOLDOWNS_MS[0])).toEqual({
      state: 'probe',
    })
    state = apply(state, outcome('failed')).lane
    expect(state).toMatchObject({
      openCount: 2,
      cooldownUntil: NOW + COOLDOWNS_MS[1],
    })
    const third = apply(state, outcome('blocked'))
    expect(third.lane.cooldownUntil).toBe(NOW + COOLDOWNS_MS[2])
    expect(third.clearCookies).toBe(true)
  })

  it('opens after three failures in a row and closes on a good probe', () => {
    let state = lane()
    state = apply(state, outcome('failed')).lane
    state = apply(state, outcome('failed')).lane
    expect(state.circuit).toBe('closed')
    state = apply(state, outcome('failed')).lane
    expect(state.circuit).toBe('open')
    const probe = apply(state, outcome('success')).lane
    expect(probe).toMatchObject({ circuit: 'closed', cooldownUntil: null })
  })

  it('resets escalation after a quiet day', () => {
    const old = lane({
      circuit: 'closed',
      openCount: 3,
      cooldownUntil: NOW - 25 * HOUR,
    })
    expect(apply(old, outcome('blocked')).lane).toMatchObject({
      openCount: 1,
      cooldownUntil: NOW + COOLDOWNS_MS[0],
    })
  })

  it('ignores problems that are not the store’s doing', () => {
    const state = apply(lane({ failureStreak: 2 }), outcome('neutral')).lane
    expect(state).toMatchObject({ circuit: 'closed', failureStreak: 2 })
  })

  it('lets Check now wait only for the minimum gap', () => {
    const state = lane({ lastRequestAt: NOW, minGapMs: 2 * MIN })
    expect(manualReadyAt(state)).toBe(NOW + 2 * MIN)
    expect(manualReadyAt(lane())).toBe(0)
  })
})
