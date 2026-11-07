import { withVaultMutationRequest } from '@/lib/vault-mutation-request'
import { requireAppUnlock } from '@/lib/app-lock'
import { NextResponse } from 'next/server'
import { isSecurityChallengePage, scrapeAndEnrichProduct } from '@/lib/scrape'
import { validateExternalUrl } from '@/lib/url-validation'
import { ScrapeError, scrapeErrorResponse } from '@/lib/scrape-errors'
import { createScrapeOperation } from '@/lib/scrape-operation'
import { vaultAccessErrorResponse } from '@/lib/vault-access'
import {
  findSavedPageUrl,
  hasProductMarkup,
  isSavedPageLocalImage,
  MAX_SAVED_PAGE_HTML_CHARS,
} from '@/lib/saved-page'

const INVALID_PAGE =
  'Choose a product page saved from your browser as “Webpage, Complete” (.html) or “Webpage, Single File” (.mhtml).'

/**
 * Import product details from HTML the person saved in their own browser, or
 * captured in the desktop app's BladeVault browser (`source: 'browser'`).
 */
export async function POST(request: Request) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked

    const operation = createScrapeOperation({ signal: request.signal })
    try {
      return await operation.run(async () => {
        const body = await operation
          .run(() => request.json())
          .catch((error) => {
            if (error instanceof SyntaxError)
              throw new ScrapeError('invalid_url', INVALID_PAGE)
            throw error
          })
        const html = typeof body?.html === 'string' ? body.html : ''
        if (!html.trim()) throw new ScrapeError('invalid_url', INVALID_PAGE)
        if (html.length > MAX_SAVED_PAGE_HTML_CHARS)
          throw new ScrapeError(
            'invalid_url',
            'This saved page is too large to import. Save only the product page and try again.',
            413,
          )

        const enteredUrl = typeof body?.url === 'string' ? body.url.trim() : ''
        const savedUrl =
          typeof body?.savedUrl === 'string' ? body.savedUrl.trim() : ''
        const pageUrl = enteredUrl || savedUrl || findSavedPageUrl(html)
        if (!pageUrl)
          throw new ScrapeError(
            'invalid_url',
            'The saved page does not include its web address. Paste the product URL above, then import the file again.',
          )
        // The address is used for relative links and optional retailer
        // enrichment, so it must pass the same public-URL rules as scraping.
        const validation = await validateExternalUrl(pageUrl, {
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

        const hasChallengeMarkers = isSecurityChallengePage(html)
        if (hasChallengeMarkers && !hasProductMarkup(html))
          throw new ScrapeError(
            'challenge',
            body?.source === 'browser'
              ? 'The BladeVault browser was still showing the website’s security verification. Open it again, wait until the product page fully loads, then click Continue.'
              : 'This file is the website’s security verification page, not the product. Open the product page in your browser, wait until it fully loads, then save it again.',
          )

        const result = await scrapeAndEnrichProduct(
          html,
          normalizedUrl,
          normalizedUrl,
          operation,
          { allowChallengeMarkers: hasChallengeMarkers },
        )
        result.product.images = result.product.images.filter(
          (src) => !isSavedPageLocalImage(src),
        )
        return NextResponse.json(result)
      })
    } catch (error) {
      return vaultAccessErrorResponse(error) ?? scrapeErrorResponse(error)
    } finally {
      operation.dispose()
    }
  })
}
