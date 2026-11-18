import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { withVaultMutationRequest } from '@/lib/vault-mutation-request'
import { reportServerError } from '@/lib/sentry/server'
import { parsePriceNotificationAction } from '@/lib/price-monitor/notifications'
import {
  getPriceNotifications,
  updatePriceNotifications,
} from '@/lib/price-monitor/notification-store'

/** The Inbox Prices section: price and stock changes with their knives. */
export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked

  try {
    return NextResponse.json({
      notifications: await getPriceNotifications(),
    })
  } catch (error) {
    reportServerError(error, '/api/price-notifications')
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** Marks price notifications read, dismisses or restores them. */
export async function PATCH(request: Request) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked

    let action
    try {
      action = parsePriceNotificationAction(await request.json())
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Invalid request body'
      return NextResponse.json({ error: message }, { status: 400 })
    }
    try {
      return NextResponse.json({
        notifications: await updatePriceNotifications(action),
      })
    } catch (error) {
      reportServerError(error, '/api/price-notifications')
      const message = error instanceof Error ? error.message : 'Unknown error'
      return NextResponse.json({ error: message }, { status: 500 })
    }
  })
}
