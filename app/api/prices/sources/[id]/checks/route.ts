import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { getLocalDb } from '@/lib/local-db'
import { readSourceChecks } from '@/lib/price-monitor/insights'
import { reportServerError } from '@/lib/sentry/server'
import { vaultAccessErrorResponse } from '@/lib/vault-access'

/**
 * Check history of one price source: its last 30 checks, newest first,
 * with the reading each stored, AI review marks and AI solver steps.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    const { id } = await params
    if (!/^\d+$/.test(id))
      return NextResponse.json(
        { error: 'Source ids are numbers' },
        { status: 400 },
      )
    const history = readSourceChecks(getLocalDb(), Number(id))
    if (!history)
      return NextResponse.json({ error: 'Source not found' }, { status: 404 })
    return NextResponse.json(history, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    const vaultResponse = vaultAccessErrorResponse(error)
    if (vaultResponse) return vaultResponse
    reportServerError(error, '/api/prices/sources/[id]/checks')
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
