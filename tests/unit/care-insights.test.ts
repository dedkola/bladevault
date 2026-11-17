import { describe, expect, it } from 'vitest'
import {
  countCareByMonth,
  listCareJobs,
  recentCareFeed,
  rhythmOutpacesInterval,
  summarizeCareTracks,
  clusterTimelinePins,
  overduePinPosition,
  type CareJob,
} from '@/lib/care-insights'
import type { MaintenanceEvent, MaintenanceType } from '@/lib/data'
import { buildLatestByKnife, getCareStatuses } from '@/lib/maintenance-due'
import {
  DEFAULT_MAINTENANCE_REMINDERS,
  type MaintenanceReminderSettings,
} from '@/lib/settings-shared'

const now = new Date(2026, 10, 17, 12)
const daysAgo = (days: number) => {
  const date = new Date(now)
  date.setDate(date.getDate() - days)
  return date.toISOString()
}
const settings: MaintenanceReminderSettings = {
  ...DEFAULT_MAINTENANCE_REMINDERS,
  intervals: { sharpening: 30, cleaning: 30, lubrication: 20 },
  dueSoonDays: 14,
  stroppingCountsAsSharpening: true,
}

let nextId = 1
function event(
  knifeId: string,
  type: MaintenanceType,
  days: number,
  extra: Partial<MaintenanceEvent> = {},
): MaintenanceEvent {
  return {
    id: nextId++,
    knifeId,
    type,
    occurredAt: daysAgo(days),
    notes: '',
    createdAt: daysAgo(days),
    ...extra,
  }
}

function statusesFor(events: MaintenanceEvent[], knifeIds: string[]) {
  return getCareStatuses(
    knifeIds.map((id) => ({ id })),
    buildLatestByKnife(
      events.map((item) => ({
        knifeId: item.knifeId,
        type: item.type,
        lastAt: item.occurredAt,
      })),
    ),
    settings,
    {},
    now,
  )
}

const events = [
  // Bone: sharpened 49 days past a 30-day interval.
  event('bone', 'sharpening', 79),
  // Porcupine: stropped recently, cleaned long ago, oiled 11 days ago.
  event('porcupine', 'sharpening', 20),
  event('porcupine', 'stropping', 14, { notes: 'change angle to 17' }),
  event('porcupine', 'sharpening', 14, {
    sharpeningDetails: { angle: '17' },
  }),
  event('porcupine', 'cleaning', 74),
  event('porcupine', 'lubrication', 11),
  event('porcupine', 'lubrication', 41),
  event('porcupine', 'lubrication', 71),
  event('porcupine', 'lubrication', 101),
  event('porcupine', 'disassembly', 74),
  // Begleiter: sharpened 14 days ago, the same day as Porcupine.
  event('begleiter', 'sharpening', 14),
]
const newestFirst = [...events].sort((left, right) =>
  right.occurredAt.localeCompare(left.occurredAt),
)
const statuses = statusesFor(events, ['bone', 'porcupine', 'begleiter', 'new'])

