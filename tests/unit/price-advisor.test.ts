import { describe, expect, it } from 'vitest'
import {
  ADVICE_TTL_MS,
  ADVISOR_MAX_BACKOFF_MS,
  advisorBackoffMs,
  advisorDue,
  applyAdviceToLane,
  buildAdvisorInput,
  clampAdvice,
  inQuietHours,
  maxAdvisedGapMs,
  recentlyHealthy,
  type ActiveLaneAdvice,
} from '@/lib/price-monitor/advisor'
import type { AdvisorRows } from '@/lib/price-monitor/advice-store'
import { MAX_MIN_GAP_MS, type LaneState } from '@/lib/price-monitor/lanes'
import { DEFAULT_PRICE_MONITORING } from '@/lib/settings-shared'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = new Date(2026, 10, 18, 12, 0, 0).getTime()

const lanes = new Map([
  ['amazon', { floorMs: 300_000 }],
  ['vosteed.com', { floorMs: 60_000 }],
])

function lane(patch: Partial<LaneState> = {}): LaneState {
  return {
    laneKey: 'vosteed.com',
    minGapMs: 60_000,
    readyAt: NOW,
    circuit: 'closed',
    cooldownUntil: null,
    openCount: 0,
    successStreak: 0,
    failureStreak: 0,
    lastRequestAt: null,
    ...patch,
  }
}

function advice(patch: Partial<ActiveLaneAdvice> = {}): ActiveLaneAdvice {
  return {
    adviceId: 1,
    minGapMs: null,
    pauseUntil: null,
    quietHours: null,
    reason: '',
    expiresAt: NOW + ADVICE_TTL_MS,
    ...patch,
  }
}

describe('clampAdvice', () => {
  const store = (patch: Record<string, unknown>) => ({
    store: 'vosteed.com',
    minGapSeconds: null,
    cooldownMinutes: null,
    quietHours: null,
    strategy: null,
    reason: 'ok',
    ...patch,
  })

  it('keeps gaps between the store floor and 6 hours', () => {
    const result = clampAdvice(
      {
        stores: [
          { ...store({ minGapSeconds: 10 }), store: 'amazon' },
          store({ minGapSeconds: 999_999 }),
        ],
      },
      { lanes, now: NOW },
    )
    // Below the floor is no change at all, so Amazon is left out.
    expect(result.lanes).toHaveLength(1)
    expect(result.lanes[0]).toMatchObject({
      laneKey: 'vosteed.com',
      minGapMs: MAX_MIN_GAP_MS,
      adjustments: ['gap capped at 6 h'],
    })
    expect(result.expiresAt).toBe(new Date(NOW + ADVICE_TTL_MS).toISOString())

    const slower = clampAdvice(
      { stores: [store({ minGapSeconds: 1200 })] },
      { lanes, now: NOW },
    )
    expect(slower.lanes[0].minGapMs).toBe(1_200_000)
  })

  it('caps pauses at 48 hours and quiet hours at 12 hours a day', () => {
    const result = clampAdvice(
      {
        stores: [
          store({
            cooldownMinutes: 10_000,
            quietHours: { start: 18, end: 12 },
            reason: `  long\n reason ${'x'.repeat(400)}`,
          }),
        ],
      },
      { lanes, now: NOW },
    )
    const [entry] = result.lanes
    expect(entry.pauseUntil).toBe(new Date(NOW + 48 * HOUR).toISOString())
    expect(entry.quietHours).toEqual([18, 6])
    expect(entry.adjustments).toEqual([
      'pause capped at 48 h',
      'quiet hours shortened to 12 h',
    ])
    expect(entry.reason.startsWith('long reason')).toBe(true)
    expect(entry.reason.length).toBeLessThanOrEqual(200)
  })

  it('ignores unknown stores, duplicates, HTTP-first, bad hours and no-op advice', () => {
    const result = clampAdvice(
      {
        stores: [
          { ...store({ minGapSeconds: 600 }), store: 'evil.example' },
          store({ strategy: 'http_first', quietHours: { start: 5, end: 5 } }),
          store({ minGapSeconds: 600 }),
          { ...store({ strategy: 'browser_first' }), store: 'AMAZON ' },
          'garbage',
        ],
      },
      { lanes, now: NOW },
    )
    expect(result.lanes.map((entry) => entry.laneKey)).toEqual(['amazon'])
    expect(result.lanes[0]).toMatchObject({
      strategy: 'browser_first',
      minGapMs: null,
    })
    expect(clampAdvice(null, { lanes, now: NOW }).lanes).toEqual([])
    expect(clampAdvice({ stores: 'x' }, { lanes, now: NOW }).lanes).toEqual([])
  })
})

