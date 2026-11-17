import { CARE_TRACKS, type CareTrack } from '@/lib/settings-shared'
import type { KnifeCareStatus } from '@/lib/maintenance-due'

export type CareNotificationLevel = 'due-soon' | 'overdue'
export type CareNotificationResolution = 'logged' | 'cleared'
export type CareNotificationBox = 'open' | 'snoozed' | 'done'

/**
 * One message per knife, kind of care and care cycle. `lastAt` is the care
 * entry the cycle started from, so logging that care starts a new cycle.
 */
export type CareNotification = {
  id: number
  knifeId: string
  track: CareTrack
  lastAt: string
  /** Local calendar date of the deadline, YYYY-MM-DD. */
  dueOn: string
  level: CareNotificationLevel
  createdAt: string
  updatedAt: string
  readAt: string | null
  snoozedUntil: string | null
  dismissedAt: string | null
  resolvedAt: string | null
  /** `logged` when newer care was recorded, `cleared` when it stopped being due. */
  resolution: CareNotificationResolution | null
}

export type NewCareNotification = Omit<CareNotification, 'id'>

export type CareNotificationChanges = {
  create: NewCareNotification[]
  update: CareNotification[]
  deleteIds: number[]
}

export const CARE_NOTIFICATION_RETENTION_DAYS = 90
export const CARE_SNOOZE_MAX_DAYS = 365
export const CARE_SNOOZE_OPTIONS: readonly { days: number; label: string }[] = [
  { days: 1, label: 'Tomorrow' },
  { days: 3, label: '3 days' },
  { days: 7, label: '1 week' },
  { days: 30, label: '1 month' },
]

export type CareNotificationAction =
  | {
      action: 'read' | 'dismiss' | 'restore' | 'unsnooze'
      ids: number[]
    }
  | { action: 'snooze'; ids: number[]; days: number }
  | { action: 'read-all' }

