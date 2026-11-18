import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { withVaultMutationRequest } from '@/lib/vault-mutation-request'
import { reportServerError } from '@/lib/sentry/server'
import { parseSystemMessageAction } from '@/lib/system-messages'
import {
  getSystemMessages,
  updateSystemMessages,
} from '@/lib/system-message-store'

/** App events shown in the Inbox, such as failed backups. */
export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked

  try {
    return NextResponse.json({ messages: await getSystemMessages() })
  } catch (error) {
    reportServerError(error, '/api/system-messages')
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** Marks system messages read, dismisses or restores them. */
export async function PATCH(request: Request) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked

    let action
    try {
      action = parseSystemMessageAction(await request.json())
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Invalid request body'
      return NextResponse.json({ error: message }, { status: 400 })
    }
    try {
      return NextResponse.json({ messages: await updateSystemMessages(action) })
    } catch (error) {
      reportServerError(error, '/api/system-messages')
      const message = error instanceof Error ? error.message : 'Unknown error'
      return NextResponse.json({ error: message }, { status: 500 })
    }
  })
}