describe('applyAdviceToLane', () => {
  it('only slows a store down', () => {
    const slowed = applyAdviceToLane(
      lane({ minGapMs: 120_000 }),
      advice({ minGapMs: 600_000, pauseUntil: NOW + HOUR }),
      NOW,
    )
    expect(slowed.minGapMs).toBe(600_000)
    expect(slowed.readyAt).toBe(NOW + HOUR)

    // Advice below the current adaptive gap changes nothing.
    const kept = applyAdviceToLane(
      lane({ minGapMs: 900_000, readyAt: NOW + 2 * HOUR }),
      advice({ minGapMs: 600_000, pauseUntil: NOW + HOUR }),
      NOW,
    )
    expect(kept.minGapMs).toBe(900_000)
    expect(kept.readyAt).toBe(NOW + 2 * HOUR)
  })

  it('never shortens an open circuit', () => {
    const open = lane({
      circuit: 'open',
      cooldownUntil: NOW + 8 * HOUR,
      readyAt: NOW + 8 * HOUR,
    })
    const result = applyAdviceToLane(
      open,
      advice({ pauseUntil: NOW + HOUR }),
      NOW,
    )
    expect(result.circuit).toBe('open')
    expect(result.cooldownUntil).toBe(NOW + 8 * HOUR)
    expect(result.readyAt).toBe(NOW + 8 * HOUR)
  })

  it('ignores expired advice', () => {
    const base = lane()
    expect(
      applyAdviceToLane(
        base,
        advice({ minGapMs: 600_000, expiresAt: NOW - 1 }),
        NOW,
      ),
    ).toBe(base)
    expect(applyAdviceToLane(base, undefined, NOW)).toBe(base)
  })
})

describe('inQuietHours', () => {
  it('holds a store inside its advised window, across midnight', () => {
    const quiet = advice({ quietHours: [22, 6] })
    const at = (hour: number) => new Date(2026, 10, 18, hour, 30)
    expect(inQuietHours(quiet, at(23))).toBe(true)
    expect(inQuietHours(quiet, at(3))).toBe(true)
    expect(inQuietHours(quiet, at(12))).toBe(false)
    expect(
      inQuietHours(advice({ quietHours: [22, 6], expiresAt: 0 }), at(23)),
    ).toBe(false)
    expect(inQuietHours(undefined, at(23))).toBe(false)
  })
})

describe('advisorDue', () => {
  it('runs daily and after a store blocked twice within a day', () => {
    expect(advisorDue({ lastRunAt: null, lanes: [], now: NOW })).toBe('daily')
    expect(advisorDue({ lastRunAt: NOW - DAY, lanes: [], now: NOW })).toBe(
      'daily',
    )
    expect(
      advisorDue({ lastRunAt: NOW - 2 * HOUR, lanes: [], now: NOW }),
    ).toBeNull()
    const blocked = lane({
      openCount: 2,
      cooldownUntil: NOW - HOUR,
      lastRequestAt: NOW - HOUR,
    })
    expect(
      advisorDue({ lastRunAt: NOW - 7 * HOUR, lanes: [blocked], now: NOW }),
    ).toBe('repeated_blocks')
    // Not more often than every 6 hours.
    expect(
      advisorDue({ lastRunAt: NOW - 5 * HOUR, lanes: [blocked], now: NOW }),
    ).toBeNull()
    // Openings from days ago do not count.
    expect(
      advisorDue({
        lastRunAt: NOW - 7 * HOUR,
        lanes: [lane({ openCount: 3, cooldownUntil: NOW - 2 * DAY })],
        now: NOW,
      }),
    ).toBeNull()
  })
})

