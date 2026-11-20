import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { getLocalDb } from '@/lib/local-db'
import { parsePriceCheckRequest } from '@/lib/price-monitor/shared'
import {
  markScheduledSourcesDue,
  readActiveSources,
  readSource,
  syncAutoSource,
} from '@/lib/price-monitor/store'
import {
  getPriceMonitorWorker,
  requestPriceChecks,
} from '@/lib/price-monitor/worker'
import { getSettings } from '@/lib/settings'
import { reportServerError } from '@/lib/sentry/server'
import { getStorage } from '@/lib/storage'
import { getVaultAccessState } from '@/lib/vault-access'
import { withVaultMutationRequest } from '@/lib/vault-mutation-request'

/**
 * Check now for one source or all of a knife's sources. The paced queue
 * runs them at each store's next free slot (never two at one store); poll
 * the knife's price watch or /api/prices/queue for progress.
 */
export async function POST(request: Request) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked

    let check
    try {
      check = parsePriceCheckRequest(await request.json())
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
      if (check.scope === 'all') {
        const settings = getSettings().priceMonitoring
        if (!settings.enabled)
          return NextResponse.json(
            {
              error:
                'Turn on automatic checks in Settings → Price monitoring to check every knife.',
            },
            { status: 409 },
          )
        // Progress: /api/prices/queue?since=<startedAt> counts checks since.
        const startedAt = new Date().toISOString()
        const due = await markScheduledSourcesDue(settings)
        getPriceMonitorWorker().wake(0)
        return NextResponse.json(
          { due, startedAt },
          { status: 202, headers: { 'Cache-Control': 'no-store' } },
        )
      }
      let sourceIds: number[]
      if (check.scope === 'knife') {
        const knife = await getStorage().getKnifeById(check.id)
        if (!knife)
          return NextResponse.json(
            { error: 'Knife not found' },
            { status: 404 },
          )
        await syncAutoSource(knife)
        sourceIds = readActiveSources(getLocalDb(), knife.id).map(
          (source) => source.id,
        )
      } else {
        const source = readSource(getLocalDb(), Number(check.id))
        if (!source || source.removed_at)
          return NextResponse.json(
            { error: 'Source not found' },
            { status: 404 },
          )
        sourceIds = [source.id]
      }
      if (!sourceIds.length)
        return NextResponse.json(
          { error: 'Add a product URL to check its price.' },
          { status: 400 },
        )
      const queued = await requestPriceChecks(sourceIds)
      return NextResponse.json(
        { queued },
        { status: 202, headers: { 'Cache-Control': 'no-store' } },
      )
    } catch (error) {
      reportServerError(error, '/api/prices/check')
      const message = error instanceof Error ? error.message : 'Unknown error'
      return NextResponse.json({ error: message }, { status: 500 })
    }
  })
}
