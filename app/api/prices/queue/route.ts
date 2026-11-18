import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { buildQueueSnapshot } from '@/lib/price-monitor/worker'
import { reportServerError } from '@/lib/sentry/server'
import { vaultAccessErrorResponse } from '@/lib/vault-access'

/** Live queue: checks in flight and each store's pace, pause and ETA. */
export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    return NextResponse.json(
      { queue: buildQueueSnapshot() },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    const vaultResponse = vaultAccessErrorResponse(error)
    if (vaultResponse) return vaultResponse
    reportServerError(error, '/api/prices/queue')
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
