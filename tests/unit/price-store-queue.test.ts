import { describe, expect, it } from 'vitest'
import { retryKey } from '@/lib/price-monitor/rounds'
import { nextScheduledCheckAt } from '@/lib/price-monitor/schedule'
import {
  alignToSlot,
  checkAllPending,
  focusAllowed,
  pickForStore,
  projectChecks,
  slotFractions,
  slowStores,
  type StoreLink,
} from '@/lib/price-monitor/store-queue'
import { DEFAULT_PRICE_MONITORING } from '@/lib/settings-shared'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 10, 28, 12)

let nextId = 1
function link(overrides: Partial<StoreLink> = {}): StoreLink {
  const sourceId = overrides.sourceId ?? nextId++
  return {
    sourceId,
    knifeId: `k${sourceId}`,
    laneKey: 'shop.example',
    priority: 0,
    nextCheckAt: NOW - HOUR,
    lastCheckedAt: NOW - DAY - HOUR,
    intervalMs: DAY,
    tier: 'scope',
    focus: false,
    ...overrides,
  }
}

describe('a store’s next link', () => {
  it('goes moved forward, never checked, watched, What to monitor, then the collection', () => {
    const collection = link({ tier: 'collection', nextCheckAt: NOW - DAY })
    const scope = link()
    const watched = link({ focus: true, intervalMs: 3 * HOUR })
    const fresh = link({ lastCheckedAt: null, nextCheckAt: null })
    const moved = link({ priority: 1 })
    const order: number[] = []
    const left = [collection, scope, watched, fresh, moved]
    while (left.length) {
      const pick = pickForStore(left, NOW)!
      order.push(pick.sourceId)
      left.splice(left.indexOf(pick), 1)
    }
    expect(order).toEqual([
      moved.sourceId,
      fresh.sourceId,
      watched.sourceId,
      scope.sourceId,
      collection.sourceId,
    ])
  })

  it('takes the most overdue link for its own interval first', () => {
    // Two hours late on a 6-hour interval beats three hours on a day.
    const daily = link({ nextCheckAt: NOW - 3 * HOUR, intervalMs: DAY })
    const sixHourly = link({
      nextCheckAt: NOW - 2 * HOUR,
      intervalMs: 6 * HOUR,
    })
    expect(pickForStore([daily, sixHourly], NOW)).toBe(sixHourly)
  })

  it('has nothing to do when no link is due', () => {
    expect(pickForStore([link({ nextCheckAt: NOW + MIN })], NOW)).toBeNull()
  })

  it('gives watched knives at most one pick in three while others wait', () => {
    const watched = link({ focus: true })
    const other = link()
    expect(pickForStore([watched, other], NOW, ['other', 'other'])).toBe(
      watched,
    )
    expect(pickForStore([watched, other], NOW, ['focus'])).toBe(other)
    expect(pickForStore([watched, other], NOW, ['focus', 'other'])).toBe(other)
    // Alone, a watched knife never waits.
    expect(pickForStore([watched], NOW, ['focus'])).toBe(watched)
    // Searches do not count as picks.
    expect(focusAllowed(['focus', 'other', 'search', 'other'])).toBe(true)
  })
})

