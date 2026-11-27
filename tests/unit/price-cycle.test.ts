import { describe, expect, it } from 'vitest'
import {
  AI_RESERVE_SHARE,
  DEFER_MAX_MS,
  DEFER_MIN_MS,
  classifyCheck,
  deferredDueAt,
  linkDone,
  pickLaneCheck,
  pickLaneSearch,
  plannedCheckTimes,
  restPaceMs,
  type CycleLink,
  type CycleRetry,
} from '@/lib/price-monitor/cycle'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const START = Date.UTC(2026, 10, 27, 0)

const link = (patch: Partial<CycleLink> & { sourceId: number }): CycleLink => ({
  knifeId: `knife-${patch.sourceId}`,
  laneKey: 'bladehq.com',
  tier: 'collection',
  order: patch.sourceId,
  lastCheckedAt: START - DAY,
  priority: false,
  resting: false,
  ...patch,
})

const pick = (
  links: CycleLink[],
  patch: Partial<Parameters<typeof pickLaneCheck>[0]> = {},
) =>
  pickLaneCheck({
    now: START + MINUTE,
    cycleStart: START,
    links,
    retries: [],
    lastWasPriority: false,
    restReadyAt: START,
    deferredReadyAt: START,
    ...patch,
  })

describe('pickLaneCheck', () => {
  const wishlist = link({ sourceId: 1, tier: 'scope', order: 5 })
  const wishlistFirst = link({ sourceId: 2, tier: 'scope', order: 1 })
  const fresh = link({ sourceId: 3, lastCheckedAt: null })
  const old = link({ sourceId: 4, lastCheckedAt: START - 3 * DAY })
  const recent = link({ sourceId: 5, lastCheckedAt: START - HOUR })

  it('takes What to monitor in its order, then never checked, then the oldest', () => {
    const links = [recent, old, fresh, wishlist, wishlistFirst]
    const order: number[] = []
    const now = START + MINUTE
    let current = links
    for (let step = 0; step < 5; step++) {
      const { pick: next } = pick(current, { now })
      order.push(next!.sourceId)
      current = current.map((item) =>
        item.sourceId === next!.sourceId
          ? { ...item, lastCheckedAt: now }
          : item,
      )
    }
    expect(order).toEqual([2, 1, 3, 4, 5])
    expect(pick(current, { now }).pick).toBeNull()
  })

  it('names the group each check comes from', () => {
    expect(pick([wishlist]).pick).toEqual({
      sourceId: 1,
      group: 'wishlist',
      fix: false,
    })
    expect(pick([fresh]).pick?.group).toBe('new')
    expect(pick([old]).pick?.group).toBe('rest')
  })

  it('counts a link checked since the cycle started as done, even if it failed', () => {
    const done = link({ sourceId: 6, tier: 'scope', lastCheckedAt: START + 5 })
    expect(linkDone(done, START)).toBe(true)
    expect(pick([done]).pick).toBeNull()
  })

  it('leaves out links resting out of stock', () => {
    expect(pick([link({ sourceId: 7, resting: true })]).pick).toBeNull()
  })

  it('carries what the last cycle missed: never checked and oldest go first', () => {
    // The last cycle ran out of time: 8 and 9 were not reached, 10 was.
    const missed = link({ sourceId: 8, lastCheckedAt: START - 2 * DAY })
    const neverReached = link({ sourceId: 9, lastCheckedAt: null })
    const checked = link({ sourceId: 10, lastCheckedAt: START - HOUR })
    expect(pick([checked, missed, neverReached]).pick?.sourceId).toBe(9)
    expect(pick([checked, missed]).pick?.sourceId).toBe(8)
  })

  it('spreads the rest of the collection: none before its turn', () => {
    const result = pick([old], { restReadyAt: START + 20 * MINUTE })
    expect(result.pick).toBeNull()
    expect(result.wakeAt).toBe(START + 20 * MINUTE)
    // The spread never holds back What to monitor or new links.
    expect(
      pick([old, wishlist], { restReadyAt: START + 20 * MINUTE }).pick
        ?.sourceId,
    ).toBe(1)
    expect(
      pick([old, fresh], { restReadyAt: START + 20 * MINUTE }).pick?.sourceId,
    ).toBe(3)
  })

  it('moves links forward, at most every other task', () => {
    const watched = link({
      sourceId: 11,
      priority: true,
      lastCheckedAt: START + 10,
    })
    expect(pick([wishlist, watched]).pick).toMatchObject({
      sourceId: 11,
      group: 'priority',
    })
    expect(
      pick([wishlist, watched], { lastWasPriority: true }).pick?.sourceId,
    ).toBe(1)
    // With nothing ordinary to do, moved-forward links run back to back.
    expect(pick([watched], { lastWasPriority: true }).pick?.sourceId).toBe(11)
  })

  it("runs the supervisor's Retry with AI as a fix when it is due", () => {
    const retry: CycleRetry = {
      sourceId: 4,
      laneKey: 'bladehq.com',
      dueAt: START,
      supervisor: true,
    }
    expect(pick([wishlist, old], { retries: [retry] }).pick).toEqual({
      sourceId: 4,
      group: 'priority',
      fix: true,
    })
  })

  describe('deferred checks', () => {
    const due: CycleRetry = {
      sourceId: 4,
      laneKey: 'bladehq.com',
      dueAt: START,
      supervisor: false,
    }
    const done = { ...old, lastCheckedAt: START + 10 }

    it('run after What to monitor and new links, before the rest', () => {
      expect(pick([wishlist, done], { retries: [due] }).pick?.sourceId).toBe(1)
      expect(pick([fresh, done], { retries: [due] }).pick?.sourceId).toBe(3)
      expect(pick([done, recent], { retries: [due] }).pick).toEqual({
        sourceId: 4,
        group: 'deferred',
        fix: false,
      })
    })

    it('wait for their time, and for the store to allow the next one', () => {
      const later = { ...due, dueAt: START + 12 * MINUTE }
      expect(pick([done], { retries: [later] })).toEqual({
        pick: null,
        wakeAt: START + 12 * MINUTE,
      })
      const held = pick([done], {
        retries: [due],
        deferredReadyAt: START + 14 * MINUTE,
      })
      expect(held.pick).toBeNull()
      expect(held.wakeAt).toBe(START + 14 * MINUTE)
      // While one is held, the rest of the collection carries on.
      expect(
        pick([done, recent], {
          retries: [due],
          deferredReadyAt: START + 14 * MINUTE,
        }).pick?.sourceId,
      ).toBe(5)
    })

    it('never pick a problem waiting for AI', () => {
      const problem = { ...due, dueAt: null }
      expect(pick([done], { retries: [problem] })).toEqual({
        pick: null,
        wakeAt: null,
      })
    })
  })

  it('lets every store start at once: one pick per store', () => {
    const kizer = link({
      sourceId: 20,
      laneKey: 'kizerknives.com',
      tier: 'scope',
    })
    const smkw = link({ sourceId: 21, laneKey: 'smkw.com', tier: 'scope' })
    const links = [kizer, smkw]
    const picks = ['kizerknives.com', 'smkw.com'].map(
      (laneKey) =>
        pick(links.filter((item) => item.laneKey === laneKey)).pick?.sourceId,
    )
    expect(picks).toEqual([20, 21])
  })
})

