import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { withVaultMutationRequest } from '@/lib/vault-mutation-request'
import { reportServerError } from '@/lib/sentry/server'
import { getStorage } from '@/lib/storage'
import { parseCareNotificationAction } from '@/lib/care-notifications'
import {
  syncCareInbox,
  updateCareInbox,
} from '@/lib/services/care-inbox-service'

/** Stored care inbox messages, without syncing them. */
export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked

  try {
    const notifications = await getStorage().getCareNotifications()
    return NextResponse.json({ notifications })
  } catch (error) {
    reportServerError(error, '/api/care-inbox')
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** Syncs the inbox with current care status and returns every message. */
export async function POST(request: Request) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked

    try {
      const notifications = await syncCareInbox()
      return NextResponse.json({ notifications })
    } catch (error) {
      reportServerError(error, '/api/care-inbox')
      const message = error instanceof Error ? error.message : 'Unknown error'
      return NextResponse.json({ error: message }, { status: 500 })
    }
  })
}

/** Marks messages read, snoozes, dismisses or restores them. */
export async function PATCH(request: Request) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked

    let action
    try {
      action = parseCareNotificationAction(await request.json())
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Invalid request body'
      return NextResponse.json({ error: message }, { status: 400 })
    }
    try {
      const notifications = await updateCareInbox(action)
      return NextResponse.json({ notifications })
    } catch (error) {
      reportServerError(error, '/api/care-inbox')
      const message = error instanceof Error ? error.message : 'Unknown error'
      return NextResponse.json({ error: message }, { status: 500 })
    }
  })
}
