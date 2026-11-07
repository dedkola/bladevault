import { requireAppUnlock } from '@/lib/app-lock'
import { NextResponse } from 'next/server'
import { getStorage } from '@/lib/storage'
import { dockerJsonResponse } from '@/lib/server-json-response'
import { reportServerError } from '@/lib/sentry/server'

export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked

  try {
    const activity = await getStorage().getKnifeActivity()
    return await dockerJsonResponse(request, { activity })
  } catch (error) {
    reportServerError(error, '/api/activity')
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
