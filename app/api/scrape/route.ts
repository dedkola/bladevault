import { withVaultMutationRequest } from '@/lib/vault-mutation-request'
import { requireAppUnlock } from '@/lib/app-lock'
import { NextResponse } from 'next/server'
import { validateExternalUrl } from '@/lib/url-validation'
import { ScrapeError, scrapeErrorResponse } from '@/lib/scrape-errors'
import { createScrapeOperation } from '@/lib/scrape-operation'
import { vaultAccessErrorResponse } from '@/lib/vault-access'
import {
  recordScrapeFailure,
  recordScrapeSuccess,
} from '@/lib/sentry/scrape-metrics'
import { scrapeProductPage } from '@/lib/services/product-scrape-service'
import { renderProductPageInBrowser } from '@/lib/services/product-page-browser'

export async function POST(request: Request) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked

    const operation = createScrapeOperation({ signal: request.signal })
    let attemptedUrl: URL | undefined
    try {
      return await operation.run(async () => {
        const body = await operation
          .run(() => request.json())
          .catch((error) => {
            if (error instanceof SyntaxError)
              throw new ScrapeError('invalid_url')
            throw error
          })
        const url = typeof body?.url === 'string' ? body.url.trim() : ''

        if (!url) throw new ScrapeError('invalid_url')

        const validation = await validateExternalUrl(url, {
          signal: operation.signal,
        })
        if (!validation.ok) {
          throw new ScrapeError(
            validation.code ??
              (validation.reason.includes('Private')
                ? 'blocked_url'
                : 'invalid_url'),
            validation.reason,
          )
        }

        attemptedUrl = validation.url

        const { result, renderer, screenshot, screenshotWarning } =
          await scrapeProductPage(validation.url, operation, {
            renderPage: renderProductPageInBrowser,
            // Photos behind the page's bot check download in its browser.
            inlineImages: true,
          })
        if (screenshot) result.product.images.push(screenshot)
        recordScrapeSuccess('url', attemptedUrl, result, renderer)
        return NextResponse.json({ ...result, screenshotWarning })
      })
    } catch (error) {
      const vaultResponse = vaultAccessErrorResponse(error)
      if (vaultResponse) return vaultResponse
      recordScrapeFailure('url', attemptedUrl, error)
      return scrapeErrorResponse(error)
    } finally {
      operation.dispose()
    }
  })
}
