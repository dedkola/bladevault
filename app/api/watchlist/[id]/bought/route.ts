import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { resolveTargetNotifications } from '@/lib/price-monitor/watchlist'
import { reportServerError } from '@/lib/sentry/server'
import { getStorage } from '@/lib/storage'
import { vaultAccessErrorResponse } from '@/lib/vault-access'
import { withVaultMutationRequest } from '@/lib/vault-mutation-request'

/**
 * "I bought it": the wanted knife joins the collection and keeps its price
 * history and sources. An optional `price` (e.g. "129.00 USD") becomes its
 * purchase price.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked

    const { id } = await params
    let price: string | undefined
    try {
      const body = (await request.json().catch(() => ({}))) as {
        price?: unknown
      }
      if (body.price !== undefined && typeof body.price !== 'string')
        throw new Error('price must be text such as "129.00 USD"')
      price = body.price?.trim().slice(0, 100) || undefined
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Invalid request body'
      return NextResponse.json({ error: message }, { status: 400 })
    }

    try {
      const storage = getStorage()
      const existing = await storage.getKnifeById(id)
      if (!existing)
        return NextResponse.json({ error: 'Knife not found' }, { status: 404 })
      if (!existing.wanted)
        return NextResponse.json(
          { error: 'This knife is already in the collection.' },
          { status: 409 },
        )
      const knife = await storage.moveWantedKnifeToCollection(id, { price })
      await resolveTargetNotifications(id)
      return NextResponse.json({ knife })
    } catch (error) {
      const vaultResponse = vaultAccessErrorResponse(error)
      if (vaultResponse) return vaultResponse
      reportServerError(error, '/api/watchlist/[id]/bought')
      const message = error instanceof Error ? error.message : 'Unknown error'
      return NextResponse.json({ error: message }, { status: 500 })
    }
  })
}
