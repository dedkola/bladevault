import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { getLocalDb } from '@/lib/local-db'
import {
  PRICE_EXPORT_KINDS,
  priceExportChunks,
  priceExportFilename,
  type PriceExportKind,
} from '@/lib/price-monitor/export'
import { HISTORY_RANGES, type HistoryRange } from '@/lib/price-monitor/insights'
import { reportServerError } from '@/lib/sentry/server'
import { vaultAccessErrorResponse } from '@/lib/vault-access'

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 })
}

/**
 * Price history as CSV: ?kind=snapshots|events&knifeId=…&range=7d|1m|3m|6m|1y|all.
 * Without knifeId every knife with price history is exported; the range
 * defaults to all history.
 */
export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    const params = new URL(request.url).searchParams
    const kind = (params.get('kind') ?? 'snapshots') as PriceExportKind
    if (!PRICE_EXPORT_KINDS.includes(kind))
      return badRequest('kind must be snapshots or events')
    const range = (params.get('range') ?? 'all') as HistoryRange
    if (!HISTORY_RANGES.includes(range))
      return badRequest('range must be 7d, 1m, 3m, 6m, 1y or all')
    const knifeId = params.get('knifeId')?.trim() || null

    const database = getLocalDb()
    let knife: { brand: string; name: string } | null = null
    if (knifeId) {
      knife =
        (database
          .prepare('SELECT brand, name FROM knives WHERE id = ?')
          .get(knifeId) as { brand: string; name: string } | undefined) ?? null
      if (!knife)
        return NextResponse.json({ error: 'Knife not found' }, { status: 404 })
    }

    const chunks = priceExportChunks(database, { kind, knifeId, range })
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        try {
          const next = chunks.next()
          if (next.done) controller.close()
          else controller.enqueue(encoder.encode(next.value))
        } catch (error) {
          reportServerError(error, '/api/prices/export')
          controller.error(error)
        }
      },
      cancel() {
        chunks.return(undefined)
      },
    })
    return new Response(body, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${priceExportFilename(kind, knife, range)}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    const vaultResponse = vaultAccessErrorResponse(error)
    if (vaultResponse) return vaultResponse
    reportServerError(error, '/api/prices/export')
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
