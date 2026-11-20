import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { getLocalDb } from '@/lib/local-db'
import { buildMarketSummaries } from '@/lib/price-monitor/market-summary'
import { reportServerError } from '@/lib/sentry/server'
import { getSettings } from '@/lib/settings'
import { vaultAccessErrorResponse } from '@/lib/vault-access'

/**
 * Collection market summaries: one entry per knife with enabled store links,
 * keyed by knife id. The collection loads it once and filters locally.
 */
export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    return NextResponse.json(
      {
        summaries: buildMarketSummaries(
          getLocalDb(),
          getSettings().priceMonitoring,
        ),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    const vaultResponse = vaultAccessErrorResponse(error)
    if (vaultResponse) return vaultResponse
    reportServerError(error, '/api/prices/market')
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
