import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { parsePriceWatchUpdate } from '@/lib/price-monitor/shared'
import {
  applyPriceWatchUpdate,
  buildPriceWatchView,
  PriceWatchError,
  syncAutoSource,
} from '@/lib/price-monitor/store'
import { reportServerError } from '@/lib/sentry/server'
import { getSettings } from '@/lib/settings'
import { getStorage } from '@/lib/storage'
import { vaultAccessErrorResponse } from '@/lib/vault-access'
import { withVaultMutationRequest } from '@/lib/vault-mutation-request'

const NO_STORE = { 'Cache-Control': 'no-store' }

/** A knife's price monitoring mode, sources and eligibility. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const locked = requireAppUnlock(request)
  if (locked) return locked

  try {
    const { id } = await params
    const knife = await getStorage().getKnifeById(id)
    if (!knife)
      return NextResponse.json({ error: 'Knife not found' }, { status: 404 })
    // Keep the auto source in line with the product link; a read-only vault
    // (restore running) still answers with what is stored.
    await syncAutoSource(knife).catch((error) => {
      if (!vaultAccessErrorResponse(error)) throw error
    })
    return NextResponse.json(
      { watch: buildPriceWatchView(knife, getSettings().priceMonitoring) },
      { headers: NO_STORE },
    )
  } catch (error) {
    const vaultResponse = vaultAccessErrorResponse(error)
    if (vaultResponse) return vaultResponse
    reportServerError(error, '/api/knives/[id]/price-watch')
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** Changes the mode, and adds, edits, pauses or removes sources. */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked

    const { id } = await params
    let update
    try {
      update = parsePriceWatchUpdate(await request.json())
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Invalid request body'
      return NextResponse.json({ error: message }, { status: 400 })
    }
    try {
      const knife = await getStorage().getKnifeById(id)
      if (!knife)
        return NextResponse.json({ error: 'Knife not found' }, { status: 404 })
      await applyPriceWatchUpdate(knife, update)
      return NextResponse.json(
        { watch: buildPriceWatchView(knife, getSettings().priceMonitoring) },
        { headers: NO_STORE },
      )
    } catch (error) {
      if (error instanceof PriceWatchError)
        return NextResponse.json(
          { error: error.message },
          { status: error.status },
        )
      if (vaultAccessErrorResponse(error)) throw error
      reportServerError(error, '/api/knives/[id]/price-watch')
      const message = error instanceof Error ? error.message : 'Unknown error'
      return NextResponse.json({ error: message }, { status: 500 })
    }
  })
}
