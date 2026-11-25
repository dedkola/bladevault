import { isSecurityChallengePage, scrapeAndEnrichProduct } from '@/lib/scrape'
import type { EnrichedScrapeResult } from '@/lib/scrape'
import { ScrapeError, toScrapeError } from '@/lib/scrape-errors'
import type { ScrapeOperation } from '@/lib/scrape-operation'
import { regionCookieHeader } from '@/lib/price-monitor/region'
import { fetchExternalUrl } from '@/lib/url-validation'
import { vaultAccessErrorResponse } from '@/lib/vault-access'

export type RenderedProductPage = {
  html: string
  finalUrl: string
  screenshot?: string
  screenshotWarning?: string
}

/**
 * Renders a product page in a browser. The HTTP app passes the Playwright
 * renderer; callers without one (the stdio MCP bundle) use the HTML fallback.
 */
export type RenderProductPage = (
  url: string,
  operation: ScrapeOperation,
) => Promise<RenderedProductPage>

export type ProductPageScrape = {
  result: EnrichedScrapeResult
  renderer: 'browser' | 'html_fallback'
  screenshot?: string
  screenshotWarning?: string
}

const HTML_FALLBACK_WARNING =
  'Product details were imported using the HTML fallback. A webpage screenshot could not be captured; you can retry from the saved item.'

/**
 * Fetch a validated product URL (browser first, plain HTML as the fallback)
 * and run the scraper with its store enrichments.
 */
export async function scrapeProductPage(
  url: URL,
  operation: ScrapeOperation,
  { renderPage }: { renderPage?: RenderProductPage } = {},
): Promise<ProductPageScrape> {
  let html: string
  let finalUrl: string
  let screenshot: string | undefined
  let screenshotWarning: string | undefined
  let renderer: ProductPageScrape['renderer'] = 'browser'

  try {
    if (!renderPage) throw new ScrapeError('browser')
    const rendered = await operation.run(() => renderPage(url.href, operation))
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
    const response = await fetchExternalUrl(url, {
      signal: operation.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: regionCookieHeader(),
      },
    })

    html = await operation.run(() => response.text())
    if (isSecurityChallengePage(html)) throw new ScrapeError('challenge')
    if (!response.ok)
      throw new ScrapeError(
        'http',
        `The website returned HTTP ${response.status}. Open the URL in your browser or try again later.`,
      )

    screenshotWarning = HTML_FALLBACK_WARNING
    finalUrl = response.url || url.href
    renderer = 'html_fallback'
  }

  const result = await operation.run(() =>
    scrapeAndEnrichProduct(html, finalUrl, url.href, operation),
  )
  return { result, renderer, screenshot, screenshotWarning }
}
