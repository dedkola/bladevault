import * as cheerio from 'cheerio'
import type { Page } from 'playwright'
import { ensureAmazonDelivery } from '@/lib/price-monitor/amazon-location'
import {
  amazonEmptySearchKind,
  amazonProductUrl,
  amazonSearchUrl,
  MAX_SEARCH_CANDIDATES,
  parseAmazonSearchResults,
  type EmptySearchKind,
  type MatchCandidate,
  type ProductPageDetails,
} from '@/lib/price-monitor/discovery-ai'
import { laneKeyForUrl, parseHttpUrl } from '@/lib/price-monitor/shared'
import { extractAmazonProduct } from '@/lib/scrape-amazon'
import {
  amazonDeliveryPostcode,
  OTHER_STORE_LABELS,
  type OtherStoreId,
  type PriceOtherStoresSettings,
} from '@/lib/settings-shared'

/**
 * The stores Other stores can search: how to search them, read their
 * result lists and read a product page for AI to confirm. Everything after
 * that (checks, history, drops) is the ordinary price-source pipeline.
 */
export type DiscoveryCandidate = MatchCandidate & { url: string }

export type DiscoveryStore = {
  id: OtherStoreId
  label: string
  /** Scheduling lane shared with the store's price checks. */
  laneKey: string
  /** Amazon: the marketplace; other stores: their domain. */
  marketplace: (settings: PriceOtherStoresSettings) => string
  searchUrl: (settings: PriceOtherStoresSettings, query: string) => string
  parseResults: (
    html: string,
    pageUrl: string,
    settings: PriceOtherStoresSettings,
  ) => DiscoveryCandidate[]
  /**
   * Whether a search page without products is the store saying it has
   * none. Stores without it: such a page always counts as empty.
   */
  emptySearch?: (html: string) => EmptySearchKind
  productDetails: (html: string, url: string) => ProductPageDetails | null
  /**
   * Runs on each loaded store page before it is read, e.g. Amazon's
   * delivery location. Its cookies are kept for the store's lane.
   */
  preparePage?: (
    page: Page,
    settings: PriceOtherStoresSettings,
  ) => Promise<void>
}

const TITLE_MAX = 250
const DETAILS_MAX = 2500

const clean = (value: string) =>
  value.replace(/[‎‏ ]/g, ' ').replace(/\s+/g, ' ').trim()
const truncate = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value
const PRICE = /(?:[$€£]\s?\d[\d,]*(?:\.\d{2})?)/

function amazonDetails(html: string, url: string): ProductPageDetails | null {
  const product = extractAmazonProduct(cheerio.load(html), url)
  if (!product?.title) return null
  const attributes = [...product.attributes]
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n')
  return {
    title: product.title,
    details: [attributes, product.description].filter(Boolean).join('\n\n'),
  }
}

/**
 * Struck-through prices on a result card (MSRP, "was"): left out so the first
 * price is the one the store sells at. Blade HQ shows "$289.00 $216.75" with
 * the list price crossed out.
 */
const STRUCK_PRICES =
  'del, s, strike, [class*="line-through"], [style*="line-through"]'

/**
 * Product links on a store's search or category page. Header, navigation
 * and footer links are left out; one entry per product with its longest
 * title and the first price shown in its result card.
 */
