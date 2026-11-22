import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { reportServerError } from '@/lib/sentry/server'
import { vaultAccessErrorResponse } from '@/lib/vault-access'
import { withVaultMutationRequest } from '@/lib/vault-mutation-request'
import { wishlistCommandSchema } from '@/lib/wishlist'
import {
  getWishlist,
  mutateWishlist,
  WishlistError,
} from '@/lib/wishlist-storage'

const NO_STORE = { 'Cache-Control': 'no-store' }

/** Wishlist knives by lane, target prices, price trends and the budget. */
export function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    return NextResponse.json(getWishlist(), { headers: NO_STORE })
  } catch (error) {
    const vaultResponse = vaultAccessErrorResponse(error)
    if (vaultResponse) return vaultResponse
    reportServerError(error, '/api/wishlist')
    return NextResponse.json(
      { error: 'Could not load the wishlist.' },
      { status: 500 },
    )
  }
}

/** Adds, removes, moves and retargets knives, or sets the monthly budget. */
export async function POST(request: Request) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }
    const parsed = wishlistCommandSchema.safeParse(body)
    if (!parsed.success)
      return NextResponse.json(
        {
          error: parsed.error.issues[0]?.message ?? 'Invalid wishlist request.',
        },
        { status: 400 },
      )
    try {
      return NextResponse.json(mutateWishlist(parsed.data), {
        headers: NO_STORE,
      })
    } catch (error) {
      if (error instanceof WishlistError)
        return NextResponse.json(
          { error: error.message },
          { status: error.status },
        )
      if (vaultAccessErrorResponse(error)) throw error
      reportServerError(error, '/api/wishlist')
      return NextResponse.json(
        { error: 'Could not save the wishlist.' },
        { status: 500 },
      )
    }
  })
}
