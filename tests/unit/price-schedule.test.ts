import { describe, expect, it } from 'vitest'
import {
  adviceWindowMs,
  checkLoad,
  frequencyMs,
  isWithinActiveHours,
  isStaleOutOfStock,
  nextScheduledCheckAt,
  scheduledIntervalMs,
} from '@/lib/price-monitor/schedule'
import {
  DEFAULT_PRICE_MONITORING,
  normalizePriceMonitoring,
  type PriceMonitoringSettings,
} from '@/lib/settings-shared'

const HOUR = 3_600_000
const schedule = (
  patch: Partial<PriceMonitoringSettings['schedule']>,
): PriceMonitoringSettings['schedule'] => ({
  ...DEFAULT_PRICE_MONITORING.schedule,
  ...patch,
})
const at = (hour: number, minute = 0) => new Date(2026, 10, 18, hour, minute)
const roundHours = (saved: Record<string, unknown>) =>
  normalizePriceMonitoring({ schedule: saved }).schedule.intervalHours

describe('round interval', () => {
  it('starts a round every 6, 12 or 24 hours', () => {
    expect(frequencyMs(schedule({ intervalHours: 6 }))).toBe(6 * HOUR)
    expect(frequencyMs(schedule({ intervalHours: 12 }))).toBe(12 * HOUR)
    expect(frequencyMs(schedule({ intervalHours: 24 }))).toBe(24 * HOUR)
    // AI pacing advice may stretch a store over one round interval.
    expect(adviceWindowMs(schedule({ intervalHours: 6 }))).toBe(6 * HOUR)
  })

  it('maps schedules saved before rounds to the nearest interval', () => {
    expect(roundHours({ mode: 'daily' })).toBe(24)
    expect(roundHours({ mode: 'twice_daily', activeHours: [8, 22] })).toBe(12)
    expect(roundHours({ mode: 'every_12h' })).toBe(12)
    expect(roundHours({ mode: 'custom', intervalHours: 6 })).toBe(6)
    expect(roundHours({ mode: 'custom', intervalHours: 4 })).toBe(6)
    expect(roundHours({ mode: 'custom', intervalHours: 20 })).toBe(24)
    expect(roundHours({ mode: 'custom', intervalHours: 168 })).toBe(24)
    // A tie goes to the shorter interval.
    expect(roundHours({ mode: 'custom', intervalHours: 9 })).toBe(6)
    expect(roundHours({ mode: 'custom', intervalHours: 18 })).toBe(12)
    // Set times: by runs per day (3 runs: every 8 hours, nearest 6).
    expect(roundHours({ mode: 'slots', slotHours: [9, 14, 20] })).toBe(6)
    expect(roundHours({ mode: 'slots', slotHours: [9, 21] })).toBe(12)
    expect(roundHours({ mode: 'slots', slotHours: [9] })).toBe(24)
    expect(roundHours({ mode: 'slots', slotHours: [] })).toBe(24)
  })

  it('keeps a valid interval and falls back for anything else', () => {
    expect(roundHours({ intervalHours: 12 })).toBe(12)
    expect(roundHours({ intervalHours: 7 })).toBe(24)
    expect(roundHours({ mode: 'custom', intervalHours: 'x' })).toBe(24)
    const current = normalizePriceMonitoring({
      schedule: { intervalHours: 6 },
    })
    expect(
      normalizePriceMonitoring({ schedule: { intervalHours: 5 } }, current)
        .schedule.intervalHours,
    ).toBe(6)
  })

  it('makes a checked source due about one round later', () => {
    const now = Date.UTC(2026, 10, 19, 12)
    expect(
      nextScheduledCheckAt({
        schedule: schedule({ intervalHours: 6 }),
        outOfStockSince: null,
        now,
      }),
    ).toBe(now + 6 * HOUR)
    expect(
      nextScheduledCheckAt({
        schedule: schedule({ intervalHours: 6 }),
        outOfStockSince: now - 20 * 24 * HOUR,
        now,
      }),
    ).toBe(now + 24 * HOUR)
  })

  it('checks quiet hours in local time, including windows across midnight', () => {
    expect(isWithinActiveHours([8, 22], at(8))).toBe(true)
    expect(isWithinActiveHours([8, 22], at(21, 59))).toBe(true)
    expect(isWithinActiveHours([8, 22], at(22))).toBe(false)
    expect(isWithinActiveHours([22, 6], at(23))).toBe(true)
    expect(isWithinActiveHours([22, 6], at(5, 30))).toBe(true)
    expect(isWithinActiveHours([22, 6], at(12))).toBe(false)
    expect(isWithinActiveHours(null, at(3))).toBe(true)
  })
})

