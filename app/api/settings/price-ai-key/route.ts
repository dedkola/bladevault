import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { NO_STORE, priceAiErrorResponse } from '@/lib/price-monitor/ai-route'
import {
  clearPriceAiKey,
  getPriceAiKeyStatus,
  PRICE_AI_KEY_ENV,
  writePriceAiKey,
} from '@/lib/price-monitor/secrets'
import { withVaultMutationRequest } from '@/lib/vault-mutation-request'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ROUTE = '/api/settings/price-ai-key'
const MANAGED = `The key is set by ${PRICE_AI_KEY_ENV} on the server. Change it there.`

/** Whether a key is set and its last four characters; never the key. */
export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    return NextResponse.json(
      { key: await getPriceAiKeyStatus() },
      { headers: NO_STORE },
    )
  } catch (error) {
    return priceAiErrorResponse(error, ROUTE)
  }
}

/** Saves the key (write-only). Body: { apiKey }. */
export async function POST(request: Request) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked
    const body = (await request.json().catch(() => null)) as {
      apiKey?: unknown
    } | null
    try {
      if ((await getPriceAiKeyStatus()).source === 'env')
        return NextResponse.json({ error: MANAGED }, { status: 409 })
      return NextResponse.json(
        { key: await writePriceAiKey(body?.apiKey) },
        { headers: NO_STORE },
      )
    } catch (error) {
      return priceAiErrorResponse(error, ROUTE)
    }
  })
}

export async function DELETE(request: Request) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked
    try {
      if ((await getPriceAiKeyStatus()).source === 'env')
        return NextResponse.json({ error: MANAGED }, { status: 409 })
      return NextResponse.json(
        { key: await clearPriceAiKey() },
        { headers: NO_STORE },
      )
    } catch (error) {
      return priceAiErrorResponse(error, ROUTE)
    }
  })
}
