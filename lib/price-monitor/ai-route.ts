import { NextResponse } from 'next/server'
import { AiClientError } from '@/lib/price-monitor/ai-client'
import { PriceAiKeyError } from '@/lib/price-monitor/secrets'
import { reportServerError } from '@/lib/sentry/server'

/** JSON error responses for the price AI routes; messages never hold the key. */
export function priceAiErrorResponse(error: unknown, route: string) {
  if (error instanceof PriceAiKeyError)
    return NextResponse.json({ error: error.message }, { status: 400 })
  if (error instanceof AiClientError)
    return NextResponse.json(
      { error: error.message, code: error.code },
      {
        status:
          error.code === 'config' ? 400 : error.code === 'budget' ? 429 : 502,
      },
    )
  reportServerError(error, route)
  return NextResponse.json({ error: 'The AI request failed.' }, { status: 500 })
}

export const NO_STORE = { 'Cache-Control': 'no-store' } as const
