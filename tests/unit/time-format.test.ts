import { describe, expect, it } from 'vitest'
import { getHourCycle } from '@/lib/time-format'

describe('time format', () => {
  it('maps saved preferences to explicit Intl hour cycles', () => {
    expect(getHourCycle('12h')).toBe('h12')
    expect(getHourCycle('24h')).toBe('h23')
  })
})