describe('restPaceMs', () => {
  it('divides the cycle before its AI share over the links still to check', () => {
    // Blade HQ: 86 links over a 24 h cycle with 1 h gone.
    const pace = restPaceMs({
      now: START + HOUR,
      cycleStart: START,
      cycleMs: DAY,
      remaining: 86,
      floorMs: MINUTE,
    })
    const end = DAY * (1 - AI_RESERVE_SHARE)
    expect(pace).toBeCloseTo((end - HOUR) / 86)
    expect(pace).toBeGreaterThan(14 * MINUTE)
    expect(pace).toBeLessThan(15 * MINUTE)
  })

  it("never goes faster than the store's gap, and keeps it when late", () => {
    const base = { cycleStart: START, cycleMs: DAY, floorMs: MINUTE }
    expect(restPaceMs({ ...base, now: START, remaining: 5000 })).toBe(MINUTE)
    expect(restPaceMs({ ...base, now: START + 23 * HOUR, remaining: 5 })).toBe(
      MINUTE,
    )
    expect(restPaceMs({ ...base, now: START, remaining: 0 })).toBe(MINUTE)
  })
})

describe('pickLaneSearch', () => {
  it('searches for What to monitor first, then in the queue order', () => {
    const order = new Map([
      ['wish-b', 1],
      ['wish-a', 0],
    ])
    // The queue order: never searched first, then the longest waiting.
    expect(pickLaneSearch(['never', 'wish-b', 'wish-a'], order)).toBe('wish-a')
    expect(pickLaneSearch(['never', 'old'], order)).toBe('never')
    expect(pickLaneSearch([], order)).toBeNull()
  })
})

