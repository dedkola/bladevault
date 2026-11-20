import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { reportServerError } from '@/lib/sentry/server'
import { selectDesktopPriceAlerts } from '@/lib/price-monitor/notifications'
import { getPriceNotifications } from '@/lib/price-monitor/notification-store'

/**
 * New price drops and restocks for the desktop app's native notifications,
 * polled by the Electron main process while the window is hidden. A locked
 * app answers 401 like every other route, so nothing leaks while locked.
 */
export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked

  const since = new URL(request.url).searchParams.get('since') ?? ''
  if (!Number.isFinite(Date.parse(since)))
    return NextResponse.json(
      { error: 'since must be an ISO date' },
      { status: 400 },
    )
  try {
    const now = new Date()
    return NextResponse.json(
      {
        now: now.toISOString(),
        alerts: selectDesktopPriceAlerts(
          await getPriceNotifications(),
          since,
          now,
        ),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    reportServerError(error, '/api/price-notifications/desktop')
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
