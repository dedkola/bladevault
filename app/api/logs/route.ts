import { requireAppUnlock } from '@/lib/app-lock'
import { NextResponse } from 'next/server'
import { getStorage } from '@/lib/storage'
import { dockerJsonResponse } from '@/lib/server-json-response'
import { reportServerError } from '@/lib/sentry/server'

export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked

  try {
    const events = await getStorage().getAuditLog()
    return await dockerJsonResponse(
      request,
      { events },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (error) {
    reportServerError(error, '/api/logs')
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
