import { requireAppUnlock } from '@/lib/app-lock'
import { NextResponse } from 'next/server'
import { getInteractiveSessionStatus } from '@/lib/scrape-interactive'
import { createScrapeOperation } from '@/lib/scrape-operation'
import { scrapeErrorResponse } from '@/lib/scrape-errors'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const locked = requireAppUnlock(_request)
  if (locked) return locked

  const operation = createScrapeOperation({
    signal: _request.signal,
    timeoutMs: 10_000,
  })
  try {
    return await operation.run(async () => {
      const { id } = await params
      const status = await getInteractiveSessionStatus(id, operation)
      return NextResponse.json(status)
    })
  } catch (error) {
    return scrapeErrorResponse(error)
  } finally {
    operation.dispose()
  }
}
