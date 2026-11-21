import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import {
  RESUME_WARMUP_MS,
  notePowerResume,
  notePowerSuspend,
} from '@/lib/price-monitor/power'
import { getPriceMonitorWorker } from '@/lib/price-monitor/worker'

/**
 * The desktop app reports sleep and wake (Electron powerMonitor). Suspend
 * stops AI calls in flight, which would only time out after wake; resume
 * restarts checks and AI runs after a short warmup. A locked app answers
 * 401; the server then notices sleep from the clock jump instead.
 */
export async function POST(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked

  let state: unknown
  try {
    state = ((await request.json()) as { state?: unknown } | null)?.state
  } catch {
    state = null
  }
  if (state !== 'suspend' && state !== 'resume')
    return NextResponse.json(
      { error: "state must be 'suspend' or 'resume'" },
      { status: 400 },
    )
  if (state === 'suspend') {
    notePowerSuspend()
  } else {
    notePowerResume()
    getPriceMonitorWorker().wake(RESUME_WARMUP_MS)
  }
  return NextResponse.json(
    { ok: true },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
