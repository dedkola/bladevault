/**
 * Price-monitoring notifications for the Inbox **Prices** section. Pure and
 * client-safe; `store.ts` and `notification-store.ts` write the plans.
 *
 * Rules, mirroring `lib/system-messages.ts`:
 * - Notifications come only from price and stock events, and events only from
 *   changes, so an unchanged price never notifies.
 * - Each (source, kind) has at most one unresolved notification. A repeat
 *   updates it (newest event, one more occurrence, unread and back on top),
 *   even when it was dismissed.
 * - An opposite event resolves it: an increase closes a drop and the other
 *   way round; back in stock closes out of stock and the other way round.
 * - Closed notifications are deleted after 90 days.
 */
import type { ChangeEvent } from '@/lib/price-monitor/insights'
import type { PriceMonitoringSettings } from '@/lib/settings-shared'

export type PriceNotificationKind =
  'drop' | 'increase' | 'out_of_stock' | 'back_in_stock'
export type PriceNotificationBox = 'open' | 'done'

export const PRICE_NOTIFICATION_KINDS: readonly PriceNotificationKind[] = [
  'drop',
  'increase',
  'out_of_stock',
  'back_in_stock',
]
export const PRICE_NOTIFICATION_RETENTION_DAYS = 90

const DAY_MS = 86_400_000

const OPPOSITE: Record<PriceNotificationKind, PriceNotificationKind> = {
  drop: 'increase',
  increase: 'drop',
  out_of_stock: 'back_in_stock',
  back_in_stock: 'out_of_stock',
}

const CATEGORY: Record<
  PriceNotificationKind,
  keyof PriceMonitoringSettings['notify']
> = {
  drop: 'drop',
  increase: 'increase',
  out_of_stock: 'outOfStock',
  back_in_stock: 'backInStock',
}

export type PriceNotification = {
  id: number
  knifeId: string
  sourceId: number
  /** price_change_events.id for price kinds, stock_events.id for stock kinds. */
  eventId: number
  kind: PriceNotificationKind
  /** How many events of this kind arrived while it stayed unresolved. */
  occurrences: number
  /** When the latest event happened; repeats move it to the top. */
  occurredAt: string
  createdAt: string
  updatedAt: string
  readAt: string | null
  dismissedAt: string | null
  /** Set when an opposite event made it stale. */
  resolvedAt: string | null
}

/** A notification with its event: knife, store, prices and change. */
export type PriceNotificationView = PriceNotification & { event: ChangeEvent }

/** Applies action results to a loaded list, keeping each row's event. */
export function mergePriceNotificationUpdates<T extends PriceNotification>(
  list: readonly T[],
  updated: readonly PriceNotification[],
): T[] {
  const byId = new Map(updated.map((row) => [row.id, row]))
  return list.map((row) => {
    const next = byId.get(row.id)
    return next ? { ...row, ...next } : row
  })
}

/** One stored event, as the planner needs it. */
export type PriceNotificationEvent =
  | {
      kind: 'drop' | 'increase'
      eventId: number
      knifeId: string
      sourceId: number
      currency: string
      /** New price minus previous, in minor units. */
      deltaMinor: number
      /** Percent change; negative for a drop. */
      deltaPct: number
    }
  | {
      kind: 'out_of_stock' | 'back_in_stock'
      eventId: number
      knifeId: string
      sourceId: number
    }

export type PriceNotificationSettings = Pick<
  PriceMonitoringSettings,
  'notify' | 'thresholds'
> &
  Partial<Pick<PriceMonitoringSettings, 'ignoreOfficialOutOfStock'>>

export type PriceNotificationAction =
  | { action: 'read' | 'dismiss' | 'restore'; ids: number[] }
  | { action: 'read-all' }

export type PriceNotificationChanges = {
  create: Omit<PriceNotification, 'id'>[]
  update: PriceNotification[]
  deleteIds: number[]
}

export function isPriceNotificationKind(
  value: unknown,
): value is PriceNotificationKind {
  return (PRICE_NOTIFICATION_KINDS as readonly unknown[]).includes(value)
}

export function getPriceNotificationBox(
  notification: PriceNotification,
): PriceNotificationBox {
  return notification.resolvedAt || notification.dismissedAt ? 'done' : 'open'
}

export function isPriceNotificationUnread(
  notification: PriceNotification,
): boolean {
  return (
    getPriceNotificationBox(notification) === 'open' && !notification.readAt
  )
}

/** When a notification last changed in a way the reader cares about. */
export function priceNotificationTime(notification: PriceNotification): string {
  return (
    notification.resolvedAt ??
    notification.dismissedAt ??
    notification.occurredAt
  )
}

/** Newest first, by the time the reader last saw a change. */
export function sortPriceNotifications<T extends PriceNotification>(
  list: readonly T[],
): T[] {
  return [...list].sort(
    (left, right) =>
      priceNotificationTime(right).localeCompare(priceNotificationTime(left)) ||
      right.id - left.id,
  )
}