describe('buildAdvisorInput', () => {
  const rows: AdvisorRows = {
    daily: [
      {
        laneKey: 'vosteed.com',
        checks: 4,
        ok: 2,
        noPrice: 1,
        failed: 0,
        blocked: 1,
        aiUsed: 1,
      },
    ],
    checks: [
      ['ok', null, 1000, 9],
      ['ok', null, 3000, 9],
      ['no_price', 'not_found', 2000, 10],
      ['blocked', 'challenge', 20_000, 21],
    ].map(([outcome, errorCode, durationMs, hour]) => ({
      laneKey: 'vosteed.com',
      outcome: outcome as string,
      errorCode: errorCode as string | null,
      durationMs: durationMs as number,
      startedAt: new Date(2026, 10, 17, hour as number, 15).toISOString(),
    })),
    sources: new Map([['vosteed.com', 12]]),
  }

  it('aggregates per-store statistics', () => {
    const input = buildAdvisorInput({
      rows,
      lanes: new Map([
        [
          'vosteed.com',
          lane({ circuit: 'open', cooldownUntil: NOW + HOUR, openCount: 1 }),
        ],
      ]),
      settings: DEFAULT_PRICE_MONITORING,
      now: NOW,
      timeZone: 'Europe/Berlin',
    })
    expect(input).toMatchObject({
      frequencyHours: 24,
      statsDays: 7,
      timeZone: 'Europe/Berlin',
    })
    expect(input.stores).toEqual([
      {
        store: 'vosteed.com',
        sources: 12,
        checks: 4,
        successRate: 0.75,
        noPrice: 1,
        failed: 0,
        blocked: 1,
        aiUsed: 1,
        failureCodes: { not_found: 1, challenge: 1 },
        latencyMsP50: 2000,
        latencyMsP95: 20_000,
        byHour: [
          { hour: 9, checks: 2, successRate: 1 },
          { hour: 10, checks: 1, successRate: 1 },
          { hour: 21, checks: 1, successRate: 0 },
        ],
        currentGapSeconds: 60,
        floorSeconds: 60,
        circuit: 'open',
        recentOpenings: 1,
        // Only the 21:15 check falls in the last 24 hours.
        recent: {
          checks: 1,
          answered: 0,
          blocked: 1,
          failed: 0,
          lastOutcomes: ['blocked'],
        },
        maxGapSeconds: 5760,
      },
    ])
  })

  it('leaves out stores without active sources', () => {
    const input = buildAdvisorInput({
      rows: {
        ...rows,
        checks: [
          ...rows.checks,
          {
            laneKey: 'knifecenter.com',
            outcome: 'blocked',
            errorCode: 'challenge',
            durationMs: 1000,
            startedAt: new Date(NOW - HOUR).toISOString(),
          },
        ],
      },
      lanes: new Map(),
      settings: DEFAULT_PRICE_MONITORING,
      now: NOW,
      timeZone: 'UTC',
    })
    expect(input.stores.map((store) => store.store)).toEqual(['vosteed.com'])
  })

  it('contains store host names and numbers only', () => {
    const json = JSON.stringify(
      buildAdvisorInput({
        rows,
        lanes: new Map(),
        settings: DEFAULT_PRICE_MONITORING,
        now: NOW,
        timeZone: 'UTC',
      }),
    )
    expect(json).not.toMatch(/https?:|\/products\//)
  })
})

describe('advice that cannot leave a store overdue', () => {
  it('caps the advised gap so every source fits the active window', () => {
    // 6 h window, 5 sources: 80 % of 6 h over 5 is 57.6 min.
    expect(
      maxAdvisedGapMs({
        activeWindowMs: 6 * HOUR,
        sourceCount: 5,
        floorMs: 60_000,
      }),
    ).toBe(Math.round((6 * HOUR * 0.8) / 5))
    expect(
      maxAdvisedGapMs({ activeWindowMs: 6 * HOUR, sourceCount: 0, floorMs: 1 }),
    ).toBe(MAX_MIN_GAP_MS)
    // Never below the store's floor.
    expect(
      maxAdvisedGapMs({
        activeWindowMs: HOUR,
        sourceCount: 500,
        floorMs: 60_000,
      }),
    ).toBe(60_000)

    const capped = clampAdvice(
      {
        stores: [
          {
            store: 'vosteed.com',
            minGapSeconds: 7200,
            cooldownMinutes: null,
            quietHours: null,
            strategy: null,
            reason: 'slow down',
          },
        ],
      },
      {
        lanes: new Map([
          ['vosteed.com', { floorMs: 60_000, maxGapMs: 57.6 * MIN }],
        ]),
        now: NOW,
      },
    )
    expect(capped.lanes[0]).toMatchObject({
      minGapMs: 57.6 * MIN,
      adjustments: ['gap capped so every source fits the check interval'],
    })
  })

  it('caps advice already stored when it is applied', () => {
    const applied = applyAdviceToLane(
      lane(),
      advice({ minGapMs: 2 * HOUR }),
      NOW,
      57.6 * MIN,
    )
    expect(applied.minGapMs).toBe(57.6 * MIN)
    // The store's own adaptive gap is never capped.
    expect(
      applyAdviceToLane(
        lane({ minGapMs: 3 * HOUR }),
        advice({ minGapMs: 2 * HOUR }),
        NOW,
        57.6 * MIN,
      ).minGapMs,
    ).toBe(3 * HOUR)
  })

  it('drops throttling for a store whose recent checks came through', () => {
    const stats = {
      circuit: 'closed' as const,
      recent: {
        checks: 5,
        answered: 5,
        blocked: 0,
        failed: 0,
        lastOutcomes: ['ok'],
      },
    }
    expect(recentlyHealthy(stats)).toBe(true)
    expect(
      recentlyHealthy({ ...stats, recent: { ...stats.recent, answered: 4 } }),
    ).toBe(false)
    expect(
      recentlyHealthy({
        ...stats,
        recent: { ...stats.recent, checks: 1, answered: 1 },
      }),
    ).toBe(false)
    expect(recentlyHealthy({ ...stats, circuit: 'open' })).toBe(false)

    const result = clampAdvice(
      {
        stores: [
          {
            store: 'vosteed.com',
            minGapSeconds: 7200,
            cooldownMinutes: 120,
            quietHours: { start: 21, end: 1 },
            strategy: 'browser_first',
            reason: 'Bot checks last week.',
          },
          {
            store: 'amazon',
            minGapSeconds: 7200,
            cooldownMinutes: null,
            quietHours: null,
            strategy: null,
            reason: 'Bot checks last week.',
          },
        ],
      },
      {
        lanes: new Map([
          ['vosteed.com', { floorMs: 60_000, recentOk: true }],
          ['amazon', { floorMs: 60_000, recentOk: true }],
        ]),
        now: NOW,
      },
    )
    // The browser pin stays; the slow-down, pause and quiet hours do not,
    // and a store with nothing left is left out.
    expect(result.lanes).toEqual([
      expect.objectContaining({
        laneKey: 'vosteed.com',
        minGapMs: null,
        pauseUntil: null,
        quietHours: null,
        strategy: 'browser_first',
      }),
    ])
  })
})

describe('advisorDue: stale blocks and failures', () => {
  const blocked = lane({
    laneKey: 'sogknives.com',
    openCount: 6,
    circuit: 'open',
    cooldownUntil: NOW + 12 * HOUR,
    lastRequestAt: NOW - 8 * HOUR,
  })

  it('skips stores without active sources', () => {
    const leftover = { ...blocked, laneKey: 'knifecenter.com' }
    expect(
      advisorDue({
        lastRunAt: NOW - 10 * HOUR,
        lanes: [leftover],
        activeLanes: new Set(['vosteed.com']),
        now: NOW,
      }),
    ).toBeNull()
  })

  it('does not run again for blocks it already saw', () => {
    // Waiting out its cooldown since before the last run: nothing new.
    expect(
      advisorDue({ lastRunAt: NOW - 7 * HOUR, lanes: [blocked], now: NOW }),
    ).toBeNull()
    // Its probe was blocked again after the last run.
    expect(
      advisorDue({
        lastRunAt: NOW - 9 * HOUR,
        lanes: [blocked],
        activeLanes: new Set(['sogknives.com']),
        now: NOW,
      }),
    ).toBe('repeated_blocks')
  })

  it('backs off after failed runs', () => {
    expect(advisorBackoffMs(6 * HOUR, 0)).toBe(6 * HOUR)
    expect(advisorBackoffMs(6 * HOUR, 1)).toBe(6 * HOUR)
    expect(advisorBackoffMs(6 * HOUR, 2)).toBe(12 * HOUR)
    expect(advisorBackoffMs(6 * HOUR, 9)).toBe(ADVISOR_MAX_BACKOFF_MS)
    const fresh = { ...blocked, lastRequestAt: NOW - HOUR }
    // One failure: the regular 6 hours, never 17 minutes.
    expect(
      advisorDue({
        lastRunAt: NOW - 17 * MIN,
        lanes: [fresh],
        failures: 1,
        now: NOW,
      }),
    ).toBeNull()
    // Two failures in a row: 12 hours.
    expect(
      advisorDue({
        lastRunAt: NOW - 7 * HOUR,
        lanes: [fresh],
        failures: 2,
        now: NOW,
      }),
    ).toBeNull()
    expect(
      advisorDue({
        lastRunAt: NOW - 13 * HOUR,
        lanes: [fresh],
        failures: 2,
        now: NOW,
      }),
    ).toBe('repeated_blocks')
    expect(
      advisorDue({ lastRunAt: NOW - DAY, lanes: [], failures: 2, now: NOW }),
    ).toBeNull()
    expect(
      advisorDue({
        lastRunAt: NOW - 2 * DAY,
        lanes: [],
        failures: 2,
        now: NOW,
      }),
    ).toBe('daily')
  })
})
