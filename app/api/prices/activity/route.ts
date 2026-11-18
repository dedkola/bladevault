import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { getLocalDb } from '@/lib/local-db'
import {
  readDailyActivity,
  readRecentProblems,
} from '@/lib/price-monitor/store'
import { reportServerError } from '@/lib/sentry/server'
import { vaultAccessErrorResponse } from '@/lib/vault-access'

function dayString(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Execution history: daily totals per store and recent problems. */
export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    const raw = new URL(request.url).searchParams.get('days')
    const requested = raw === null ? NaN : Number(raw)
    const days = Number.isInteger(requested)
      ? Math.min(365, Math.max(1, requested))
      : 30
    const since = new Date()
    since.setDate(since.getDate() - (days - 1))
    const database = getLocalDb()
    return NextResponse.json(
      {
        days,
        daily: readDailyActivity(database, dayString(since)),
        problems: readRecentProblems(database),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    const vaultResponse = vaultAccessErrorResponse(error)
    if (vaultResponse) return vaultResponse
    reportServerError(error, '/api/prices/activity')
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
