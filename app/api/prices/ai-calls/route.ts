import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { getLocalDb } from '@/lib/local-db'
import { readAiCallSummary } from '@/lib/price-monitor/ai-journal'
import { NO_STORE } from '@/lib/price-monitor/ai-route'
import { reportServerError } from '@/lib/sentry/server'
import { vaultAccessErrorResponse } from '@/lib/vault-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** What price monitoring's AI did in the last 24 hours (no content). */
export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    return NextResponse.json(readAiCallSummary(getLocalDb()), {
      headers: NO_STORE,
    })
  } catch (error) {
    const vaultResponse = vaultAccessErrorResponse(error)
    if (vaultResponse) return vaultResponse
    reportServerError(error, '/api/prices/ai-calls')
    return NextResponse.json(
      { error: 'Could not read the AI activity.' },
      { status: 500 },
    )
  }
}
