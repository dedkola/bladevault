import { describe, expect, it } from 'vitest'
import {
  activeHoursPerDay,
  activeWindowMs,
  effectiveActiveHours,
  frequencyMs,
  isWithinActiveHours,
  msUntilActive,
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
      pacing: { maxParallelStores: 3 },
    })
  })

  it('clamps numbers and rejects invalid hours', () => {
    expect(
      normalizePriceMonitoring({
        enabled: false,
        schedule: { mode: 'custom', intervalHours: 999, activeHours: [5, 5] },
        pacing: {
          maxParallelStores: 9,
          minGapSeconds: 1,
          amazonMinGapSeconds: 'x',
        },
      }),
    ).toEqual({
      enabled: false,
      skipSoldKnives: true,
      schedule: { mode: 'custom', intervalHours: 168, activeHours: null },
      pacing: {
        maxParallelStores: 5,
        minGapSeconds: 30,
        amazonMinGapSeconds: 300,
      },
    })
  })

  it('keeps unspecified parts of the current settings', () => {
    const current = normalizePriceMonitoring({
      schedule: { mode: 'twice_daily', activeHours: [7, 23] },
    })
    expect(
      normalizePriceMonitoring({ pacing: { maxParallelStores: 2 } }, current),
    ).toMatchObject({
      schedule: { mode: 'twice_daily', activeHours: [7, 23] },
      pacing: { maxParallelStores: 2, minGapSeconds: 60 },
    })
  })
})
