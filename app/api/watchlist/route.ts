import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { getLocalDb } from '@/lib/local-db'
import { readActiveSources, syncAutoSource } from '@/lib/price-monitor/store'
import { getWatchlist, setWatchTarget } from '@/lib/price-monitor/watchlist'
import { parseTargetPriceInput } from '@/lib/price-monitor/watchlist-shared'
import { requestPriceChecks } from '@/lib/price-monitor/worker'
import { reportServerError } from '@/lib/sentry/server'
import { getStorage } from '@/lib/storage'
import { vaultAccessErrorResponse } from '@/lib/vault-access'
import { withVaultMutationRequest } from '@/lib/vault-mutation-request'

const NO_STORE = { 'Cache-Control': 'no-store' }

const text = (value: unknown, max = 2000) =>
  typeof value === 'string' ? value.trim().slice(0, max) : ''

/** Wanted knives with their best price, gap to target and stock. */
export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    return NextResponse.json(
      { watchlist: await getWatchlist() },
      { headers: NO_STORE },
    )
  } catch (error) {
    const vaultResponse = vaultAccessErrorResponse(error)
    if (vaultResponse) return vaultResponse
    reportServerError(error, '/api/watchlist')
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * Adds a wanted knife: a knife record that stays out of the collection,
 * with an optional target price. Its product link becomes its first price
 * source and is checked at the store's next free slot.
 */
export async function POST(request: Request) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked

    let body: Record<string, unknown>
    let target
    try {
      const parsed = (await request.json()) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Request body must be an object')
      body = parsed as Record<string, unknown>
      if (!text(body.name, 300)) throw new Error('Name is required')
      target =
        body.target === undefined ? null : parseTargetPriceInput(body.target)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Invalid request body'
      return NextResponse.json({ error: message }, { status: 400 })
    }

    try {
      const specs =
        body.specs && typeof body.specs === 'object'
          ? (body.specs as Record<string, unknown>)
          : {}
      const knife = await getStorage().createKnife({
        name: text(body.name, 300),
        brand: text(body.brand, 300),
        bladeStyle: text(body.bladeStyle, 300),
        handleMaterial: text(body.handleMaterial, 300),
        description: text(body.description, 20_000),
        specs: {
          weight: text(specs.weight, 100),
          overallLength: text(specs.overallLength, 100),
          bladeLength: text(specs.bladeLength, 100),
          bladeThickness: text(specs.bladeThickness, 100),
          bladeCoating: text(specs.bladeCoating, 100),
          bladeMaterial: text(specs.bladeMaterial, 100),
          lockingMechanism: text(specs.lockingMechanism, 100),
          designer: text(specs.designer, 100),
          modelNumber: text(specs.modelNumber, 100),
          handleLength: text(specs.handleLength, 100),
          hardness: text(specs.hardness, 100),
          // No purchase price until it is bought.
          price: '',
          country: text(specs.country, 100),
        },
        imageUrls: Array.isArray(body.imageUrls)
          ? body.imageUrls
              .filter((url): url is string => typeof url === 'string')
              .slice(0, 12)
          : [],
        sourceUrl: text(body.sourceUrl),
        pinned: false,
        sold: false,
        wanted: true,
      })
      if (target) await setWatchTarget(knife.id, target)
      await syncAutoSource(knife)
      const sourceIds = readActiveSources(getLocalDb(), knife.id).map(
        (source) => source.id,
      )
      if (sourceIds.length) await requestPriceChecks(sourceIds)
      return NextResponse.json({ knife }, { status: 201, headers: NO_STORE })
    } catch (error) {
      const vaultResponse = vaultAccessErrorResponse(error)
      if (vaultResponse) return vaultResponse
      reportServerError(error, '/api/watchlist')
      const message = error instanceof Error ? error.message : 'Unknown error'
      return NextResponse.json({ error: message }, { status: 500 })
    }
  })
}
