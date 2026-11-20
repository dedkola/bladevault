import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { visibleBrowserWindowAvailable } from '@/lib/price-monitor/fetch'

/**
 * What this server can do for Price Drops. `solveInBrowser` is false where
 * the browser window would open somewhere the person cannot see it.
 */
export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  return NextResponse.json(
    { solveInBrowser: visibleBrowserWindowAvailable() },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
