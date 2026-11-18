import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { getLocalDb } from '@/lib/local-db'
import { saveBrowserState } from '@/lib/price-monitor/browser-state'
import { laneKeyForUrl } from '@/lib/price-monitor/shared'
import { readSource } from '@/lib/price-monitor/store'
import { requestPriceChecks } from '@/lib/price-monitor/worker'
import { ScrapeError, scrapeErrorResponse } from '@/lib/scrape-errors'
import { exportInteractiveSessionState } from '@/lib/scrape-interactive'
import { createScrapeOperation } from '@/lib/scrape-operation'
import {
  getVaultAccessState,
  vaultAccessErrorResponse,
} from '@/lib/vault-access'
import { withVaultMutationRequest } from '@/lib/vault-mutation-request'

/**
 * Solve in browser, last step: the person passed the store's check in the
 * window from /api/scrape/interactive/start. Keeps that window's cookies
 * for the store's later checks and queues a check of this source now.
 * Body: { sessionId }.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked
    const { id } = await params
    const body = (await request.json().catch(() => null)) as {
      sessionId?: unknown
    } | null
    const sessionId =
      typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    if (!sessionId)
      return NextResponse.json(
        { error: 'sessionId is required.' },
        { status: 400 },
      )
    if (getVaultAccessState().readOnly)
      return NextResponse.json(
        { error: 'The vault is read-only while a restore runs.' },
        { status: 423 },
      )
    const source = readSource(getLocalDb(), Number(id))
    if (!source || source.removed_at)
      return NextResponse.json({ error: 'Source not found' }, { status: 404 })

    const operation = createScrapeOperation({
      signal: request.signal,
      timeoutMs: 20_000,
    })
    try {
      const exported = await exportInteractiveSessionState(sessionId, operation)
      // Cookies from another store must not land on this one.
      if (laneKeyForUrl(exported.finalUrl) !== source.lane_key)
        throw new ScrapeError(
          'unknown',
          'The browser window ended on another site. Open the product page there, then select Done.',
          409,
        )
      await saveBrowserState(source.lane_key, exported.storageState)
      const queued = await requestPriceChecks([source.id])
      return NextResponse.json(
        { saved: true, queued },
        { status: 202, headers: { 'Cache-Control': 'no-store' } },
      )
    } catch (error) {
      const vaultResponse = vaultAccessErrorResponse(error)
      if (vaultResponse) return vaultResponse
      return scrapeErrorResponse(error)
    } finally {
      operation.dispose()
    }
  })
}