const DAY_MS = 86_400_000

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Local calendar date `days` after `now`, as YYYY-MM-DD. */
export function localDateAfter(now: Date, days: number): string {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function notificationKey(knifeId: string, track: string, lastAt: string) {
  return `${knifeId}\u0000${track}\u0000${lastAt}`
}

function isLaterDate(candidate: string | null | undefined, than: string) {
  if (!candidate) return false
  const a = Date.parse(candidate)
  const b = Date.parse(than)
  return Number.isFinite(a) && Number.isFinite(b) ? a > b : candidate > than
}

export function getCareNotificationBox(
  notification: CareNotification,
  now: Date,
): CareNotificationBox {
  if (notification.resolvedAt || notification.dismissedAt) return 'done'
  if (
    notification.snoozedUntil &&
    Date.parse(notification.snoozedUntil) > now.getTime()
  ) {
    return 'snoozed'
  }
  return 'open'
}

export function isCareNotificationUnread(
  notification: CareNotification,
  now: Date,
): boolean {
  return (
    getCareNotificationBox(notification, now) === 'open' && !notification.readAt
  )
}

/**
 * Works out which stored messages to create, update or delete so the inbox
 * matches the current care status. Only due-soon and overdue tracks with a
 * logged entry produce messages; a track that was never logged never does.
 */
export function reconcileCareNotifications(
  existing: readonly CareNotification[],
  statuses: ReadonlyMap<string, KnifeCareStatus>,
  now: Date,
): CareNotificationChanges {
  const nowIso = now.toISOString()
  const byKey = new Map(
    existing.map((row) => [
      notificationKey(row.knifeId, row.track, row.lastAt),
      row,
    ]),
  )
  const seen = new Set<string>()
  const create: NewCareNotification[] = []
  const update: CareNotification[] = []

  for (const status of statuses.values()) {
    for (const track of status.tracks) {
      if (
        (track.level !== 'due-soon' && track.level !== 'overdue') ||
        !track.lastAt ||
        track.dueInDays === null
      ) {
        continue
      }
      const key = notificationKey(status.knifeId, track.track, track.lastAt)
      seen.add(key)
      const dueOn = localDateAfter(now, track.dueInDays)
      const row = byKey.get(key)
      if (!row) {
        create.push({
          knifeId: status.knifeId,
          track: track.track,
          lastAt: track.lastAt,
          dueOn,
          level: track.level,
          createdAt: nowIso,
          updatedAt: nowIso,
          readAt: null,
          snoozedUntil: null,
          dismissedAt: null,
          resolvedAt: null,
          resolution: null,
        })
        continue
      }
      if (row.resolvedAt) {
        // Due again in the same cycle, e.g. after an interval was shortened.
        if (row.resolution === 'cleared') {
          update.push({
            ...row,
            level: track.level,
            dueOn,
            readAt: null,
            resolvedAt: null,
            resolution: null,
            updatedAt: nowIso,
          })
        }
        continue
      }
      if (row.level !== track.level || row.dueOn !== dueOn) {
        const escalated = row.level === 'due-soon' && track.level === 'overdue'
        update.push({
          ...row,
          level: track.level,
          dueOn,
          readAt: escalated ? null : row.readAt,
          updatedAt: nowIso,
        })
      }
    }
  }

  const purgeBefore = now.getTime() - CARE_NOTIFICATION_RETENTION_DAYS * DAY_MS
  const deleteIds: number[] = []
  for (const row of existing) {
    if (row.resolvedAt) {
      if (Date.parse(row.resolvedAt) < purgeBefore) deleteIds.push(row.id)
      continue
    }
    if (seen.has(notificationKey(row.knifeId, row.track, row.lastAt))) continue
    const latest = statuses
      .get(row.knifeId)
      ?.tracks.find((track) => track.track === row.track)?.lastAt
    update.push({
      ...row,
      resolvedAt: nowIso,
      resolution: isLaterDate(latest, row.lastAt) ? 'logged' : 'cleared',
      updatedAt: nowIso,
    })
  }

  return { create, update, deleteIds }
}

/**
 * Applies planned changes to an in-memory list (the static build's store),
 * mirroring SQLite: new ids, one message per cycle, existing knives only.
 */
export function mergeCareNotificationChanges(
  list: readonly CareNotification[],
  changes: CareNotificationChanges,
  knifeIds: ReadonlySet<string>,
): CareNotification[] {
  const deleted = new Set(changes.deleteIds)
  const updated = new Map(changes.update.map((row) => [row.id, row]))
  const result = list
    .filter((row) => !deleted.has(row.id))
    .map((row) => updated.get(row.id) ?? row)
  const keys = new Set(
    result.map((row) => notificationKey(row.knifeId, row.track, row.lastAt)),
  )
  let nextId = list.reduce((max, row) => Math.max(max, row.id), 0) + 1
  for (const row of changes.create) {
    const key = notificationKey(row.knifeId, row.track, row.lastAt)
    if (!knifeIds.has(row.knifeId) || keys.has(key)) continue
    keys.add(key)
    result.push({ ...row, id: nextId++ })
  }
  return result
}

/** Returns the messages an inbox action changes, already updated. */
export function applyCareNotificationAction(
  existing: readonly CareNotification[],
  request: CareNotificationAction,
  now: Date,
): CareNotification[] {
  const nowIso = now.toISOString()
  if (request.action === 'read-all') {
    return existing
      .filter((row) => isCareNotificationUnread(row, now))
      .map((row) => ({ ...row, readAt: nowIso, updatedAt: nowIso }))
  }
  const ids = new Set(request.ids)
  const changed: CareNotification[] = []
  for (const row of existing) {
    if (!ids.has(row.id)) continue
    let next: CareNotification = row
    switch (request.action) {
      case 'read':
        if (!row.readAt) next = { ...row, readAt: nowIso }
        break
      case 'dismiss':
        if (!row.resolvedAt && !row.dismissedAt)
          next = { ...row, dismissedAt: nowIso, readAt: row.readAt ?? nowIso }
        break
      case 'restore':
        if (!row.resolvedAt && row.dismissedAt)
          next = { ...row, dismissedAt: null, readAt: null, snoozedUntil: null }
        break
      case 'snooze':
        if (!row.resolvedAt && !row.dismissedAt)
          next = {
            ...row,
            snoozedUntil: new Date(
              now.getTime() + request.days * DAY_MS,
            ).toISOString(),
            // A snoozed message comes back unread.
            readAt: null,
          }
        break
      case 'unsnooze':
        if (row.snoozedUntil)
          next = { ...row, snoozedUntil: null, readAt: null }
        break
    }
    if (next !== row) changed.push({ ...next, updatedAt: nowIso })
  }
  return changed
}

function parseIds(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 1000 ||
    !value.every((id) => Number.isSafeInteger(id) && id > 0)
  ) {
    throw new Error('ids must be a non-empty list of message ids')
  }
  return value as number[]
}

/** Validates a PATCH body for the care inbox. */
export function parseCareNotificationAction(
  body: unknown,
): CareNotificationAction {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Request body must be an object')
  }
  const { action, ids, days } = body as Record<string, unknown>
  switch (action) {
    case 'read-all':
      return { action }
    case 'read':
    case 'dismiss':
    case 'restore':
    case 'unsnooze':
      return { action, ids: parseIds(ids) }
    case 'snooze':
      if (
        !Number.isSafeInteger(days) ||
        (days as number) < 1 ||
        (days as number) > CARE_SNOOZE_MAX_DAYS
      ) {
        throw new Error(
          `days must be a whole number from 1 to ${CARE_SNOOZE_MAX_DAYS}`,
        )
      }
      return { action, ids: parseIds(ids), days: days as number }
    default:
      throw new Error('Unknown inbox action')
  }
}

/**
 * Open and snoozed messages: earliest deadline first, so the most overdue
 * knife leads. Done messages: most recently closed first.
 */
export function sortCareNotifications(
  list: readonly CareNotification[],
  box: CareNotificationBox,
): CareNotification[] {
  if (box === 'done') {
    const closedAt = (row: CareNotification) =>
      row.resolvedAt ?? row.dismissedAt ?? row.updatedAt
    return [...list].sort(
      (left, right) =>
        closedAt(right).localeCompare(closedAt(left)) || right.id - left.id,
    )
  }
  return [...list].sort(
    (left, right) =>
      left.dueOn.localeCompare(right.dueOn) || left.id - right.id,
  )
}

export function isCareTrack(value: unknown): value is CareTrack {
  return (CARE_TRACKS as readonly unknown[]).includes(value)
}
