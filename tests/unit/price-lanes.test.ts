import { describe, expect, it } from 'vitest'
import {
  applyLaneOutcome,
  COOLDOWNS_MS,
  defaultLaneState,
  DURATION_SAMPLES,
  isSlowCheck,
  laneAvailability,
  laneFloorMs,
  manualReadyAt,
  SOFT_BLOCK_AFTER,
  storeFloorMs,
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

describe('soft blocks', () => {
  it('pauses a store after pages without prices at links that had one', () => {
    let state = lane({ minGapMs: 2 * MIN, successStreak: 4 })
    for (let i = 1; i < SOFT_BLOCK_AFTER; i += 1) {
      state = apply(state, outcome('success', { suspect: true })).lane
      expect(state.circuit).toBe('closed')
      expect(state.softFailStreak).toBe(i)
      // Pages without prices never speed the store up.
      expect(state.successStreak).toBe(0)
      expect(state.minGapMs).toBe(2 * MIN)
    }
    state = apply(state, outcome('success', { suspect: true })).lane
    expect(state.circuit).toBe('open')
    expect(state.openReason).toBe('soft_block')
    expect(state.cooldownUntil).toBe(NOW + COOLDOWNS_MS[0])
    expect(state.softFailStreak).toBe(0)
  })

  it('resets the streak on a page with a price', () => {
    let state = lane()
    state = apply(state, outcome('success', { suspect: true })).lane
    state = apply(state, outcome('success', { suspect: true })).lane
    state = apply(state, outcome('success', { priced: true })).lane
    expect(state.softFailStreak).toBe(0)
    state = apply(state, outcome('success', { suspect: true })).lane
    expect(state.circuit).toBe('closed')
  })

  it('reopens at once when the probe after a soft block is suspect too', () => {
    const probe = lane({
      circuit: 'open',
      cooldownUntil: NOW - MIN,
      openCount: 1,
      openReason: 'soft_block',
    })
    const next = apply(probe, outcome('success', { suspect: true })).lane
    expect(next.circuit).toBe('open')
    expect(next.openCount).toBe(2)
    const healed = apply(probe, outcome('success', { priced: true })).lane
    expect(healed.circuit).toBe('closed')
    expect(healed.openReason).toBeNull()
  })

  it('keeps counting across searches and pages that already had no price', () => {
    let state = lane()
    state = apply(state, outcome('success', { suspect: true })).lane
    // A link already without a price, then an Other stores search.
    state = apply(state, outcome('success')).lane
    state = apply(state, outcome('success', { durationMs: 0 })).lane
    state = apply(state, outcome('success', { suspect: true })).lane
    expect(state.softFailStreak).toBe(2)
    state = apply(state, outcome('success', { suspect: true })).lane
    expect(state.circuit).toBe('open')
    expect(state.openReason).toBe('soft_block')
  })

  it('stays paused when a soft-block probe shows no price either way', () => {
    const probe = lane({
      circuit: 'open',
      cooldownUntil: NOW - MIN,
      openCount: 1,
      openReason: 'soft_block',
    })
    const next = apply(probe, outcome('success')).lane
    expect(next.circuit).toBe('open')
    expect(next.openCount).toBe(1)
    expect(next.cooldownUntil).toBe(NOW + COOLDOWNS_MS[0])
    // A probe after a bot check still closes on any answer.
    const blocked = lane({
      circuit: 'open',
      cooldownUntil: NOW - MIN,
      openCount: 1,
    })
    expect(apply(blocked, outcome('success')).lane.circuit).toBe('closed')
  })
})

describe('slow checks per store', () => {
  it('uses 15 s until a store has its own usual check time', () => {
    expect(isSlowCheck(lane(), 14_000)).toBe(false)
    expect(isSlowCheck(lane(), 16_000)).toBe(true)
  })

  it('learns the usual check time and judges by it', () => {
    let state = lane()
    for (let i = 0; i < DURATION_SAMPLES; i += 1)
      state = apply(state, outcome('success', { durationMs: 20_000 })).lane
    expect(state.typicalMs).toBe(20_000)
    expect(state.durationSamples).toBe(DURATION_SAMPLES)
    // A browser store at 20 s is not slow at 30 s, only past 40 s.
    expect(isSlowCheck(state, 30_000)).toBe(false)
    expect(isSlowCheck(state, 41_000)).toBe(true)
    // A fast store is slow well before 15 s, but never under 5 s.
    const fast = lane({ typicalMs: 1_000, durationSamples: DURATION_SAMPLES })
    expect(isSlowCheck(fast, 4_000)).toBe(false)
    expect(isSlowCheck(fast, 6_000)).toBe(true)
  })

  it('learned slow stores no longer slow down on every check', () => {
    const state = lane({
      minGapMs: 2 * MIN,
      typicalMs: 20_000,
      durationSamples: DURATION_SAMPLES,
    })
    expect(
      apply(state, outcome('success', { durationMs: 22_000 })).lane.minGapMs,
    ).toBe(2 * MIN)
  })

  it('searches (duration 0) leave the usual check time alone', () => {
    const state = lane({ typicalMs: 3_000, durationSamples: 2 })
    const next = apply(state, outcome('success', { durationMs: 0 })).lane
    expect(next.typicalMs).toBe(3_000)
    expect(next.durationSamples).toBe(2)
  })
})

describe('robots.txt floor', () => {
  it('never lets a store go below its Crawl-delay', () => {
    expect(storeFloorMs({ robotsDelayMs: null }, MIN)).toBe(MIN)
    expect(storeFloorMs({ robotsDelayMs: 10_000 }, MIN)).toBe(MIN)
    expect(storeFloorMs({ robotsDelayMs: 5 * MIN }, MIN)).toBe(5 * MIN)
    let state = lane({ minGapMs: 5 * MIN, robotsDelayMs: 5 * MIN })
    for (let i = 0; i < 10; i += 1)
      state = apply(state, outcome('success')).lane
    expect(state.minGapMs).toBe(5 * MIN)
  })
})
