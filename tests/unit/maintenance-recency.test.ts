import { describe, expect, it } from 'vitest'
import { getMaintenanceRecency } from '@/lib/maintenance-recency'
import type { KnifeActivityEvent } from '@/lib/data'

describe('maintenance recency', () => {
  it('uses latest valid care, inclusive calendar-day boundaries, and each current knife once', () => {
    const now = new Date(2026, 8, 12, 12)
    const event = (knifeId: string, days: number): KnifeActivityEvent => {
      const date = new Date(now)
      date.setDate(date.getDate() - days)
      return { knifeId, type: 'maintained', occurredAt: date.toISOString() }
    }
    const groups = getMaintenanceRecency(
      ['recent', 'middle', 'old', 'none'].map((id) => ({ id })),
      [
        event('recent', 30),
        event('recent', 100),
        event('middle', 90),
        event('old', 91),
        event('deleted', 0),
        event('none', -1),
        { ...event('none', 0), type: 'updated' },
        { ...event('none', 0), occurredAt: 'invalid' },
      ],
      now,
    )
    expect(groups.map((group) => group.knifeIds)).toEqual([
      ['recent'],
      ['middle'],
      ['old'],
      ['none'],
    ])
    expect(groups.map((group) => group.percent)).toEqual([25, 25, 25, 25])
  })
  it('handles empty collections and absent history', () => {
    expect(
      getMaintenanceRecency([], [], new Date()).map((group) => group.percent),
    ).toEqual([0, 0, 0, 0])
    expect(
      getMaintenanceRecency([{ id: 'one' }], [], new Date())[3].knifeIds,
    ).toEqual(['one'])
  })
})
