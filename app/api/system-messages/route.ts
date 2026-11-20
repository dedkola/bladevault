import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { withVaultMutationRequest } from '@/lib/vault-mutation-request'
import { reportServerError } from '@/lib/sentry/server'
import { vaultAccessErrorResponse } from '@/lib/vault-access'
import {
  answerPriceQuestion,
  PriceQuestionError,
} from '@/lib/price-monitor/agent-inbox'
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

/**
 * Marks system messages read, dismisses or restores them, and answers AI
 * supervisor questions (which acts on the knife first).
 */
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
      const messages =
        action.action === 'answer'
          ? await answerPriceQuestion(action.id, action.answer)
          : await updateSystemMessages(action)
      return NextResponse.json({ messages })
    } catch (error) {
      if (error instanceof PriceQuestionError)
        return NextResponse.json(
          { error: error.message },
          { status: error.status },
        )
      const vaultResponse = vaultAccessErrorResponse(error)
      if (vaultResponse) return vaultResponse
      reportServerError(error, '/api/system-messages')
      const message = error instanceof Error ? error.message : 'Unknown error'
      return NextResponse.json({ error: message }, { status: 500 })
    }
  })
}
