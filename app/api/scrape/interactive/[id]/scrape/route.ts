import { withVaultMutationRequest } from '@/lib/vault-mutation-request'
import { requireAppUnlock } from '@/lib/app-lock'
import { NextResponse } from 'next/server'
import { captureInteractiveSession } from '@/lib/scrape-interactive'
import { scrapeAndEnrichProduct } from '@/lib/scrape'
import {
  inlineBrowserImages,
  type BrowserImageSession,
} from '@/lib/scrape-browser-images'
import { createScrapeOperation } from '@/lib/scrape-operation'
import { scrapeErrorResponse } from '@/lib/scrape-errors'
import { vaultAccessErrorResponse } from '@/lib/vault-access'
import {
  recordScrapeFailure,
  recordScrapeSuccess,
} from '@/lib/sentry/scrape-metrics'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withVaultMutationRequest(_request, async () => {
    const locked = requireAppUnlock(_request)
    if (locked) return locked

    const operation = createScrapeOperation({ signal: _request.signal })
    let attemptedUrl: string | undefined
    let imageSession: BrowserImageSession | undefined
    try {
      return await operation.run(async () => {
        const { id } = await params
        const capture = await captureInteractiveSession(id, operation, {
          keepBrowserForImages: true,
        })
        const { html, finalUrl, screenshot, screenshotWarning } = capture
        imageSession = capture.imageSession
        attemptedUrl = finalUrl
        const result = await scrapeAndEnrichProduct(
          html,
          finalUrl,
          finalUrl,
          operation,
        )
        if (imageSession && Array.isArray(result.product.images)) {
          // Photos behind the page's bot check download in its browser.
          result.product.images = await inlineBrowserImages(
            result.product.images,
            imageSession.fetchImages,
            operation,
          )
        }
        if (screenshot) result.product.images.push(screenshot)
        recordScrapeSuccess('interactive', attemptedUrl, result)
        return NextResponse.json({ ...result, screenshotWarning })
      })
    } catch (error) {
      const vaultResponse = vaultAccessErrorResponse(error)
      if (vaultResponse) return vaultResponse
      recordScrapeFailure('interactive', attemptedUrl, error)
      return scrapeErrorResponse(error)
    } finally {
      await imageSession?.close()
      operation.dispose()
    }
  })
}
