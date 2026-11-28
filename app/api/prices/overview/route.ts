import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { getLocalDb } from '@/lib/local-db'
import { buildPriceOverview } from '@/lib/price-monitor/insights'
import { frequencyMs } from '@/lib/price-monitor/schedule'
import { readStorePlan } from '@/lib/price-monitor/store-plan'
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
    const settings = getSettings().priceMonitoring
    const database = getLocalDb()
    const now = Date.now()
    return NextResponse.json(
      {
        overview: buildPriceOverview(database, settings, {
          now,
          windowDays,
          frequencyMs: frequencyMs(settings.schedule),
          plan: readStorePlan(database, settings, now),
        }),
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