describe('normalizePriceMonitoring', () => {
  it('defaults to a round a day and a minute between knives', () => {
    expect(normalizePriceMonitoring(undefined)).toEqual(
      DEFAULT_PRICE_MONITORING,
    )
    expect(DEFAULT_PRICE_MONITORING).toMatchObject({
      enabled: true,
      skipSoldKnives: true,
      schedule: { intervalHours: 24, slowOutOfStock: true },
      pacing: { minGapSeconds: 60 },
      notify: {
        drop: true,
        increase: false,
        outOfStock: false,
        backInStock: true,
      },
      thresholds: { minPercent: 5 },
    })
  })

  it('clamps numbers and drops settings rounds no longer use', () => {
    expect(
      normalizePriceMonitoring({
        enabled: false,
        schedule: { mode: 'custom', intervalHours: 999, activeHours: [5, 5] },
        pacing: { minGapSeconds: 1 },
        notify: { drop: false, increase: 'yes', outOfStock: true },
        thresholds: { minPercent: 250, minAbsolute: 12.345 },
        collectionPass: { enabled: 'yes', superSalePercent: 5 },
      }),
    ).toEqual({
      enabled: false,
      skipSoldKnives: true,
      ignoreOfficialOutOfStock: false,
      scope: { kind: 'wishlist', knifeIds: [] },
      collectionPass: { enabled: false, superSalePercent: 20 },
      schedule: { intervalHours: 24, slowOutOfStock: true },
      pacing: { minGapSeconds: 30 },
      notify: {
        drop: false,
        increase: false,
        outOfStock: true,
        backInStock: true,
      },
      thresholds: { minPercent: 100, minAmount: 0, allTimeLow: false },
      ai: DEFAULT_PRICE_MONITORING.ai,
      otherStores: DEFAULT_PRICE_MONITORING.otherStores,
    })
    expect(
      normalizePriceMonitoring({
        thresholds: { minPercent: -3 },
      }).thresholds,
    ).toEqual({ minPercent: 0, minAmount: 0, allTimeLow: false })
  })

  it('keeps unspecified parts of the current settings', () => {
    const current = normalizePriceMonitoring({
      schedule: { intervalHours: 12, slowOutOfStock: false },
    })
    expect(
      normalizePriceMonitoring({ pacing: { minGapSeconds: 120 } }, current),
    ).toMatchObject({
      schedule: { intervalHours: 12, slowOutOfStock: false },
      pacing: { minGapSeconds: 120 },
    })
    const alerts = normalizePriceMonitoring(
      { notify: { increase: true }, thresholds: { minPercent: 10 } },
      current,
    )
    expect(alerts).toMatchObject({
      schedule: { intervalHours: 12, slowOutOfStock: false },
      notify: { drop: true, increase: true, backInStock: true },
      thresholds: { minPercent: 10 },
    })
    expect(
      normalizePriceMonitoring({ thresholds: { minPercent: 2.5 } }, alerts)
        .thresholds,
    ).toEqual({ minPercent: 2.5, minAmount: 0, allTimeLow: false })
  })
})

describe('long out-of-stock pages', () => {
  const DAY = 24 * HOUR
  const NOW = Date.UTC(2026, 10, 19, 12)
  const input = (patch: {
    intervalMs?: number
    outOfStockSince?: number | null
    slowOutOfStock?: boolean
  }) => ({
    intervalMs: 6 * HOUR,
    outOfStockSince: null,
    now: NOW,
    slowOutOfStock: true,
    ...patch,
  })

  it('checks a page out of stock for two weeks at most once a day', () => {
    expect(scheduledIntervalMs(input({}))).toBe(6 * HOUR)
    expect(
      scheduledIntervalMs(input({ outOfStockSince: NOW - 13 * DAY })),
    ).toBe(6 * HOUR)
    expect(
      scheduledIntervalMs(input({ outOfStockSince: NOW - 14 * DAY })),
    ).toBe(DAY)
    // A schedule already slower than daily is kept.
    expect(
      scheduledIntervalMs(
        input({ intervalMs: 2 * DAY, outOfStockSince: NOW - 30 * DAY }),
      ),
    ).toBe(2 * DAY)
    // The setting turns it off.
    expect(
      scheduledIntervalMs(
        input({ outOfStockSince: NOW - 30 * DAY, slowOutOfStock: false }),
      ),
    ).toBe(6 * HOUR)
  })

  it('counts a slowed page as part of a check per window', () => {
    expect(checkLoad(input({}))).toBe(1)
    expect(checkLoad(input({ outOfStockSince: NOW - 20 * DAY }))).toBe(0.25)
  })

  it('checks a closely watched knife at its shorter interval', () => {
    expect(scheduledIntervalMs({ ...input({}), focusIntervalMs: HOUR })).toBe(
      HOUR,
    )
    // Out of stock for weeks: the watch still wins (a restock to catch).
    expect(
      scheduledIntervalMs({
        ...input({ outOfStockSince: NOW - 30 * DAY }),
        focusIntervalMs: 2 * HOUR,
      }),
    ).toBe(2 * HOUR)
    // Never slower than the schedule, and no watch keeps the schedule.
    expect(
      scheduledIntervalMs({ ...input({}), focusIntervalMs: 12 * HOUR }),
    ).toBe(6 * HOUR)
    expect(scheduledIntervalMs({ ...input({}), focusIntervalMs: null })).toBe(
      6 * HOUR,
    )
    expect(checkLoad({ ...input({}), focusIntervalMs: 2 * HOUR })).toBe(3)
  })

  it('suggests Pause after 60 days out of stock', () => {
    expect(isStaleOutOfStock(null, NOW)).toBe(false)
    expect(isStaleOutOfStock(NOW - 59 * DAY, NOW)).toBe(false)
    expect(isStaleOutOfStock(NOW - 60 * DAY, NOW)).toBe(true)
  })
})
