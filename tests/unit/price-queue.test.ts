import { describe, expect, it } from 'vitest'
import { defaultLaneState, type LaneState } from '@/lib/price-monitor/lanes'
import {
  nextWakeAt,
  pickNextChecks,
  type QueueCandidate,
  type QueueInput,
} from '@/lib/price-monitor/queue'
import { DEFAULT_PRICE_MONITORING } from '@/lib/settings-shared'

const MIN = 60_000
const NOW = Date.UTC(2026, 10, 18, 12)
const pacing = DEFAULT_PRICE_MONITORING.pacing

let nextId = 1
function source(
  laneKey: string,
  patch: Partial<QueueCandidate> = {},
): QueueCandidate {
  return {
    sourceId: nextId++,
    laneKey,
    priority: 0,
    nextCheckAt: NOW - MIN,
    scheduled: true,
    ...patch,
  }
}

function input(
  candidates: QueueCandidate[],
  patch: Partial<QueueInput> = {},
  lanes: LaneState[] = [],
): QueueInput {
  return {
    candidates,
    lanes: new Map(lanes.map((lane) => [lane.laneKey, lane])),
    busyLanes: new Set(),
    maxParallel: 3,
    now: NOW,
    scheduledActive: true,
    defaultLane: (laneKey) => defaultLaneState(laneKey, pacing, NOW),
    ...patch,
  }
}

const lane = (laneKey: string, patch: Partial<LaneState>): LaneState => ({
  ...defaultLaneState(laneKey, pacing, NOW),
  ...patch,
})

