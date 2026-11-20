import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { setWatchTarget, WatchlistError } from '@/lib/price-monitor/watchlist'
import { parseTargetPriceInput } from '@/lib/price-monitor/watchlist-shared'
import { reportServerError } from '@/lib/sentry/server'
import { vaultAccessErrorResponse } from '@/lib/vault-access'
import { withVaultMutationRequest } from '@/lib/vault-mutation-request'

/** Sets (`{ target: { amount, currency } }`) or clears (`null`) a target. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked

    const { id } = await params
    let target
    try {
      const body = (await request.json()) as { target?: unknown }
      if (!body || typeof body !== 'object' || !('target' in body))
        throw new Error('target is required')
      target = parseTargetPriceInput(body.target)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Invalid request body'
      return NextResponse.json({ error: message }, { status: 400 })
    }

    try {
      await setWatchTarget(id, target)
      return NextResponse.json({ target })
    } catch (error) {
      if (error instanceof WatchlistError)
        return NextResponse.json(
          { error: error.message },
          { status: error.status },
        )
      const vaultResponse = vaultAccessErrorResponse(error)
      if (vaultResponse) return vaultResponse
      reportServerError(error, '/api/watchlist/[id]')
      const message = error instanceof Error ? error.message : 'Unknown error'
      return NextResponse.json({ error: message }, { status: 500 })
    }
  })
}
