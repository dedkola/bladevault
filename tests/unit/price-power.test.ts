import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CLOCK_JUMP_MS,
  OUTAGE_HOLD_MS,
  OUTAGE_WINDOW_MS,
  RESUME_WARMUP_MS,
  checkClockJump,
  clockMark,
  isLocalOutage,
  monitorHoldMs,
  noteAiNetworkFailure,
  noteNetworkFailure,
  noteNetworkSuccess,
  notePowerResume,
  notePowerSuspend,
  powerSignal,
  resetPowerState,
  sleptSince,
} from '@/lib/price-monitor/power'

const NOW = Date.UTC(2026, 10, 21, 3, 51)

beforeEach(() => resetPowerState({ settleMs: 0 }))
afterEach(() => resetPowerState())

describe('sleep and wake', () => {
  it('aborts the power signal on suspend and holds work until the warmup ends', () => {
    const signal = powerSignal()
    notePowerSuspend(NOW)
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toMatchObject({ name: 'PowerSuspendError' })
    expect(powerSignal().aborted).toBe(false)
    expect(monitorHoldMs(NOW + 60_000)).toBeGreaterThan(0)

    notePowerResume(NOW + 3_600_000)
    expect(monitorHoldMs(NOW + 3_600_000)).toBe(RESUME_WARMUP_MS)
    expect(monitorHoldMs(NOW + 3_600_000 + RESUME_WARMUP_MS)).toBe(0)
  })

  it('stops holding after a suspend whose resume notice never came', () => {
    notePowerSuspend(NOW)
    const later = NOW + 11 * 60_000
    expect(monitorHoldMs(later)).toBe(RESUME_WARMUP_MS)
    expect(monitorHoldMs(later + RESUME_WARMUP_MS)).toBe(0)
  })

  it('treats a wall-clock jump the monotonic clock missed as a sleep', () => {
    const mark = clockMark()
    const awake = { wall: mark.wall + 10_000, mono: mark.mono + 10_000 }
    expect(sleptSince(mark, awake)).toBe(false)
    const slept = {
      wall: mark.wall + 400_000,
      mono: mark.mono + 400_000 - CLOCK_JUMP_MS - 1,
    }
    expect(sleptSince(mark, slept)).toBe(true)
  })

  it('counts a reported suspend during the call as a sleep', () => {
    const mark = clockMark()
    notePowerSuspend()
    notePowerResume()
    expect(sleptSince(mark)).toBe(true)
  })

  it('starts a warmup when the watchdog sees a clock jump', () => {
    const signal = powerSignal()
    const start = clockMark()
    expect(
      checkClockJump({ wall: start.wall + 15_000, mono: start.mono + 15_000 }),
    ).toBe(false)
    expect(
      checkClockJump({ wall: start.wall + 900_000, mono: start.mono + 30_000 }),
    ).toBe(true)
    expect(signal.aborted).toBe(true)
    expect(monitorHoldMs()).toBeGreaterThan(RESUME_WARMUP_MS - 5_000)
  })
})

describe('local network outages', () => {
  it('blames the store when only one store fails', () => {
    noteNetworkFailure('bokerusa.com', NOW)
    expect(isLocalOutage('bokerusa.com', NOW)).toBe(false)
    expect(monitorHoldMs(NOW)).toBe(0)
  })

  it('sees an outage when several stores fail together and holds checks', () => {
    noteNetworkFailure('bokerusa.com', NOW)
    noteNetworkFailure('vosteed.com', NOW)
    expect(isLocalOutage('vosteed.com', NOW)).toBe(true)
    expect(isLocalOutage('bokerusa.com', NOW)).toBe(true)
    expect(monitorHoldMs(NOW)).toBe(OUTAGE_HOLD_MS)
  })

  it('ignores another store failure outside the window', () => {
    noteNetworkFailure('bokerusa.com', NOW - OUTAGE_WINDOW_MS - 1)
    noteNetworkFailure('vosteed.com', NOW)
    expect(isLocalOutage('vosteed.com', NOW)).toBe(false)
  })

  it('sees an outage when the AI host fails DNS', () => {
    noteAiNetworkFailure('Something else went wrong', NOW)
    expect(isLocalOutage('vosteed.com', NOW)).toBe(false)
    noteAiNetworkFailure('getaddrinfo ENOTFOUND opencode.ai', NOW)
    expect(isLocalOutage('vosteed.com', NOW)).toBe(true)
  })

  it('sees an outage without any network interface', () => {
    resetPowerState({ settleMs: 0, hasNetworkInterface: () => false })
    expect(isLocalOutage('vosteed.com', NOW)).toBe(true)
  })

  it('forgets the outage once a store answers', () => {
    noteNetworkFailure('bokerusa.com', NOW)
    noteNetworkFailure('vosteed.com', NOW)
    expect(isLocalOutage('vosteed.com', NOW)).toBe(true)
    noteNetworkSuccess(NOW + 1)
    expect(monitorHoldMs(NOW)).toBe(0)
    expect(isLocalOutage('vosteed.com', NOW)).toBe(false)
  })

  it('keeps failures seen after the answering check started', () => {
    noteAiNetworkFailure('getaddrinfo ENOTFOUND opencode.ai', NOW)
    noteNetworkSuccess(NOW - 1)
    expect(isLocalOutage('vosteed.com', NOW)).toBe(true)
  })
})