describe('pickNextChecks', () => {
  it('checks one product per store, several stores in parallel', () => {
    const kizer = [source('kizer.example'), source('kizer.example')]
    const vosteed = [source('vosteed.com'), source('vosteed.com')]
    const amazon = [source('amazon'), source('amazon')]
    const picks = pickNextChecks(input([...kizer, ...vosteed, ...amazon]))
    expect(picks.map((pick) => pick.laneKey).sort()).toEqual([
      'amazon',
      'kizer.example',
      'vosteed.com',
    ])
    expect(new Set(picks.map((pick) => pick.laneKey)).size).toBe(3)
  })

  it('never starts a second check at a busy store', () => {
    const picks = pickNextChecks(
      input([source('amazon'), source('amazon'), source('kizer.example')], {
        busyLanes: new Set(['amazon']),
      }),
    )
    expect(picks.map((pick) => pick.laneKey)).toEqual(['kizer.example'])
  })

  it('respects the parallel limit and lets stores take turns', () => {
    const picks = pickNextChecks(
      input(
        [source('a.example'), source('b.example'), source('c.example')],
        { maxParallel: 2 },
        [
          lane('a.example', { lastRequestAt: NOW - 5 * MIN }),
          lane('b.example', { lastRequestAt: NOW - 50 * MIN }),
          lane('c.example', { lastRequestAt: NOW - 10 * MIN }),
        ],
      ),
    )
    expect(picks.map((pick) => pick.laneKey)).toEqual([
      'b.example',
      'c.example',
    ])
  })

  it('takes Check now first, then the most overdue product', () => {
    const overdue = source('shop.example', { nextCheckAt: NOW - 60 * MIN })
    const recent = source('shop.example', { nextCheckAt: NOW - MIN })
    expect(pickNextChecks(input([recent, overdue]))[0].sourceId).toBe(
      overdue.sourceId,
    )
    const manual = source('shop.example', { priority: 2, nextCheckAt: null })
    expect(pickNextChecks(input([recent, overdue, manual]))[0]).toEqual({
      sourceId: manual.sourceId,
      laneKey: 'shop.example',
      trigger: 'manual',
    })
  })

  it('waits for the store’s gap; Check now only for its minimum gap', () => {
    const waiting = lane('shop.example', {
      readyAt: NOW + 30 * MIN,
      lastRequestAt: NOW - 2 * MIN,
      minGapMs: MIN,
    })
    expect(
      pickNextChecks(input([source('shop.example')], {}, [waiting])),
    ).toEqual([])
    expect(
      pickNextChecks(
        input([source('shop.example', { priority: 2 })], {}, [waiting]),
      ),
    ).toHaveLength(1)
    const justChecked = { ...waiting, lastRequestAt: NOW - 10_000 }
    expect(
      pickNextChecks(
        input([source('shop.example', { priority: 2 })], {}, [justChecked]),
      ),
    ).toEqual([])
  })

  it('works through a backlog after a restart at the normal pace', () => {
    // The desktop app was closed for days: every product is overdue, and the
    // stores' saved gaps survive the restart.
    const DAY = 24 * 60 * MIN
    const backlog = [
      ...Array.from({ length: 5 }, (_, index) =>
        source('shop.example', { nextCheckAt: NOW - (3 + index) * DAY }),
      ),
      ...Array.from({ length: 5 }, () =>
        source('amazon', { nextCheckAt: NOW - 2 * DAY }),
      ),
    ]
    const stillWaiting = lane('amazon', {
      readyAt: NOW + 20 * MIN,
      lastRequestAt: NOW - 3 * DAY,
    })
    const first = pickNextChecks(input(backlog, {}, [stillWaiting]))
    expect(first.map((pick) => pick.laneKey)).toEqual(['shop.example'])

    // After that check the store waits for its gap again: no burst.
    const afterCheck = lane('shop.example', {
      readyAt: NOW + 30 * MIN,
      lastRequestAt: NOW,
    })
    expect(
      pickNextChecks(
        input(backlog, { now: NOW + MIN }, [stillWaiting, afterCheck]),
      ),
    ).toEqual([])
  })

  it('pauses blocked stores and sends a single probe after the cooldown', () => {
    const cooling = lane('shop.example', {
      circuit: 'open',
      cooldownUntil: NOW + 10 * MIN,
      readyAt: NOW + 10 * MIN,
    })
    expect(
      pickNextChecks(
        input([source('shop.example', { priority: 2 })], {}, [cooling]),
      ),
    ).toEqual([])
    const over = { ...cooling, cooldownUntil: NOW - 1, readyAt: NOW - 1 }
    expect(
      pickNextChecks(input([source('shop.example')], {}, [over]))[0].trigger,
    ).toBe('probe')
  })

  it('runs only Check now outside the schedule', () => {
    const scheduled = source('a.example')
    const manual = source('b.example', { priority: 2 })
    const notCovered = source('c.example', { scheduled: false })
    const picks = pickNextChecks(
      input([scheduled, manual, notCovered], { scheduledActive: false }),
    )
    expect(picks.map((pick) => pick.sourceId)).toEqual([manual.sourceId])
    expect(
      pickNextChecks(input([notCovered])).map((pick) => pick.sourceId),
    ).toEqual([])
    expect(
      pickNextChecks(input([source('a.example', { nextCheckAt: NOW + MIN })])),
    ).toEqual([])
  })
})

describe('nextWakeAt', () => {
  it('wakes when the earliest store or product becomes ready', () => {
    expect(nextWakeAt(input([]))).toBeNull()
    expect(
      nextWakeAt(
        input([source('a.example', { nextCheckAt: NOW + 5 * MIN })], {}, [
          lane('a.example', { readyAt: NOW + 2 * MIN }),
        ]),
      ),
    ).toBe(NOW + 5 * MIN)
    expect(
      nextWakeAt(
        input([source('a.example')], {}, [
          lane('a.example', { readyAt: NOW + 7 * MIN }),
        ]),
      ),
    ).toBe(NOW + 7 * MIN)
  })

  it('does not wake for scheduled work while outside the schedule', () => {
    expect(
      nextWakeAt(input([source('a.example')], { scheduledActive: false })),
    ).toBeNull()
  })
})
