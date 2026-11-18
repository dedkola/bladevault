import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { listAiModels } from '@/lib/price-monitor/ai-client'
import { NO_STORE, priceAiErrorResponse } from '@/lib/price-monitor/ai-route'
import { readPriceAiKey, validatePriceAiKey } from '@/lib/price-monitor/secrets'
import { getSettings } from '@/lib/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Discover models: asks the saved base URL for `/models`, with the stored
 * key or one supplied for this request only (`{ apiKey }`). Returns model
 * ids only. The base URL comes from the saved settings, so a stored key is
 * never sent anywhere else.
 */
export async function POST(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  const body = (await request.json().catch(() => null)) as {
    apiKey?: unknown
  } | null
  try {
    const { baseUrl, headers } = getSettings().priceMonitoring.ai
    if (!baseUrl)
      return NextResponse.json(
        { error: 'Set the AI base URL first.' },
        { status: 400 },
      )
    const apiKey =
      body?.apiKey === undefined || body.apiKey === ''
        ? await readPriceAiKey()
        : validatePriceAiKey(body.apiKey)
    const models = await listAiModels(
      { baseUrl, apiKey, headers },
      { signal: request.signal },
    )
    return NextResponse.json({ models }, { headers: NO_STORE })
  } catch (error) {
    return priceAiErrorResponse(error, '/api/settings/price-ai-models')
  }
}
