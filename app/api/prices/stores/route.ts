import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { clearBrowserState } from '@/lib/price-monitor/browser-state'
import {
  assertStoreKnown,
  PriceWatchError,
  requestStoreChecks,
  resumeStoreNow,
  setStorePaused,
} from '@/lib/price-monitor/store'
import { getPriceMonitorWorker } from '@/lib/price-monitor/worker'
import { reportServerError } from '@/lib/sentry/server'
import { getSettings } from '@/lib/settings'
import {
  getVaultAccessState,
  vaultAccessErrorResponse,
} from '@/lib/vault-access'
import { withVaultMutationRequest } from '@/lib/vault-mutation-request'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' } as const

const STORE_ACTIONS = [
  'resume',
  'reset_cookies',
  'check',
  'pause',
  'unpause',
] as const
type StoreAction = (typeof STORE_ACTIONS)[number]

function parseBody(body: unknown): { laneKey: string; action: StoreAction } {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('Request body must be an object')
  const { laneKey, action } = body as Record<string, unknown>
  if (typeof laneKey !== 'string' || !laneKey.trim() || laneKey.length > 255)
    throw new Error('laneKey is required')
  if (!(STORE_ACTIONS as readonly unknown[]).includes(action))
    throw new Error(`action must be one of ${STORE_ACTIONS.join(', ')}`)
  return { laneKey: laneKey.trim(), action: action as StoreAction }
}

/**
 * Settings → Stores actions for one store (lane): Resume now (end a
 * bot-check cooldown), Reset saved cookies, Check this store now, and
 * Pause / resume its scheduled checks.
 */
export async function POST(request: Request) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked

    let input
    try {
      input = parseBody(await request.json())
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Invalid request body'
      return NextResponse.json({ error: message }, { status: 400 })
    }

    try {
      if (getVaultAccessState().readOnly)
        return NextResponse.json(
          { error: 'The vault is read-only while a restore runs.' },
          { status: 423 },
        )
      const worker = getPriceMonitorWorker()
      const { laneKey, action } = input
      let queued: number[] | undefined
      switch (action) {
        case 'resume':
          await resumeStoreNow(laneKey)
          break
        case 'reset_cookies':
          assertStoreKnown(laneKey)
          await clearBrowserState(laneKey)
          break
        case 'check':
          queued = await requestStoreChecks(
            laneKey,
            getSettings().priceMonitoring,
          )
          // Make sure a worker runs here, at least for manual checks.
          if (queued.length) worker.start({ scheduled: false })
          break
        case 'pause':
        case 'unpause':
          await setStorePaused(laneKey, action === 'pause')
          break
      }
      worker.wake(0)
      return NextResponse.json(
        { ok: true, ...(queued ? { queued: queued.length } : {}) },
        { headers: NO_STORE },
      )
    } catch (error) {
      if (error instanceof PriceWatchError)
        return NextResponse.json(
          { error: error.message },
          { status: error.status },
        )
      if (vaultAccessErrorResponse(error)) throw error
      reportServerError(error, '/api/prices/stores')
      const message = error instanceof Error ? error.message : 'Unknown error'
      return NextResponse.json({ error: message }, { status: 500 })
    }
  })
}
