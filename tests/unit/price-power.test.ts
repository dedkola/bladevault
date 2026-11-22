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
  parseSysctlTime,
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

describe('macOS system sleep (monotonic clock counts through sleep)', () => {
  it('reads sysctl sleep and wake times', () => {
    expect(
      parseSysctlTime(
        '{ sec = 1795334615, usec = 12720 } Sun Nov 22 10:03:35 2026',
      ),
    ).toBe(1795334615012)
    expect(parseSysctlTime('')).toBeNull()
  })

  it('counts a system sleep after the mark even when both clocks agree', () => {
    let times = { sleepAt: NOW - 3_600_000, wakeAt: NOW - 3_500_000 }
    resetPowerState({ settleMs: 0, systemSleepTimes: () => times })
    const mark = clockMark()
    // Both clocks moved 938 s together, as on macOS through a sleep.
    const after = { wall: mark.wall + 938_000, mono: mark.mono + 938_000 }
    expect(sleptSince(mark, after)).toBe(false)
    times = { sleepAt: mark.wall + 31_000, wakeAt: mark.wall + 938_000 }
    expect(sleptSince(mark, after)).toBe(true)
  })

  it('treats a new system wake as an unreported sleep, once', () => {
    let times = { sleepAt: NOW - 3_600_000, wakeAt: NOW - 3_500_000 }
    resetPowerState({ settleMs: 0, systemSleepTimes: () => times })
    const signal = powerSignal()
    const start = clockMark()
    const tick = (ms: number) =>
      checkClockJump({ wall: start.wall + ms, mono: start.mono + ms })
    expect(tick(15_000)).toBe(false)
    times = { sleepAt: start.wall + 20_000, wakeAt: start.wall + 900_000 }
    expect(tick(900_000)).toBe(true)
    expect(signal.aborted).toBe(true)
    expect(monitorHoldMs()).toBeGreaterThan(0)
    expect(tick(915_000)).toBe(false)
  })

  it('does not report a wake the desktop app already reported', () => {
    let times = { sleepAt: NOW - 3_600_000, wakeAt: NOW - 3_500_000 }
    resetPowerState({ settleMs: 0, systemSleepTimes: () => times })
    powerSignal()
    const start = clockMark()
    times = { sleepAt: start.wall + 20_000, wakeAt: start.wall + 900_000 }
    notePowerResume()
    expect(
      checkClockJump({
        wall: start.wall + 915_000,
        mono: start.mono + 915_000,
      }),
    ).toBe(false)
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
