import { describe, expect, it } from 'vitest'
import { nextCheckAfterFailure, retryAfterMs } from '@/lib/price-monitor/engine'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 10, 18, 12)
const after = (iso: string) => Date.parse(iso) - NOW

describe('nextCheckAfterFailure', () => {
  it('retries network trouble after 10 minutes, then an hour, then backs off', () => {
    const next = (failures: number) =>
      after(
        nextCheckAfterFailure({
          failures,
          retryable: true,
          intervalMs: DAY,
          now: NOW,
        }),
      )
    expect(next(1)).toBe(10 * MIN)
    expect(next(2)).toBe(HOUR)
    expect(next(3)).toBe(DAY)
    expect(next(4)).toBe(2 * DAY)
    expect(next(10)).toBe(7 * DAY)
  })

  it('backs off other failures from the frequency, up to 7 days', () => {
    const next = (failures: number) =>
      after(
        nextCheckAfterFailure({
          failures,
          retryable: false,
          intervalMs: 12 * HOUR,
          now: NOW,
        }),
      )
    expect(next(1)).toBe(12 * HOUR)
    expect(next(2)).toBe(DAY)
    expect(next(9)).toBe(7 * DAY)
  })
})

describe('retryAfterMs', () => {
  it('reads seconds and HTTP dates', () => {
    expect(retryAfterMs({ retryAfter: '120' }, NOW)).toBe(120_000)
    expect(
      retryAfterMs({ retryAfter: new Date(NOW + 5 * MIN).toUTCString() }, NOW),
    ).toBe(5 * MIN)
    expect(retryAfterMs({ retryAfter: null }, NOW)).toBeNull()
    expect(retryAfterMs(new Error('x'), NOW)).toBeNull()
  })
})
