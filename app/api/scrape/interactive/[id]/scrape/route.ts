import { withVaultMutationRequest } from '@/lib/vault-mutation-request'
import { requireAppUnlock } from '@/lib/app-lock'
import { NextResponse } from 'next/server'
import { captureInteractiveSession } from '@/lib/scrape-interactive'
import { scrapeAndEnrichProduct } from '@/lib/scrape'
import { createScrapeOperation } from '@/lib/scrape-operation'
import { scrapeErrorResponse } from '@/lib/scrape-errors'
import { vaultAccessErrorResponse } from '@/lib/vault-access'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withVaultMutationRequest(_request, async () => {
    const locked = requireAppUnlock(_request)
    if (locked) return locked

    const operation = createScrapeOperation({ signal: _request.signal })
    try {
      return await operation.run(async () => {
        const { id } = await params
        const { html, finalUrl, screenshot, screenshotWarning } =
          await captureInteractiveSession(id, operation)
        const result = await scrapeAndEnrichProduct(
          html,
          finalUrl,
          finalUrl,
          operation,
        )
        if (screenshot) result.product.images.push(screenshot)
        return NextResponse.json({ ...result, screenshotWarning })
      })
    } catch (error) {
      return vaultAccessErrorResponse(error) ?? scrapeErrorResponse(error)
    } finally {
      operation.dispose()
    }
  })
}
