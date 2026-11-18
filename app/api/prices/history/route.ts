import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { getLocalDb } from '@/lib/local-db'
import {
  buildKnifeHistory,
  parseHistoryRange,
} from '@/lib/price-monitor/insights'
import { reportServerError } from '@/lib/sentry/server'
import { vaultAccessErrorResponse } from '@/lib/vault-access'

/** One knife's price history per source: ?knifeId=…&range=7d|1m|3m|6m|1y|all */
export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    const params = new URL(request.url).searchParams
    const knifeId = params.get('knifeId')?.trim()
    if (!knifeId)
      return NextResponse.json(
        { error: 'knifeId is required' },
        { status: 400 },
      )
    const history = buildKnifeHistory(
      getLocalDb(),
      knifeId,
      parseHistoryRange(params.get('range')),
    )
    if (!history)
      return NextResponse.json({ error: 'Knife not found' }, { status: 404 })
    return NextResponse.json(
      { history },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    const vaultResponse = vaultAccessErrorResponse(error)
    if (vaultResponse) return vaultResponse
    reportServerError(error, '/api/prices/history')
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
