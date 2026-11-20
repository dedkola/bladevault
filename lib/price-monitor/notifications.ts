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
 * - Per-knife alert rules (mute, target price, below regular price) and a
 *   source muted for some days only stop new notifications; an opposite
 *   event still resolves an open one.
 * - A snoozed notification stays hidden until its time, even when a repeat
 *   updates it; then it comes back unread with the latest change.
 */
import type { ChangeEvent } from '@/lib/price-monitor/insights'
import { formatMoney, toMinorUnits } from '@/lib/price-monitor/money'
import type { PriceMonitoringSettings } from '@/lib/settings-shared'

export type PriceNotificationKind =
  'drop' | 'increase' | 'out_of_stock' | 'back_in_stock'
export type PriceNotificationBox = 'open' | 'snoozed' | 'done'

export const PRICE_NOTIFICATION_KINDS: readonly PriceNotificationKind[] = [
  'drop',
  'increase',
  'out_of_stock',
  'back_in_stock',
]
export const PRICE_NOTIFICATION_RETENTION_DAYS = 90
export const PRICE_SNOOZE_MAX_DAYS = 365
/** Snooze choices for one price message. */
export const PRICE_SNOOZE_OPTIONS: readonly { days: number; label: string }[] =
  [
    { days: 1, label: 'Tomorrow' },
    { days: 3, label: '3 days' },
    { days: 7, label: '1 week' },
    { days: 30, label: '1 month' },
  ]
/** How long a store can be muted for one knife from the Inbox. */
export const PRICE_SOURCE_MUTE_OPTIONS: readonly {
  days: number
  label: string
}[] = [
  { days: 7, label: '1 week' },
  { days: 30, label: '1 month' },
  { days: 90, label: '3 months' },
]

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
  /** Hidden from the open list until then. */
  snoozedUntil: string | null
}

/** What the Inbox shows next to a price message, read when it loads. */
export type PriceNotificationContext = {
  /** Regular price in the event's currency, when comparable. */
  paidMinor: number | null
  /** Lowest trusted price this store has shown, in the event's currency. */
  lowestMinor: number | null
  /** The store is muted for this knife until then. */
  sourceMutedUntil: string | null
  /** The knife's notifications are muted. */
  knifeMuted: boolean
}

/** A notification with its event: knife, store, prices and change. */
export type PriceNotificationView = PriceNotification & {
  event: ChangeEvent
  context: PriceNotificationContext
}

/** A knife's own alert rules (stored with its price watch). */
export type PriceAlertRules = {
  /** No new notifications for this knife. */
  muted: boolean
  /** Drops notify only at or below this price (same currency only). */
  targetPrice: { minor: number; currency: string } | null
  /** Drops notify only below the regular price (when comparable). */
  belowPaid: boolean
}

export const NO_PRICE_ALERT_RULES: PriceAlertRules = {
  muted: false,
  targetPrice: null,
  belowPaid: false,
}

/** Everything the planner needs to apply alert rules to one event. */
export type PriceAlertContext = {
  rules: PriceAlertRules
  /** Regular price in the event's currency, when comparable. */
  paidMinor: number | null
  /** The source is muted until then. */
  sourceMutedUntil: string | null
  /** Lowest trusted price the source showed before this event, same currency. */
  lowestBeforeMinor: number | null
}

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
      /** The new price, in minor units. */
      priceMinor: number
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
  | { action: 'read' | 'dismiss' | 'restore' | 'unsnooze'; ids: number[] }
  | { action: 'snooze'; ids: number[]; days: number }
  | { action: 'read-all' | 'dismiss-all' }

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
  now: Date,
): PriceNotificationBox {
  if (notification.resolvedAt || notification.dismissedAt) return 'done'
  if (
    notification.snoozedUntil &&
    Date.parse(notification.snoozedUntil) > now.getTime()
  )
    return 'snoozed'
  return 'open'
}

