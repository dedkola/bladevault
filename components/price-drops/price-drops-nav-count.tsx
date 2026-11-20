'use client'

import { useCareInbox } from '@/components/providers/care-inbox-provider'

/**
 * Unread price and stock changes for the Price Drops nav link. Reuses the
 * Inbox provider's notifications, so it adds no polling of its own.
 */
export function usePriceDropsUnread(): number {
  const { pricesAvailable, priceUnreadCount } = useCareInbox()
  return pricesAvailable ? priceUnreadCount : 0
}

/** Screen-reader text after the count. */
export function priceDropsCountLabel(count: number) {
  return `${count} unread price ${count === 1 ? 'change' : 'changes'}`
}

export function formatNavCount(count: number) {
  return count > 99 ? '99+' : String(count)
}
