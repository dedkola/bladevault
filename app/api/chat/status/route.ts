import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { readChatStatus } from '@/lib/chat/config'
import { reportServerError } from '@/lib/sentry/server'
import { vaultAccessErrorResponse } from '@/lib/vault-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Whether chat can run, which model it uses and today's chat usage. */
export function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    return NextResponse.json(readChatStatus(), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    const vaultResponse = vaultAccessErrorResponse(error)
    if (vaultResponse) return vaultResponse
    reportServerError(error, '/api/chat/status')
    return NextResponse.json(
      { error: 'Could not read the chat status.' },
      { status: 500 },
    )
  }
}
