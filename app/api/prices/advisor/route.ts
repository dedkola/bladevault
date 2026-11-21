import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { runPriceAdvisor } from '@/lib/price-monitor/advisor'
import { NO_STORE, priceAiErrorResponse } from '@/lib/price-monitor/ai-route'
import { vaultAccessErrorResponse } from '@/lib/vault-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SKIPPED: Record<string, { status: number; error: string }> = {
  disabled: {
    status: 409,
    error: 'Turn on AI and the pacing advisor in Settings → Price monitoring.',
  },
  read_only: {
    status: 423,
    error: 'The vault is read-only while a restore runs.',
  },
  busy: { status: 409, error: 'The advisor is already reviewing pacing.' },
  suspended: {
    status: 503,
    error: 'The computer went to sleep during the AI request. Try again.',
  },
  no_data: {
    status: 409,
    error: 'There are no checks from the last 7 days to review yet.',
  },
}

/**
 * Ask AI to review pacing now. Only store host names and statistics are
 * sent. The advice is clamped to the safety bounds before it applies.
 */
export async function POST(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    const result = await runPriceAdvisor({
      trigger: 'manual',
      signal: request.signal,
    })
    if (result.status === 'skipped') {
      const skipped = SKIPPED[result.reason]
      return NextResponse.json(
        { error: skipped.error, reason: result.reason },
        { status: skipped.status },
      )
    }
    if (result.status === 'failed')
      return NextResponse.json(
        { error: result.error, adviceId: result.adviceId },
        { status: 502 },
      )
    return NextResponse.json(
      { adviceId: result.adviceId, advice: result.applied },
      { headers: NO_STORE },
    )
  } catch (error) {
    const vaultResponse = vaultAccessErrorResponse(error)
    if (vaultResponse) return vaultResponse
    return priceAiErrorResponse(error, '/api/prices/advisor')
  }
}
