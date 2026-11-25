import { withRegionCookies } from '@/lib/price-monitor/region'
import type { ScrapeOperation } from '@/lib/scrape-operation'
import type { RenderedProductPage } from '@/lib/services/product-scrape-service'

/**
 * Render a product page with Playwright, asking for the store's US edition in
 * USD whatever the IP country, so imported prices match price checks.
 * Imported lazily so bundles without a browser (the stdio MCP CLI) skip it.
 */
export async function renderProductPageInBrowser(
  url: string,
  operation: ScrapeOperation,
  options: { screenshot?: boolean } = {},
): Promise<RenderedProductPage> {
  const { fetchRenderedHtml } = await import('@/lib/scrape-playwright')
  return fetchRenderedHtml(url, operation, {
    storageState: withRegionCookies(url, undefined),
    screenshot: options.screenshot,
  })
}
