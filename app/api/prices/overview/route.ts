import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { getLocalDb } from '@/lib/local-db'
import { buildPriceOverview } from '@/lib/price-monitor/insights'
import { reportServerError } from '@/lib/sentry/server'
import { getSettings } from '@/lib/settings'
import { vaultAccessErrorResponse } from '@/lib/vault-access'

/** Price Drops page: KPIs, recent changes, sections and per-knife prices. */
export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    const raw = new URL(request.url).searchParams.get('days')
    const requested = raw === null ? NaN : Number(raw)
    const windowDays = Number.isInteger(requested)
      ? Math.min(365, Math.max(1, requested))
      : 30
    return NextResponse.json(
      {
        overview: buildPriceOverview(
          getLocalDb(),
          getSettings().priceMonitoring,
          { windowDays },
        ),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    const vaultResponse = vaultAccessErrorResponse(error)
    if (vaultResponse) return vaultResponse
    reportServerError(error, '/api/prices/overview')
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