/** Closed notifications older than the retention window, ready to delete. */
export function expiredPriceNotificationIds(
  list: readonly PriceNotification[],
  now: Date,
): number[] {
  const purgeBefore = now.getTime() - PRICE_NOTIFICATION_RETENTION_DAYS * DAY_MS
  return list.flatMap((row) => {
    const closedAt = row.resolvedAt ?? row.dismissedAt
    return closedAt && Date.parse(closedAt) < purgeBefore ? [row.id] : []
  })
}

/** Whether a price change is big enough; a threshold of 0 lets every change through. */
export function meetsPriceThreshold(
  change: { deltaPct: number },
  thresholds: PriceNotificationSettings['thresholds'],
): boolean {
  return Math.abs(change.deltaPct) >= thresholds.minPercent
}

/** Whether an event's category is on and, for prices, above the threshold. */
export function shouldNotify(
  event: PriceNotificationEvent,
  settings: PriceNotificationSettings,
): boolean {
  if (!settings.notify[CATEGORY[event.kind]]) return false
  if (event.kind === 'drop' || event.kind === 'increase')
    return meetsPriceThreshold(event, settings.thresholds)
  return true
}

/**
 * Plans the notification changes for new events, in the order they were
 * stored. `existing` holds the stored rows the events may touch (at least
 * every unresolved row of their sources); expired closed rows are deleted.
 */
export function planPriceNotifications(
  events: readonly PriceNotificationEvent[],
  existing: readonly PriceNotification[],
  settings: PriceNotificationSettings,
  now: Date,
): PriceNotificationChanges {
  const nowIso = now.toISOString()
  const deleteIds = expiredPriceNotificationIds(existing, now)
  const deleted = new Set(deleteIds)
  // Working copies; ids < 0 stand for rows created by this plan.
  const rows: PriceNotification[] = existing.filter(
    (row) => !deleted.has(row.id),
  )
  const touched = new Set<number>()
  let nextNewId = -1

  for (const event of events) {
    const opposite = OPPOSITE[event.kind]
    for (const [index, row] of rows.entries()) {
      if (
        row.sourceId === event.sourceId &&
        row.kind === opposite &&
        !row.resolvedAt
      ) {
        rows[index] = { ...row, resolvedAt: nowIso, updatedAt: nowIso }
        touched.add(row.id)
      }
    }

    if (!shouldNotify(event, settings)) continue
    const index = rows.findIndex(
      (row) =>
        row.sourceId === event.sourceId &&
        row.kind === event.kind &&
        !row.resolvedAt,
    )
    if (index >= 0) {
      const row = rows[index]
      rows[index] = {
        ...row,
        knifeId: event.knifeId,
        eventId: event.eventId,
        occurrences: row.occurrences + 1,
        occurredAt: nowIso,
        updatedAt: nowIso,
        readAt: null,
        dismissedAt: null,
      }
      touched.add(row.id)
    } else {
      const id = nextNewId--
      rows.push({
        id,
        knifeId: event.knifeId,
        sourceId: event.sourceId,
        eventId: event.eventId,
        kind: event.kind,
        occurrences: 1,
        occurredAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
        readAt: null,
        dismissedAt: null,
        resolvedAt: null,
      })
      touched.add(id)
    }
  }

  const create: Omit<PriceNotification, 'id'>[] = []
  const update: PriceNotification[] = []
  for (const row of rows) {
    if (!touched.has(row.id)) continue
    if (row.id < 0) {
      const fields: Omit<PriceNotification, 'id'> & { id?: number } = {
        ...row,
      }
      delete fields.id
      create.push(fields)
    } else {
      update.push(row)
    }
  }
  return { create, update, deleteIds }
}

/** Returns the notifications an Inbox action changes, already updated. */
export function applyPriceNotificationAction(
  existing: readonly PriceNotification[],
  request: PriceNotificationAction,
  now: Date,
): PriceNotification[] {
  const nowIso = now.toISOString()
  if (request.action === 'read-all') {
    return existing
      .filter(isPriceNotificationUnread)
      .map((row) => ({ ...row, readAt: nowIso, updatedAt: nowIso }))
  }
  const ids = new Set(request.ids)
  const changed: PriceNotification[] = []
  for (const row of existing) {
    if (!ids.has(row.id)) continue
    let next = row
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
          next = { ...row, dismissedAt: null, readAt: null }
        break
    }
    if (next !== row) changed.push({ ...next, updatedAt: nowIso })
  }
  return changed
}

/** Validates a PATCH body for price notifications. */
export function parsePriceNotificationAction(
  body: unknown,
): PriceNotificationAction {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Request body must be an object')
  }
  const { action, ids } = body as Record<string, unknown>
  switch (action) {
    case 'read-all':
      return { action }
    case 'read':
    case 'dismiss':
    case 'restore':
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        ids.length > 1000 ||
        !ids.every((id) => Number.isSafeInteger(id) && id > 0)
      ) {
        throw new Error('ids must be a non-empty list of notification ids')
      }
      return { action, ids: ids as number[] }
    default:
      throw new Error('Unknown inbox action')
  }
}
