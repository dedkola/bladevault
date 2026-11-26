import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { listConversations } from '@/lib/chat/store'
import { reportServerError } from '@/lib/sentry/server'
import { vaultAccessErrorResponse } from '@/lib/vault-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Saved chats, newest first: `?archived=1` for the archive, `?q=` to search. */
export function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  const params = new URL(request.url).searchParams
  try {
    const conversations = listConversations({
      archived: params.get('archived') === '1',
      query: (params.get('q') ?? '').slice(0, 200),
    })
    return NextResponse.json(
      { conversations },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    const vaultResponse = vaultAccessErrorResponse(error)
    if (vaultResponse) return vaultResponse
    reportServerError(error, '/api/chat/conversations')
    return NextResponse.json(
      { error: 'Could not load the chats.' },
      { status: 500 },
    )
  }
}