export function isPriceNotificationUnread(
  notification: PriceNotification,
  now: Date,
): boolean {
  return (
    getPriceNotificationBox(notification, now) === 'open' &&
    !notification.readAt
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

type PriceMove = { deltaPct: number; deltaMinor: number; currency: string }

/** Whether a move reaches the minimum amount (0 turns it off). */
function meetsMinimumAmount(
  change: PriceMove,
  thresholds: PriceNotificationSettings['thresholds'],
): boolean {
  if (!(thresholds.minAmount > 0)) return true
  return (
    Math.abs(change.deltaMinor) >=
    toMinorUnits(thresholds.minAmount, change.currency)
  )
}

/**
 * Whether a price change is big enough: at least `minPercent` and at least
 * `minAmount` in its own currency. Thresholds of 0 let every change through.
 */
export function meetsPriceThreshold(
  change: PriceMove,
  thresholds: PriceNotificationSettings['thresholds'],
): boolean {
  return (
    Math.abs(change.deltaPct) >= thresholds.minPercent &&
    meetsMinimumAmount(change, thresholds)
  )
}

/** Whether the knife or the source is muted at `now`. */
export function isPriceAlertMuted(
  context: PriceAlertContext | null | undefined,
  now: Date,
): boolean {
  if (!context) return false
  if (context.rules.muted) return true
  return Boolean(
    context.sourceMutedUntil &&
    Date.parse(context.sourceMutedUntil) > now.getTime(),
  )
}

/**
 * Whether an event notifies: not muted, its category on and, for prices,
 * the knife's rules and the thresholds. For a drop:
 * - a target price in the same currency must be reached; crossing it
 *   notifies whatever the thresholds;
 * - with "only below regular price", the new price must be under the
 *   regular price (ignored when no comparable regular price is stored);
 * - with `allTimeLow` on, a new lowest price for the source skips the
 *   percent threshold (the minimum amount still applies).
 */
export function shouldNotify(
  event: PriceNotificationEvent,
  settings: PriceNotificationSettings,
  context: PriceAlertContext | null = null,
  now: Date = new Date(),
): boolean {
  if (isPriceAlertMuted(context, now)) return false
  if (!settings.notify[CATEGORY[event.kind]]) return false
  if (!('currency' in event)) return true
  if (event.kind === 'increase')
    return meetsPriceThreshold(event, settings.thresholds)

  const rules = context?.rules ?? NO_PRICE_ALERT_RULES
  const target =
    rules.targetPrice && rules.targetPrice.currency === event.currency
      ? rules.targetPrice.minor
      : null
  if (target !== null && event.priceMinor > target) return false
  if (
    rules.belowPaid &&
    context?.paidMinor != null &&
    event.priceMinor >= context.paidMinor
  )
    return false
  const previousMinor = event.priceMinor - event.deltaMinor
  if (target !== null && previousMinor > target) return true
  if (meetsPriceThreshold(event, settings.thresholds)) return true
  const lowest = context?.lowestBeforeMinor ?? null
  return (
    settings.thresholds.allTimeLow &&
    lowest !== null &&
    event.priceMinor < lowest &&
    meetsMinimumAmount(event, settings.thresholds)
  )
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
  contextFor: (
    event: PriceNotificationEvent,
  ) => PriceAlertContext | null = () => null,
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

    if (!shouldNotify(event, settings, contextFor(event), now)) continue
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
        snoozedUntil: null,
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
      .filter((row) => isPriceNotificationUnread(row, now))
      .map((row) => ({ ...row, readAt: nowIso, updatedAt: nowIso }))
  }
  if (request.action === 'dismiss-all') {
    return existing
      .filter((row) => getPriceNotificationBox(row, now) === 'open')
      .map((row) => ({
        ...row,
        dismissedAt: nowIso,
        readAt: row.readAt ?? nowIso,
        updatedAt: nowIso,
      }))
  }
  if (!('ids' in request)) return []
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

/** Validates a PATCH body for price notifications. */
export function parsePriceNotificationAction(
  body: unknown,
): PriceNotificationAction {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Request body must be an object')
  }
  const { action, ids, days } = body as Record<string, unknown>
  const parseIds = (): number[] => {
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > 1000 ||
      !ids.every((id) => Number.isSafeInteger(id) && id > 0)
    ) {
      throw new Error('ids must be a non-empty list of notification ids')
    }
    return ids as number[]
  }
  switch (action) {
    case 'read-all':
    case 'dismiss-all':
      return { action }
    case 'read':
    case 'dismiss':
    case 'restore':
    case 'unsnooze':
      return { action, ids: parseIds() }
    case 'snooze':
      if (
        !Number.isSafeInteger(days) ||
        (days as number) < 1 ||
        (days as number) > PRICE_SNOOZE_MAX_DAYS
      ) {
        throw new Error(
          `days must be a whole number from 1 to ${PRICE_SNOOZE_MAX_DAYS}`,
        )
      }
      return { action, ids: parseIds(), days: days as number }
    default:
      throw new Error('Unknown inbox action')
  }
}

/** One native desktop notification, ready to show (Electron main process). */
export type DesktopPriceAlert = {
  id: number
  knifeId: string
  kind: 'drop' | 'back_in_stock'
  title: string
  body: string
  occurredAt: string
}

/**
 * Price drops and restocks for native desktop notifications: open, unread
 * Inbox messages whose latest change happened after `since`, oldest first.
 * Muted knives and stores never reach the Inbox, so they never show here.
 */
export function selectDesktopPriceAlerts(
  views: readonly PriceNotificationView[],
  since: string,
  now: Date,
): DesktopPriceAlert[] {
  const after = Date.parse(since)
  return views
    .filter(
      (row) =>
        (row.kind === 'drop' || row.kind === 'back_in_stock') &&
        isPriceNotificationUnread(row, now) &&
        Date.parse(row.occurredAt) > after,
    )
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
    .map((row) => {
      const { event } = row
      const knife = event.knife.brand
        ? `${event.knife.brand} ${event.knife.name}`
        : event.knife.name
      const price =
        event.priceMinor !== null && event.currency
          ? event.type === 'price' && event.previousPriceMinor !== null
            ? `${formatMoney(event.previousPriceMinor, event.currency)} → ${formatMoney(event.priceMinor, event.currency)}`
            : formatMoney(event.priceMinor, event.currency)
          : ''
      return {
        id: row.id,
        knifeId: event.knife.id,
        kind: row.kind as DesktopPriceAlert['kind'],
        title: `${row.kind === 'drop' ? 'Price dropped' : 'Back in stock'}: ${knife}`,
        body: [event.storeName, price].filter(Boolean).join(' · '),
        occurredAt: row.occurredAt,
      }
    })
}
