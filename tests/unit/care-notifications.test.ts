import { describe, expect, it } from 'vitest'
import {
  applyCareNotificationAction,
  getCareNotificationBox,
  isCareNotificationUnread,
  localDateAfter,
  mergeCareNotificationChanges,
  parseCareNotificationAction,
  reconcileCareNotifications,
  sortCareNotifications,
  type CareNotification,
} from '@/lib/care-notifications'
import { getCareStatuses, type LatestByType } from '@/lib/maintenance-due'
import { DEFAULT_MAINTENANCE_REMINDERS } from '@/lib/settings-shared'

const now = new Date(2026, 10, 17, 9)
const daysAgo = (days: number, from = now) => {
  const date = new Date(from)
  date.setDate(date.getDate() - days)
  return date.toISOString()
}
const later = (days: number) => new Date(now.getTime() + days * 86_400_000)

function statusesFor(
  latest: Record<string, LatestByType>,
  at: Date = now,
  knives = Object.keys(latest).map((id) => ({ id })),
) {
  return getCareStatuses(
    knives,
    new Map(Object.entries(latest)),
    DEFAULT_MAINTENANCE_REMINDERS,
    {},
    at,
  )
}

/** Runs a sync the way storage does and returns the stored list. */
function sync(
  list: CareNotification[],
  latest: Record<string, LatestByType>,
  at: Date = now,
) {
  return mergeCareNotificationChanges(
    list,
    reconcileCareNotifications(list, statusesFor(latest, at), at),
    new Set(Object.keys(latest)),
  )
}

describe('care inbox sync', () => {
  it('creates one message per due track and never for missing care', () => {
    const list = sync([], {
      // Sharpening 80 days ago: due in 10 days. Cleaning 70 days ago: overdue.
      bone: { sharpening: daysAgo(80), cleaning: daysAgo(70) },
      // Sharpened yesterday, never cleaned or lubed: nothing is due.
      abrams: { sharpening: daysAgo(1) },
    })
    expect(list).toHaveLength(2)
    expect(
      list.map(({ knifeId, track, level, dueOn }) => ({
        knifeId,
        track,
        level,
        dueOn,
      })),
    ).toEqual([
      {
        knifeId: 'bone',
        track: 'sharpening',
        level: 'due-soon',
        dueOn: localDateAfter(now, 10),
      },
      {
        knifeId: 'bone',
        track: 'cleaning',
        level: 'overdue',
        dueOn: localDateAfter(now, -10),
      },
    ])
    expect(list.every((row) => isCareNotificationUnread(row, now))).toBe(true)
  })

  it('does not duplicate messages when synced again', () => {
    const latest = { bone: { sharpening: daysAgo(80) } }
    const first = sync([], latest)
    const second = sync(first, latest)
    expect(second).toEqual(first)
    expect(reconcileCareNotifications(first, statusesFor(latest), now)).toEqual(
      { create: [], update: [], deleteIds: [] },
    )
  })

  it('marks a read due-soon message unread again when it turns overdue', () => {
    const latest = { bone: { sharpening: daysAgo(80) } }
    const read = mergeCareNotificationChanges(
      sync([], latest),
      {
        create: [],
        update: applyCareNotificationAction(
          sync([], latest),
          { action: 'read-all' },
          now,
        ),
        deleteIds: [],
      },
      new Set(['bone']),
    )
    expect(isCareNotificationUnread(read[0], now)).toBe(false)

    const escalated = sync(read, latest, later(12))
    expect(escalated).toHaveLength(1)
    expect(escalated[0]).toMatchObject({ level: 'overdue', readAt: null })
  })

  it('resolves a message as logged once newer care is recorded', () => {
    const before = sync([], { bone: { cleaning: daysAgo(70) } })
    const after = sync(before, { bone: { cleaning: now.toISOString() } })
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({
      resolution: 'logged',
      resolvedAt: now.toISOString(),
    })
    expect(getCareNotificationBox(after[0], now)).toBe('done')
  })

  it('clears messages that stop being due, and reopens them if due again', () => {
    const latest = { bone: { cleaning: daysAgo(70) } }
    const open = sync([], latest)
    // The knife was sold (and sold knives are skipped): nothing applies now.
    const cleared = mergeCareNotificationChanges(
      open,
      reconcileCareNotifications(open, statusesFor({}), now),
      new Set(['bone']),
    )
    expect(cleared[0]).toMatchObject({ resolution: 'cleared' })

    const reopened = sync(cleared, latest)
    expect(reopened).toHaveLength(1)
    expect(reopened[0]).toMatchObject({
      id: open[0].id,
      resolvedAt: null,
      resolution: null,
      readAt: null,
    })
  })

  it('purges closed messages after 90 days', () => {
    const before = sync([], { bone: { cleaning: daysAgo(70) } })
    const logged = sync(before, { bone: { cleaning: now.toISOString() } })
    const changes = reconcileCareNotifications(
      logged,
      statusesFor({ bone: { cleaning: now.toISOString() } }, later(91)),
      later(91),
    )
    expect(changes.deleteIds).toEqual([logged[0].id])
  })
})

