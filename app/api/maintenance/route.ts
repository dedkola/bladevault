import { requireAppUnlock } from '@/lib/app-lock'
import { NextResponse } from 'next/server'
import { getStorage } from '@/lib/storage'
import { dockerJsonResponse } from '@/lib/server-json-response'
import { reportServerError } from '@/lib/sentry/server'

/** Latest maintenance date per knife and type, for derived care status. */
export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked

  try {
    const latest = await getStorage().getMaintenanceLatest()
    return await dockerJsonResponse(request, { latest })
  } catch (error) {
    reportServerError(error, '/api/maintenance')
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
