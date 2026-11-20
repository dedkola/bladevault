import { describe, expect, it } from 'vitest'
import {
  clockTime,
  durationLabel,
  hourLabel,
  nextCheckLabel,
  percentLabel,
} from '@/components/price-drops/price-format'

const HOUR = 60 * 60 * 1000

describe('percentLabel', () => {
  it('keeps one decimal for small moves so they never read as 0%', () => {
    expect(percentLabel(0.3)).toBe('0.3%')
    expect(percentLabel(-0.26)).toBe('0.3%')
    expect(percentLabel(4.44)).toBe('4.4%')
    expect(percentLabel(0.01)).toBe('<0.1%')
    expect(percentLabel(0)).toBe('0.0%')
  })

  it('rounds larger moves to whole numbers', () => {
    expect(percentLabel(12.4)).toBe('12%')
    expect(percentLabel(-9.96)).toBe('10%')
  })
})

describe('nextCheckLabel', () => {
  const now = Date.parse('2026-11-19T12:00:00Z')
  it('reads upcoming checks as next', () => {
    expect(nextCheckLabel(new Date(now + 3 * HOUR).toISOString(), now)).toMatch(
      /^next in 3 hours$/,
    )
  })

  it('never says "next … ago" for overdue checks', () => {
    expect(nextCheckLabel(new Date(now - 5 * 60_000).toISOString(), now)).toBe(
      'due now',
    )
    expect(nextCheckLabel(new Date(now - 9 * HOUR).toISOString(), now)).toBe(
      'overdue 9 h',
    )
    expect(nextCheckLabel(new Date(now - 50 * HOUR).toISOString(), now)).toBe(
      'overdue 2 d',
    )
  })
})

describe('durationLabel', () => {
  it('uses minutes, hours, then days', () => {
    expect(durationLabel(26 * 60_000)).toBe('26 min')
    expect(durationLabel(3 * HOUR)).toBe('3 h')
    expect(durationLabel(72 * HOUR)).toBe('3 d')
  })
})

describe('clockTime', () => {
  const now = new Date(2026, 10, 19, 15, 0).getTime()

  it('shows only the time today, in the chosen hour cycle', () => {
    const iso = new Date(2026, 10, 19, 14, 5).toISOString()
    expect(clockTime(iso, 'h23', now)).toMatch(/14[:.]05/)
    expect(clockTime(iso, 'h12', now)).toMatch(/2[:.]05\s?PM/i)
  })

  it('adds the day on another day and the year in another year', () => {
    const yesterday = new Date(2026, 10, 18, 9, 30).toISOString()
    const label = clockTime(yesterday, 'h23', now)
    expect(label).toContain('18')
    expect(label).toMatch(/09[:.]30|9[:.]30/)
    expect(label).not.toContain('2026')
    expect(
      clockTime(new Date(2025, 11, 31, 9, 30).toISOString(), 'h23', now),
    ).toContain('2025')
  })
})

describe('hourLabel', () => {
  it('follows the 12/24-hour setting', () => {
    expect(hourLabel(8, 'h23')).toMatch(/08[:.]00/)
    expect(hourLabel(24, 'h23')).toMatch(/00[:.]00/)
    expect(hourLabel(20, 'h12')).toMatch(/8[:.]00\s?PM/i)
  })
})
