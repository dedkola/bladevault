import * as cheerio from 'cheerio'
import { isSecurityChallengePage, isShopifyProductPage } from '@/lib/scrape'
import { ScrapeError } from '@/lib/scrape-errors'
import {
  extractOffer,
  extractShopifyOffer,
  getShopifyProductJsUrl,
  type ExtractedOffer,
} from '@/lib/scrape-offer'
import type { ScrapeOperation } from '@/lib/scrape-operation'
import type {
  BrowserStorageState,
  RenderOptions,
  RenderedPage,
} from '@/lib/scrape-playwright'
import { fetchExternalUrl } from '@/lib/url-validation'
import { normalizeCurrencyCode } from '@/lib/price-monitor/money'
import {
  getShopifyCartJsUrl,
  regionCookieHeader,
  withRegionCookies,
} from '@/lib/price-monitor/region'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

export type PageCheck = {
  offer: ExtractedOffer | null
  finalUrl: string
  /** Detected from the page: lets later HTTP checks use Shopify's .js. */
  isShopify: boolean
  /** The page's HTML, for the AI fallback; absent for Shopify's JSON. */
  html?: string
}

export type BrowserPageCheck = PageCheck & {
  /** The offer read from the raw server HTML, for learning HTTP. */
  serverOffer: ExtractedOffer | null
  storageState?: BrowserStorageState
}

export function extractOfferFromHtml(
  html: string,
  pageUrl: string,
): ExtractedOffer | null {
  return extractOffer(cheerio.load(html), pageUrl)
}

/** Same price, currency and stock status: the raw HTML is enough. */
export function offersMatch(
  rendered: ExtractedOffer | null,
  server: ExtractedOffer | null,
): boolean {
  return Boolean(
    rendered &&
    server &&
    rendered.amount !== null &&
    rendered.amount === server.amount &&
    rendered.currency === server.currency &&
    rendered.availability === server.availability,
  )
}

/** Upstream HTTP status from a ScrapeError message such as "HTTP 403". */
export function upstreamStatus(error: unknown): number | null {
  if (!(error instanceof Error)) return null
  const match = error.message.match(/\bHTTP (\d{3})\b/)
  return match ? Number(match[1]) : null
}

async function httpGet(
  url: string,
  operation: ScrapeOperation,
  accept: string,
): Promise<{ body: string; finalUrl: string }> {
  const response = await operation.run(() =>
    fetchExternalUrl(new URL(url), {
      signal: operation.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: accept,
        'Accept-Language': 'en-US,en;q=0.9',
        // Ask for the US edition in USD, whatever country the IP is in.
        Cookie: regionCookieHeader(),
      },
    }),
  )
  const body = await operation.run(() => response.text())
  if (isSecurityChallengePage(body)) throw new ScrapeError('challenge')
  if (!response.ok)
    throw Object.assign(
      new ScrapeError('http', `The store returned HTTP ${response.status}.`),
      { retryAfter: response.headers?.get?.('retry-after') ?? null },
    )
  return { body, finalUrl: response.url || url }
}

/**
 * The currency Shopify presents prices in for our US cookies: `.js` product
 * data carries amounts only. Null when the cart cannot be read.
 */
async function readShopifyCurrency(
  url: string,
  operation: ScrapeOperation,
): Promise<string | null> {
  const cartUrl = getShopifyCartJsUrl(url)
  if (!cartUrl) return null
  try {
    const { body } = await httpGet(cartUrl, operation, 'application/json')
    const cart = JSON.parse(body) as { currency?: unknown }
    return normalizeCurrencyCode(cart?.currency) || null
  } catch (error) {
    if (operation.signal.aborted) throw error
    return null
  }
}

/**
 * One plain HTTP request: Shopify's `/products/<handle>.js` for known Shopify
 * sources (plus its cart for the currency), otherwise the product page itself.
 */
export async function checkViaHttp(
  url: string,
  operation: ScrapeOperation,
  options: { shopify: boolean; currencyHint: string },
): Promise<PageCheck> {
  const jsUrl = options.shopify ? getShopifyProductJsUrl(url) : undefined
  if (jsUrl) {
    const { body } = await httpGet(jsUrl, operation, 'application/json')
    let json: unknown
    try {
      json = JSON.parse(body)
    } catch {
      throw new ScrapeError('invalid_response')
    }
    const currency = await readShopifyCurrency(url, operation)
    return {
      offer: extractShopifyOffer(json, url, currency ?? options.currencyHint),
      finalUrl: url,
      isShopify: true,
    }
  }
  const { body, finalUrl } = await httpGet(
    url,
    operation,
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  )
  return {
    offer: extractOfferFromHtml(body, finalUrl),
    finalUrl,
    isShopify: isShopifyProductPage(finalUrl, body),
    html: body,
  }
}

/** A Playwright render in light mode, without the webpage screenshot. */
export async function checkViaBrowser(
  url: string,
  operation: ScrapeOperation,
  options: {
    storageState?: BrowserStorageState
    headless?: boolean
    budgetMs?: number
    interact?: RenderOptions['interact']
  },
): Promise<BrowserPageCheck> {
  const { fetchRenderedHtml } = await import('@/lib/scrape-playwright')
  const page: RenderedPage = await fetchRenderedHtml(url, operation, {
    screenshot: false,
    light: true,
    captureServerHtml: true,
    captureStorageState: true,
    storageState: withRegionCookies(url, options.storageState),
    headless: options.headless,
    budgetMs: options.budgetMs,
    interact: options.interact,
  })
  return {
    offer: extractOfferFromHtml(page.html, page.finalUrl),
    serverOffer: page.serverHtml
      ? extractOfferFromHtml(page.serverHtml, page.finalUrl)
      : null,
    finalUrl: page.finalUrl,
    isShopify: isShopifyProductPage(page.finalUrl, page.html),
    storageState: page.storageState,
    html: page.html,
  }
}

/** Docker ships Xvfb: a headed retry can pass checks that block headless. */
export function headedRetryAvailable(): boolean {
  return (
    process.env.BLADEVAULT_DOCKER_RUNTIME === '1' &&
    Boolean(process.env.DISPLAY)
  )
}
