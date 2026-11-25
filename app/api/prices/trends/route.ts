import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { getLocalDb } from '@/lib/local-db'
import { reportServerError } from '@/lib/sentry/server'
import { vaultAccessErrorResponse } from '@/lib/vault-access'
import { buildPriceTrends } from '@/lib/wishlist-storage'

/**
 * Price Drops row charts: the 30-day best-price trend of every knife with an
 * enabled store link, and of each enabled link. Loaded after checks, not on
 * every overview poll.
 */
export function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    return NextResponse.json(
      { trends: buildPriceTrends(getLocalDb()) },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    const vaultResponse = vaultAccessErrorResponse(error)
    if (vaultResponse) return vaultResponse
    reportServerError(error, '/api/prices/trends')
    return NextResponse.json(
      { error: 'Could not load price trends.' },
      { status: 500 },
    )
  }
}
