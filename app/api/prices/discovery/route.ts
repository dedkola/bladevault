import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { getLocalDb } from '@/lib/local-db'
import { DISCOVERY_STORE, discoveryActive } from '@/lib/price-monitor/discovery'
import {
  readDiscoveryOverview,
  retryDiscovery,
} from '@/lib/price-monitor/discovery-store'
import { getPriceMonitorWorker } from '@/lib/price-monitor/worker'
import { reportServerError } from '@/lib/sentry/server'
import { getSettings } from '@/lib/settings'
import { vaultAccessErrorResponse } from '@/lib/vault-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' } as const

function overview() {
  const settings = getSettings().priceMonitoring
  return {
    active: discoveryActive(settings),
    running: Boolean(getPriceMonitorWorker().discovering),
    ...readDiscoveryOverview(getLocalDb(), {
      settings,
      store: DISCOVERY_STORE,
      marketplace: settings.otherStores.amazonMarketplace,
    }),
  }
}

function errorResponse(error: unknown) {
  const vaultResponse = vaultAccessErrorResponse(error)
  if (vaultResponse) return vaultResponse
  reportServerError(error, '/api/prices/discovery')
  const message = error instanceof Error ? error.message : 'Unknown error'
  return NextResponse.json({ error: message }, { status: 500 })
}

/** Other stores: what AI found on Amazon, and how many knives wait. */
export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    return NextResponse.json({ discovery: overview() }, { headers: NO_STORE })
  } catch (error) {
    return errorResponse(error)
  }
}

/** Search again for knives AI has not found yet. */
export async function POST(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    const settings = getSettings().priceMonitoring
    const reset = await retryDiscovery({
      store: DISCOVERY_STORE,
      marketplace: settings.otherStores.amazonMarketplace,
    })
    getPriceMonitorWorker().resetDiscoveryPause()
    return NextResponse.json(
      { reset, discovery: overview() },
      { headers: NO_STORE },
    )
  } catch (error) {
    return errorResponse(error)
  }
}