export function parseStoreProductLinks(
  html: string,
  pageUrl: string,
  isProductPath: (path: string) => boolean,
): DiscoveryCandidate[] {
  const $ = cheerio.load(html)
  const base = parseHttpUrl(pageUrl)
  if (!base) return []
  const lane = laneKeyForUrl(base.href)
  // A search that matched one product can land on its page instead.
  if (isProductPath(base.pathname)) {
    const details = genericProductDetails(html)
    if (!details) return []
    base.search = ''
    base.hash = ''
    return [
      {
        id: 1,
        url: base.href,
        title: details.title,
        price: null,
        sponsored: false,
      },
    ]
  }
  const byUrl = new Map<string, { title: string; price: string | null }>()
  $('a[href]').each((_, el) => {
    const link = $(el)
    if (link.closest('header, nav, footer, [role="navigation"]').length) return
    let url: URL
    try {
      url = new URL(link.attr('href') ?? '', base)
    } catch {
      return
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return
    if (laneKeyForUrl(url.href) !== lane || !isProductPath(url.pathname)) return
    url.search = ''
    url.hash = ''
    const href = url.href
    const title = clean(
      link.text() || link.attr('title') || link.find('img').attr('alt') || '',
    )
    // The nearest ancestor that shows a price and links to this product only.
    let price: string | null = null
    let card = link.parent()
    for (let depth = 0; depth < 6 && card.length && !price; depth += 1) {
      const others = card
        .find('a[href]')
        .toArray()
        .some((a) => {
          try {
            const other = new URL($(a).attr('href') ?? '', base)
            return (
              isProductPath(other.pathname) && other.pathname !== url.pathname
            )
          } catch {
            return false
          }
        })
      if (others) break
      const selling = card.clone()
      selling.find(STRUCK_PRICES).remove()
      price = clean(selling.text()).match(PRICE)?.[0] ?? null
      card = card.parent()
    }
    const previous = byUrl.get(href)
    if (!previous) {
      byUrl.set(href, { title, price })
      return
    }
    if (title.length > previous.title.length) previous.title = title
    previous.price ??= price
  })
  return [...byUrl]
    .filter(([, item]) => item.title.length >= 8)
    .slice(0, MAX_SEARCH_CANDIDATES)
    .map(([url, item], index) => ({
      id: index + 1,
      url,
      title: truncate(item.title, TITLE_MAX),
      price: item.price,
      sponsored: false,
    }))
}

function decodeEntities(value: string): string {
  return cheerio.load(`<p>${value}</p>`)('p').text()
}

function jsonLdProduct($: cheerio.CheerioAPI): Record<string, unknown> | null {
  const visit = (value: unknown): Record<string, unknown> | null => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item)
        if (found) return found
      }
      return null
    }
    if (!value || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    const type = record['@type']
    if (type === 'Product' || (Array.isArray(type) && type.includes('Product')))
      return record
    return visit(record['@graph'])
  }
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    try {
      const found = visit(JSON.parse($(el).text()))
      if (found) return found
    } catch {
      // Broken structured data: try the next block or the page itself.
    }
  }
  return null
}

/** Title and details of an ordinary store product page. */
export function genericProductDetails(html: string): ProductPageDetails | null {
  const $ = cheerio.load(html)
  const product = jsonLdProduct($)
  const text = (value: unknown) =>
    typeof value === 'string' ? clean(decodeEntities(value)) : ''
  const title =
    text(product?.name) ||
    clean($('meta[property="og:title"]').attr('content') ?? '') ||
    clean($('h1').first().text())
  if (!title) return null
  const brand = product?.brand
  const brandName = text(
    brand && typeof brand === 'object'
      ? (brand as Record<string, unknown>).name
      : brand,
  )
  const lines = [
    brandName && `Brand: ${brandName}`,
    text(product?.mpn) && `MPN: ${text(product?.mpn)}`,
    text(product?.sku) && `SKU: ${text(product?.sku)}`,
    text(product?.description) ||
      clean($('meta[name="description"]').attr('content') ?? ''),
  ].filter(Boolean)
  return {
    title: truncate(title, TITLE_MAX),
    details: truncate(lines.join('\n'), DETAILS_MAX),
  }
}

/** www.bladehq.com/item--Spyderco-Para-3-Lightweight--106189 */
const BLADEHQ_PRODUCT = /^\/item--[^/]+--\d+\/?$/i

export const DISCOVERY_STORES: Record<OtherStoreId, DiscoveryStore> = {
  amazon: {
    id: 'amazon',
    label: OTHER_STORE_LABELS.amazon,
    laneKey: 'amazon',
    marketplace: (settings) => settings.amazonMarketplace,
    searchUrl: (settings, query) =>
      amazonSearchUrl(settings.amazonMarketplace, query),
    parseResults: (html, _pageUrl, settings) =>
      parseAmazonSearchResults(html).map((candidate) => ({
        ...candidate,
        url: amazonProductUrl(settings.amazonMarketplace, candidate.asin),
      })),
    emptySearch: amazonEmptySearchKind,
    productDetails: amazonDetails,
    preparePage: (page, settings) =>
      ensureAmazonDelivery(page, amazonDeliveryPostcode(settings)),
  },
  bladehq: {
    id: 'bladehq',
    label: OTHER_STORE_LABELS.bladehq,
    laneKey: 'bladehq.com',
    marketplace: () => 'bladehq.com',
    // A close match redirects to the model's category page; both list
    // products as item-- links.
    searchUrl: (_settings, query) => {
      const url = new URL('https://www.bladehq.com/')
      url.searchParams.set('search', query)
      return url.href
    },
    parseResults: (html, pageUrl) =>
      parseStoreProductLinks(html, pageUrl, (path) =>
        BLADEHQ_PRODUCT.test(path),
      ),
    productDetails: (html) => genericProductDetails(html),
  },
}
