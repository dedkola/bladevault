import {
  isCareNotificationUnread,
  type CareNotification,
} from '@/lib/care-notifications'
import {
  isPriceNotificationUnread,
  type PriceNotification,
} from '@/lib/price-monitor/notifications'
import type { PopupNotificationSettings } from '@/lib/settings-shared'
import {
  isSystemMessageUnread,
  type SystemMessage,
} from '@/lib/system-messages'

export type InboxPopupType = 'care' | 'system' | 'price'

/** One Inbox message that may pop up, without its row. */
export type InboxPopupRef = {
  /**
   * Changes when the message comes back with news (a repeat price drop, a
   * new care cycle), so it can pop up again; `type` and `id` stay the same.
   */
  key: string
  type: InboxPopupType
  id: number
}

/** At most this many keys are remembered; old ones can't come back anyway. */
const SEEN_LIMIT = 500

/**
 * Unread, open messages that could pop up. Achievements are left out: they
 * have their own celebration. Care messages count only while reminders are on.
 */
export function collectPopupCandidates({
  care,
  careEnabled,
  system,
  price,
  now,
}: {
  care: readonly CareNotification[]
  careEnabled: boolean
  system: readonly SystemMessage[]
  price: readonly PriceNotification[]
  now: Date
}): InboxPopupRef[] {
  const candidates: InboxPopupRef[] = []
  for (const row of price) {
    if (!isPriceNotificationUnread(row, now)) continue
    candidates.push({
      key: `price:${row.id}:${row.occurredAt}`,
      type: 'price',
      id: row.id,
    })
  }
  for (const row of system) {
    if (row.kind === 'achievement' || !isSystemMessageUnread(row)) continue
    candidates.push({
      key: `system:${row.id}:${row.occurredAt}`,
      type: 'system',
      id: row.id,
    })
  }
  if (careEnabled) {
    for (const row of care) {
      if (!isCareNotificationUnread(row, now)) continue
      candidates.push({
        key: `care:${row.id}:${row.dueOn}`,
        type: 'care',
        id: row.id,
      })
    }
  }
  return candidates
}

export function isPopupAllowed(
  type: InboxPopupType,
  settings: PopupNotificationSettings,
): boolean {
  return settings.enabled && settings[type]
}

/**
 * Picks the candidates not seen before. Every candidate is marked seen, even
 * when it stays quiet (first load of its type, hidden window, pop-ups off),
 * so turning pop-ups on later never replays the backlog.
 */
export function selectNewPopups(
  seen: ReadonlySet<string>,
  candidates: readonly InboxPopupRef[],
  {
    settings,
    quiet,
  }: {
    settings: PopupNotificationSettings
    /** Types that only mark their candidates seen this time. */
    quiet: ReadonlySet<InboxPopupType>
  },
): { fresh: InboxPopupRef[]; seen: Set<string> } {
  const fresh: InboxPopupRef[] = []
  const next = new Set(seen)
  for (const candidate of candidates) {
    if (next.has(candidate.key)) continue
    next.add(candidate.key)
    if (quiet.has(candidate.type)) continue
    if (!isPopupAllowed(candidate.type, settings)) continue
    fresh.push(candidate)
  }
  // Sets keep insertion order: drop the oldest keys first.
  if (next.size > SEEN_LIMIT) {
    const drop = next.size - SEEN_LIMIT
    let index = 0
    for (const key of next) {
      if (index++ >= drop) break
      next.delete(key)
    }
  }
  return { fresh, seen: next }
}

/**
 * The next pop-up queue, newest first: fresh arrivals on top, replacing an
 * older pop-up for the same message, and only messages that are still
 * unread and allowed. A message read or closed in the Inbox drops out.
 */
export function nextPopupQueue(
  queue: readonly InboxPopupRef[],
  fresh: readonly InboxPopupRef[],
  candidates: readonly InboxPopupRef[],
  settings: PopupNotificationSettings,
): InboxPopupRef[] {
  const identity = (popup: InboxPopupRef) => `${popup.type}:${popup.id}`
  const open = new Set(candidates.map(identity))
  const freshIds = new Set(fresh.map(identity))
  return [
    ...fresh,
    ...queue.filter((popup) => !freshIds.has(identity(popup))),
  ].filter(
    (popup) =>
      open.has(identity(popup)) && isPopupAllowed(popup.type, settings),
  )
}
