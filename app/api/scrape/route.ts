import { withVaultMutationRequest } from '@/lib/vault-mutation-request'
import { requireAppUnlock } from '@/lib/app-lock'
import { NextResponse } from 'next/server'
import { isSecurityChallengePage, scrapeAndEnrichProduct } from '@/lib/scrape'
import { fetchExternalUrl, validateExternalUrl } from '@/lib/url-validation'
import {
  ScrapeError,
  scrapeErrorResponse,
  toScrapeError,
} from '@/lib/scrape-errors'
import { createScrapeOperation } from '@/lib/scrape-operation'
import { vaultAccessErrorResponse } from '@/lib/vault-access'
import {
  recordScrapeFailure,
  recordScrapeSuccess,
  type ScrapeRenderer,
} from '@/lib/sentry/scrape-metrics'

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

        const normalizedUrl = validation.url.href
        attemptedUrl = validation.url

        let html: string
        let finalUrl: string
        let screenshot: string | undefined
        let screenshotWarning: string | undefined
        let renderer: ScrapeRenderer = 'browser'

        try {
          const { fetchRenderedHtml } = await import('@/lib/scrape-playwright')
          const rendered = await operation.run(() =>
            fetchRenderedHtml(normalizedUrl, operation),
          )
          html = rendered.html
          finalUrl = rendered.finalUrl
          screenshot = rendered.screenshot
          screenshotWarning = rendered.screenshotWarning
        } catch (renderError) {
          // The fallback shares the remaining budget; it never starts after the
          // request has expired, and cannot replace a confirmed challenge.
          operation.remainingMs()
          if (vaultAccessErrorResponse(renderError)) throw renderError
          const failure = toScrapeError(renderError)
          if (
            ['challenge', 'invalid_url', 'blocked_url', 'cancelled'].includes(
              failure.code,
            )
          )
            throw failure
          const response = await fetchExternalUrl(validation.url, {
            signal: operation.signal,
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
              Accept:
                'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
            },
          })

          html = await operation.run(() => response.text())
          if (isSecurityChallengePage(html)) throw new ScrapeError('challenge')
          if (!response.ok)
            throw new ScrapeError(
              'http',
              `The website returned HTTP ${response.status}. Open the URL in your browser or try again later.`,
            )

          screenshotWarning =
            'Product details were imported using the HTML fallback. A webpage screenshot could not be captured; you can retry from the saved item.'
          finalUrl = response.url || normalizedUrl
          renderer = 'html_fallback'
        }

        const result = await operation.run(() =>
          scrapeAndEnrichProduct(html, finalUrl, normalizedUrl, operation),
        )
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