describe('care insights', () => {
  it('lists every kind of care with a deadline, most urgent first', () => {
    const jobs = listCareJobs(statuses, now)
    expect(
      jobs.map((job) => `${job.knifeId}:${job.track}:${job.dueInDays}`),
    ).toEqual([
      'bone:sharpening:-49',
      'porcupine:cleaning:-44',
      'porcupine:lubrication:9',
      'begleiter:sharpening:16',
      'porcupine:sharpening:16',
    ])
    expect(jobs[2].dueOn).toBe('2026-11-26')
    // A knife with nothing logged has no jobs.
    expect(jobs.some((job) => job.knifeId === 'new')).toBe(false)
  })

  it('summarizes each kind of care', () => {
    const [sharpening, cleaning, lubrication] = summarizeCareTracks(
      statuses,
      events,
      settings,
      now,
    )
    expect(sharpening).toMatchObject({
      track: 'sharpening',
      intervalDays: 30,
      tracked: 3,
      counts: { overdue: 1, 'due-soon': 0, ok: 2 },
      mostOverdue: { knifeId: 'bone', dueInDays: -49 },
      nextDue: {
        dueOn: '2026-12-03',
        dueInDays: 16,
        knifeIds: ['begleiter', 'porcupine'],
      },
    })
    expect(cleaning.counts).toEqual({ overdue: 1, 'due-soon': 0, ok: 0 })
    expect(cleaning.nextDue).toBeNull()
    expect(lubrication).toMatchObject({
      counts: { overdue: 0, 'due-soon': 1, ok: 0 },
      lastDone: { knifeId: 'porcupine' },
      rhythmDays: 30,
      rhythmSamples: 3,
    })
  })

  it('counts stropping toward the sharpening rhythm, once per day', () => {
    const [sharpening] = summarizeCareTracks(statuses, events, settings, now)
    // Porcupine: day -20 and day -14 (sharpen + strop the same day) = one gap.
    expect(sharpening.rhythmDays).toBe(6)
    expect(sharpening.rhythmSamples).toBe(1)
  })

  it('flags an interval shorter than your usual rhythm', () => {
    const [sharpening, , lubrication] = summarizeCareTracks(
      statuses,
      events,
      settings,
      now,
    )
    expect(rhythmOutpacesInterval(lubrication)).toBe(true)
    expect(rhythmOutpacesInterval(sharpening)).toBe(false)
    expect(rhythmOutpacesInterval({ ...lubrication, intervalDays: 28 })).toBe(
      false,
    )
    expect(rhythmOutpacesInterval({ ...lubrication, rhythmSamples: 2 })).toBe(
      false,
    )
  })

  it('leaves out a kind switched off with nothing due', () => {
    const off = {
      ...settings,
      intervals: { ...settings.intervals, cleaning: null },
    }
    const offStatuses = getCareStatuses(
      [{ id: 'bone' }],
      buildLatestByKnife([
        { knifeId: 'bone', type: 'cleaning', lastAt: daysAgo(5) },
      ]),
      off,
      {},
      now,
    )
    expect(
      summarizeCareTracks(offStatuses, [], off, now).map((item) => item.track),
    ).toEqual(['sharpening', 'lubrication'])
  })

  it('counts entries per month by kind', () => {
    const months = countCareByMonth(events, now, 4)
    expect(months.map((month) => month.month)).toEqual([
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
    ])
    const november = months[3]
    expect(november.total).toBe(4)
    expect(november.counts).toEqual({
      sharpening: 3,
      cleaning: 0,
      lubrication: 1,
      other: 0,
    })
    expect(months[1].counts.other).toBe(1)
  })

  it('merges same-day entries on one knife in the recent feed', () => {
    const feed = recentCareFeed(newestFirst, 3)
    expect(feed).toHaveLength(3)
    expect(feed[0]).toMatchObject({
      knifeId: 'porcupine',
      types: ['lubrication'],
    })
    const sharpened = feed.find(
      (item) => item.knifeId === 'porcupine' && item.types.length > 1,
    )
    expect(sharpened?.types).toEqual(['sharpening', 'stropping'])
    expect(sharpened).toMatchObject({
      notes: ['change angle to 17'],
      angle: '17',
    })
  })
})

describe('Coming up timeline pins', () => {
  const job = (
    knifeId: string,
    dueInDays: number,
    level: CareJob['level'],
  ): CareJob => ({
    knifeId,
    track: 'cleaning',
    dueInDays,
    dueOn: '2026-11-17',
    level,
    intervalDays: 30,
    lastAt: daysAgo(30 - dueInDays),
  })

  it('merges nearby jobs and keeps distant ones apart', () => {
    const jobs = [
      job('banter', -49, 'overdue'),
      job('purest', -47, 'overdue'),
      job('porcupine', -44, 'overdue'),
      job('raccoon', -2, 'overdue'),
      job('porcupine-2', -2, 'overdue'),
    ]
    const pins = clusterTimelinePins(
      jobs,
      (item) => overduePinPosition(-item.dueInDays, 59),
      24,
    )
    expect(pins.map((pin) => pin.jobs.map((item) => item.knifeId))).toEqual([
      ['banter', 'purest', 'porcupine'],
      ['porcupine-2', 'raccoon'],
    ])
    // Most overdue sits furthest left.
    expect(pins[0].position).toBeLessThan(pins[1].position)
  })

  it('colours a merged pin by its most urgent job', () => {
    const [pin] = clusterTimelinePins(
      [job('a', 15, 'ok'), job('b', 14, 'due-soon')],
      (item) => (item.dueInDays / 30) * 100,
      14,
    )
    expect(pin.jobs).toHaveLength(2)
    expect(pin.level).toBe('due-soon')
  })

  it('places overdue pins on a shared scale', () => {
    expect(overduePinPosition(59, 59)).toBe(8)
    expect(overduePinPosition(0, 59)).toBe(92)
    expect(overduePinPosition(5, 0)).toBe(50)
  })
})