describe('classifyCheck', () => {
  const done = (
    outcome: 'ok' | 'no_price' | 'failed' | 'blocked',
    laneOutcome = 'failed',
    errorCode: string | null = null,
  ) => ({ status: 'done' as const, outcome, laneOutcome, errorCode })

  it('defers what the store could not answer now', () => {
    expect(classifyCheck(null)).toBe('defer')
    expect(classifyCheck(done('failed', 'throttled', 'http_429'))).toBe('defer')
    expect(classifyCheck(done('blocked', 'blocked', 'challenge'))).toBe('defer')
    expect(classifyCheck(done('failed', 'failed', 'timeout'))).toBe('defer')
    expect(classifyCheck(done('failed', 'failed', 'network'))).toBe('defer')
  })

  it('makes a page without a usable price a problem for AI', () => {
    expect(classifyCheck(done('no_price', 'neutral', 'no_price'))).toBe(
      'problem',
    )
    expect(classifyCheck(done('failed', 'neutral', 'http_404'))).toBe('problem')
    expect(classifyCheck(done('failed', 'neutral', 'suspicious'))).toBe(
      'problem',
    )
  })

  it('takes a read page off the list and ignores checks that did not run', () => {
    expect(classifyCheck(done('ok', 'success'))).toBe('ok')
    expect(classifyCheck({ status: 'skipped' })).toBe('none')
    expect(classifyCheck({ status: 'deferred' })).toBe('none')
  })
})

describe('deferredDueAt', () => {
  it('runs again 10 to 15 minutes later', () => {
    expect(deferredDueAt(START, () => 0)).toBe(START + DEFER_MIN_MS)
    expect(deferredDueAt(START, () => 1)).toBe(START + DEFER_MAX_MS)
  })
})

describe('plannedCheckTimes', () => {
  it('plans What to monitor and new links a gap apart, then spreads the rest', () => {
    const links = [
      link({ sourceId: 1, tier: 'scope' }),
      link({ sourceId: 2, lastCheckedAt: null }),
      link({ sourceId: 3 }),
      link({ sourceId: 4, lastCheckedAt: START - 2 * DAY }),
      link({ sourceId: 5, laneKey: 'smkw.com', tier: 'scope' }),
    ]
    const planned = plannedCheckTimes({
      links,
      now: START,
      cycleStart: START,
      cycleMs: DAY,
      floorMs: MINUTE,
      spread: true,
    })
    expect(planned.get(1)).toBe(START)
    expect(planned.get(2)).toBe(START + MINUTE)
    // The oldest of the rest first, then one even step later.
    expect(planned.get(4)).toBe(START + 2 * MINUTE)
    const step = planned.get(3)! - planned.get(4)!
    expect(step).toBeCloseTo((DAY * 0.9 - 2 * MINUTE) / 2)
    // Another store starts at the same moment.
    expect(planned.get(5)).toBe(START)
  })

  it('runs the rest at the store gap for Check all', () => {
    const planned = plannedCheckTimes({
      links: [link({ sourceId: 1 }), link({ sourceId: 2 })],
      now: START + HOUR,
      cycleStart: START,
      cycleMs: DAY,
      floorMs: MINUTE,
      spread: false,
    })
    expect(planned.get(2)! - planned.get(1)!).toBe(MINUTE)
    // A restart plans what is left from now.
    expect(planned.get(1)).toBe(START + HOUR)
  })
})