describe('slots', () => {
  it('spreads a store’s links evenly over the interval, each store on its own', () => {
    const fractions = slotFractions([
      { sourceId: 7, laneKey: 'a.example' },
      { sourceId: 3, laneKey: 'a.example' },
      { sourceId: 5, laneKey: 'a.example' },
      { sourceId: 9, laneKey: 'a.example' },
      { sourceId: 4, laneKey: 'b.example' },
    ])
    expect(Object.fromEntries(fractions)).toEqual({
      3: 0,
      5: 0.25,
      7: 0.5,
      9: 0.75,
      4: 0,
    })
  })

  it('moves the next check to the link’s slot, at most half an interval away', () => {
    const intervalMs = DAY
    const at = (now: number, fraction: number) =>
      alignToSlot({ now, intervalMs, fraction })
    const midnight = Date.UTC(2026, 10, 28)
    // Checked at noon, slot at 18:00: tomorrow 18:00.
    expect(at(midnight + 12 * HOUR, 0.75)).toBe(midnight + DAY + 18 * HOUR)
    // Checked at noon, slot at 03:00: tomorrow 03:00 is nearer than 03:00
    // the day after.
    expect(at(midnight + 12 * HOUR, 0.125)).toBe(midnight + DAY + 3 * HOUR)
    // Already in its slot: exactly one interval.
    expect(at(midnight + 6 * HOUR, 0.25)).toBe(midnight + DAY + 6 * HOUR)
    for (let hour = 0; hour < 24; hour += 1) {
      const now = midnight + hour * HOUR
      const next = at(now, 0.4)
      expect(Math.abs(next - (now + intervalMs))).toBeLessThanOrEqual(
        intervalMs / 2,
      )
      expect((next - midnight) % intervalMs).toBe(0.4 * intervalMs)
    }
  })

  it('aligns regular checks, not a watched knife’s short pace', () => {
    const schedule = DEFAULT_PRICE_MONITORING.schedule
    const midnight = Date.UTC(2026, 10, 28)
    const now = midnight + 12 * HOUR
    expect(
      nextScheduledCheckAt({
        schedule,
        intervalMs: DAY,
        outOfStockSince: null,
        now,
        slotFraction: 0.75,
      }),
    ).toBe(midnight + DAY + 18 * HOUR)
    expect(
      nextScheduledCheckAt({
        schedule,
        intervalMs: DAY,
        outOfStockSince: null,
        now,
        focusIntervalMs: 3 * HOUR,
        slotFraction: 0.75,
      }),
    ).toBe(now + 3 * HOUR)
    expect(
      nextScheduledCheckAt({
        schedule,
        intervalMs: DAY,
        outOfStockSince: null,
        now,
      }),
    ).toBe(now + DAY)
  })
})

describe('the plan', () => {
  it('expects each due link one store gap after the one before it', () => {
    const a1 = link({ laneKey: 'a.example', nextCheckAt: NOW - 2 * HOUR })
    const a2 = link({ laneKey: 'a.example', nextCheckAt: NOW - HOUR })
    const b1 = link({ laneKey: 'b.example' })
    const later = link({ laneKey: 'a.example', nextCheckAt: NOW + HOUR })
    const plan = projectChecks({
      links: [a1, a2, b1, later],
      now: NOW,
      stores: new Map([
        ['a.example', { readyAt: NOW + MIN, gapMs: 10 * MIN }],
        ['b.example', { readyAt: NOW - HOUR, gapMs: MIN }],
      ]),
    })
    expect(Object.fromEntries(plan)).toEqual({
      [a1.sourceId]: { at: NOW + MIN, ahead: 0 },
      [a2.sourceId]: { at: NOW + 11 * MIN, ahead: 1 },
      [b1.sourceId]: { at: NOW, ahead: 0 },
    })
  })

  it('names stores too slow for the interval, slowest first', () => {
    expect(
      slowStores(
        [
          { laneKey: 'fast.example', links: 95, gapMs: MIN },
          { laneKey: 'bladehq.com', links: 150, gapMs: 616_000 },
          { laneKey: 'dlttrading.com', links: 125, gapMs: 1_790_000 },
        ],
        DAY,
      ).map((store) => [store.laneKey, Math.round(store.cycleMs / HOUR)]),
    ).toEqual([
      ['dlttrading.com', 62],
      ['bladehq.com', 26],
    ])
  })

  it('keeps Check all running until each of its knives was checked', () => {
    const round = { knifeIds: ['k1', 'k2', 'k3'], startedAt: NOW }
    expect(
      [
        ...checkAllPending(round, [
          { knifeId: 'k1', nextCheckAt: NOW - 2000 },
          { knifeId: 'k1', nextCheckAt: NOW + DAY },
          { knifeId: 'k2', nextCheckAt: NOW + DAY },
          { knifeId: 'k3', nextCheckAt: null },
          { knifeId: 'other', nextCheckAt: NOW - DAY },
        ]),
      ].sort(),
    ).toEqual(['k1', 'k3'])
  })

  it('keys one retry per source and per knife and store', () => {
    expect(retryKey({ kind: 'check', sourceId: 12 })).toBe('check:12')
    expect(retryKey({ kind: 'search', knifeId: 'k1', store: 'smkw' })).toBe(
      'search:k1:smkw',
    )
  })
})