describe('care inbox actions', () => {
  const list = sync([], {
    bone: { sharpening: daysAgo(80) },
    smolt: { cleaning: daysAgo(70) },
  })
  const [bone, smolt] = list

  it('snoozes a message until a later date and brings it back unread', () => {
    const [snoozed] = applyCareNotificationAction(
      list,
      { action: 'snooze', ids: [bone.id], days: 3 },
      now,
    )
    expect(getCareNotificationBox(snoozed, now)).toBe('snoozed')
    expect(isCareNotificationUnread(snoozed, now)).toBe(false)
    expect(getCareNotificationBox(snoozed, later(3))).toBe('open')
    expect(isCareNotificationUnread(snoozed, later(3))).toBe(true)

    const [shown] = applyCareNotificationAction(
      [snoozed],
      { action: 'unsnooze', ids: [bone.id] },
      now,
    )
    expect(getCareNotificationBox(shown, now)).toBe('open')
  })

  it('dismisses and restores a message', () => {
    const [dismissed] = applyCareNotificationAction(
      list,
      { action: 'dismiss', ids: [smolt.id] },
      now,
    )
    expect(getCareNotificationBox(dismissed, now)).toBe('done')
    const [restored] = applyCareNotificationAction(
      [dismissed],
      { action: 'restore', ids: [smolt.id] },
      now,
    )
    expect(getCareNotificationBox(restored, now)).toBe('open')
    expect(restored.dismissedAt).toBeNull()
  })

  it('marks only unread open messages read with read-all', () => {
    const changed = applyCareNotificationAction(
      list,
      { action: 'read-all' },
      now,
    )
    expect(changed.map((row) => row.id)).toEqual([bone.id, smolt.id])
    expect(
      applyCareNotificationAction(
        mergeCareNotificationChanges(
          list,
          { create: [], update: changed, deleteIds: [] },
          new Set(['bone', 'smolt']),
        ),
        { action: 'read-all' },
        now,
      ),
    ).toEqual([])
  })

  it('ignores actions that change nothing', () => {
    expect(
      applyCareNotificationAction(
        list,
        { action: 'restore', ids: [bone.id] },
        now,
      ),
    ).toEqual([])
    expect(
      applyCareNotificationAction(list, { action: 'read', ids: [999] }, now),
    ).toEqual([])
  })

  it('sorts open messages by deadline and done messages by closing time', () => {
    expect(sortCareNotifications(list, 'open').map((row) => row.id)).toEqual([
      smolt.id,
      bone.id,
    ])
  })
})

describe('parseCareNotificationAction', () => {
  it('accepts valid actions', () => {
    expect(parseCareNotificationAction({ action: 'read-all' })).toEqual({
      action: 'read-all',
    })
    expect(
      parseCareNotificationAction({ action: 'snooze', ids: [1, 2], days: 7 }),
    ).toEqual({ action: 'snooze', ids: [1, 2], days: 7 })
  })

  it('rejects malformed bodies', () => {
    expect(() => parseCareNotificationAction(null)).toThrow()
    expect(() => parseCareNotificationAction({ action: 'delete' })).toThrow(
      'Unknown inbox action',
    )
    expect(() =>
      parseCareNotificationAction({ action: 'read', ids: [] }),
    ).toThrow()
    expect(() =>
      parseCareNotificationAction({ action: 'read', ids: ['1'] }),
    ).toThrow()
    expect(() =>
      parseCareNotificationAction({ action: 'snooze', ids: [1], days: 0 }),
    ).toThrow()
    expect(() =>
      parseCareNotificationAction({ action: 'snooze', ids: [1], days: 1.5 }),
    ).toThrow()
  })
})
