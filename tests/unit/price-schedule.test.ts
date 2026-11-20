import { describe, expect, it } from 'vitest'
import {
  activeHoursPerDay,
  activeWindowMs,
  checkLoad,
  effectiveActiveHours,
  frequencyMs,
  isWithinActiveHours,
  isStaleOutOfStock,
  msUntilActive,
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

describe('frequency and active hours', () => {
  it('maps schedule modes to a frequency window', () => {
    expect(frequencyMs(schedule({ mode: 'daily' }))).toBe(24 * HOUR)
    expect(frequencyMs(schedule({ mode: 'twice_daily' }))).toBe(12 * HOUR)
    expect(frequencyMs(schedule({ mode: 'every_12h' }))).toBe(12 * HOUR)
    expect(frequencyMs(schedule({ mode: 'custom', intervalHours: 6 }))).toBe(
      6 * HOUR,
    )
  })

  it('runs twice daily in daytime and every 12 hours around the clock', () => {
    expect(effectiveActiveHours(schedule({ mode: 'twice_daily' }))).toEqual([
      8, 22,
    ])
    expect(
      effectiveActiveHours(
        schedule({ mode: 'every_12h', activeHours: [9, 17] }),
      ),
    ).toBeNull()
    expect(
      effectiveActiveHours(schedule({ mode: 'daily', activeHours: [9, 17] })),
    ).toEqual([9, 17])
  })

  it('checks hours in local time, including windows across midnight', () => {
    expect(isWithinActiveHours([8, 22], at(8))).toBe(true)
    expect(isWithinActiveHours([8, 22], at(21, 59))).toBe(true)
    expect(isWithinActiveHours([8, 22], at(22))).toBe(false)
    expect(isWithinActiveHours([22, 6], at(23))).toBe(true)
    expect(isWithinActiveHours([22, 6], at(5, 30))).toBe(true)
    expect(isWithinActiveHours([22, 6], at(12))).toBe(false)
    expect(isWithinActiveHours(null, at(3))).toBe(true)
  })

  it('sizes the active window used to spread checks', () => {
    expect(activeHoursPerDay([8, 22])).toBe(14)
    expect(activeHoursPerDay([22, 6])).toBe(8)
    expect(activeWindowMs(schedule({ mode: 'daily' }))).toBe(24 * HOUR)
    expect(activeWindowMs(schedule({ mode: 'twice_daily' }))).toBe(7 * HOUR)
  })

  it('waits until the next active start', () => {
    expect(msUntilActive([8, 22], at(10))).toBe(0)
    expect(msUntilActive([8, 22], at(6))).toBe(2 * HOUR)
    expect(msUntilActive([8, 22], at(23))).toBe(9 * HOUR)
  })
})

describe('normalizePriceMonitoring', () => {
  it('defaults to daily checks for knives with a price', () => {
    expect(normalizePriceMonitoring(undefined)).toEqual(
      DEFAULT_PRICE_MONITORING,
    )
    expect(DEFAULT_PRICE_MONITORING).toMatchObject({
      enabled: true,
      skipSoldKnives: true,
      pacing: { minGapSeconds: 60, amazonMinGapSeconds: 300 },
      notify: {
        drop: true,
        increase: false,
        outOfStock: false,
        backInStock: true,
      },
      thresholds: { minPercent: 5 },
    })
  })

  it('clamps numbers and rejects invalid hours', () => {
    expect(
      normalizePriceMonitoring({
        enabled: false,
        schedule: { mode: 'custom', intervalHours: 999, activeHours: [5, 5] },
        pacing: {
          minGapSeconds: 1,
          amazonMinGapSeconds: 'x',
        },
        notify: { drop: false, increase: 'yes', outOfStock: true },
        thresholds: { minPercent: 250, minAbsolute: 12.345 },
      }),
    ).toEqual({
      enabled: false,
      skipSoldKnives: true,
      ignoreOfficialOutOfStock: false,
      schedule: {
        mode: 'custom',
        intervalHours: 168,
        activeHours: null,
        slowOutOfStock: true,
      },
      pacing: {
        minGapSeconds: 30,
        amazonMinGapSeconds: 300,
      },
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
      schedule: { mode: 'twice_daily', activeHours: [7, 23] },
    })
    expect(
      normalizePriceMonitoring({ pacing: { minGapSeconds: 120 } }, current),
    ).toMatchObject({
      schedule: { mode: 'twice_daily', activeHours: [7, 23] },
      pacing: { minGapSeconds: 120, amazonMinGapSeconds: 300 },
    })
    const alerts = normalizePriceMonitoring(
      { notify: { increase: true }, thresholds: { minPercent: 10 } },
      current,
    )
    expect(alerts).toMatchObject({
      schedule: { mode: 'twice_daily', activeHours: [7, 23] },
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
