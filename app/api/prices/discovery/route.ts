import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { getLocalDb } from '@/lib/local-db'
import { discoveryActive } from '@/lib/price-monitor/discovery'
import {
  readDiscoveryOverview,
  retryDiscovery,
} from '@/lib/price-monitor/discovery-store'
import { DISCOVERY_STORES } from '@/lib/price-monitor/discovery-stores'
import { getPriceMonitorWorker } from '@/lib/price-monitor/worker'
import { reportServerError } from '@/lib/sentry/server'
import { getSettings } from '@/lib/settings'
import { OTHER_STORE_IDS } from '@/lib/settings-shared'
import { vaultAccessErrorResponse } from '@/lib/vault-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' } as const

/** Results per store; turned-off stores are listed too, without a search. */
function overview() {
  const settings = getSettings().priceMonitoring
  const worker = getPriceMonitorWorker()
  const database = getLocalDb()
  return {
    active: discoveryActive(settings),
    running: Boolean(worker.discovering),
    stores: OTHER_STORE_IDS.map((id) => {
      const store = DISCOVERY_STORES[id]
      return {
        label: store.label,
        active: discoveryActive(settings, id),
        running:
          Boolean(worker.discovering) && worker.discoveryLane === store.laneKey,
        ...readDiscoveryOverview(database, {
          settings,
          store: id,
          marketplace: store.marketplace,
          laneKey: store.laneKey,
        }),
      }
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

/** Other stores: what AI found at each store, and how many knives wait. */
export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    return NextResponse.json({ discovery: overview() }, { headers: NO_STORE })
  } catch (error) {
    return errorResponse(error)
  }
}

/** Search again, at every turned-on store, for knives AI has not found. */
export async function POST(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    const settings = getSettings().priceMonitoring
    let reset = 0
    for (const id of OTHER_STORE_IDS) {
      if (!settings.otherStores.stores[id]) continue
      reset += await retryDiscovery({
        store: id,
        marketplace: DISCOVERY_STORES[id].marketplace,
      })
    }
    getPriceMonitorWorker().resetDiscoveryPause()
    return NextResponse.json(
      { reset, discovery: overview() },
      { headers: NO_STORE },
    )
  } catch (error) {
    return errorResponse(error)
  }
}
