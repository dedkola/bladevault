import * as cheerio from 'cheerio'
import {
  MAX_SEARCH_CANDIDATES,
  type MatchCandidate,
  type ProductPageDetails,
} from '@/lib/price-monitor/discovery-ai'
import { laneKeyForUrl, parseHttpUrl } from '@/lib/price-monitor/shared'
import { OTHER_STORE_LABELS, type OtherStoreId } from '@/lib/settings-shared'

/**
 * The stores Other stores can search: how to search them, read their
 * result lists and read a product page for AI to confirm. Everything after
 * that (checks, history, drops) is the ordinary price-source pipeline.
 * Amazon is not one: it forbids automated AI access.
 */
export type DiscoveryCandidate = MatchCandidate & { url: string }

export type DiscoveryStore = {
  id: OtherStoreId
  label: string
  /** Scheduling lane shared with the store's price checks. */
  laneKey: string
  /** The store's domain; with the store, the key of its search records. */
  marketplace: string
  searchUrl: (query: string) => string
  parseResults: (html: string, pageUrl: string) => DiscoveryCandidate[]
  productDetails: (html: string, url: string) => ProductPageDetails | null
}

const TITLE_MAX = 250
const DETAILS_MAX = 2500

const clean = (value: string) =>
  value.replace(/[‎‏ ]/g, ' ').replace(/\s+/g, ' ').trim()
const truncate = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value
const PRICE = /(?:[$€£]\s?\d[\d,]*(?:\.\d{2})?)/

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

/**
 * Some stores (SMKW) put a percent-encoded description in their structured
 * data ("The%20Spyderco%20Para%203…"). Text without escapes, or with a broken
 * one, is kept as it is.
 */
function decodePercentEscapes(value: string): string {
  if (!/%[0-9A-F]{2}/i.test(value) || /\s/.test(value)) return value
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Title and details of an ordinary store product page. */
export function genericProductDetails(html: string): ProductPageDetails | null {
  const $ = cheerio.load(html)
  const product = jsonLdProduct($)
  const text = (value: unknown) =>
    typeof value === 'string'
      ? clean(decodeEntities(decodePercentEscapes(value)))
      : ''
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

/** A page that is itself a product (a search that matched one product). */
function isProductPage($: cheerio.CheerioAPI): boolean {
  return (
    ($('meta[property="og:type"]').attr('content') ?? '').toLowerCase() ===
    'product'
  )
}

/**
 * BigCommerce result cards: SMKW (with Searchspring) and DLT Trading.
 * Product and category URLs are both one-segment slugs
 * (smkw.com/spyderco-para-3-…, dlttrading.com/spyderco-para-3), so results
 * are read from the result cards, never from every link on the page. SMKW's
 * card data-product-price is the selling price; DLT Trading shows
 * "Our Price", MSRP and "Was" as separate elements, and only Our Price is
 * kept.
 */
export function parseSmkwResults(
  html: string,
  pageUrl: string,
): DiscoveryCandidate[] {
  const $ = cheerio.load(html)
  const base = parseHttpUrl(pageUrl)
  if (!base) return []
  const lane = laneKeyForUrl(base.href)
  if (isProductPage($)) {
    const details = genericProductDetails(html)
    if (!details) return []
    base.search = ''
    base.hash = ''
    return [{ id: 1, url: base.href, title: details.title, price: null }]
  }
  const byUrl = new Map<string, { title: string; price: string | null }>()
  $('article.card').each((_, el) => {
    const card = $(el)
    if (card.closest('header, nav, footer, [role="navigation"]').length) return
    let url: URL
    try {
      url = new URL(
        card
          .find('.card-title a[href], a.card-figure__link[href]')
          .first()
          .attr('href') ?? '',
        base,
      )
    } catch {
      return
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return
    if (laneKeyForUrl(url.href) !== lane || url.pathname === '/') return
    url.search = ''
    url.hash = ''
    const title = clean(
      card.attr('data-name') ||
        card.find('.card-title').first().text() ||
        card.find('img').first().attr('alt') ||
        '',
    )
    const amount = Number.parseFloat(card.attr('data-product-price') ?? '')
    let price: string | null = null
    if (Number.isFinite(amount) && amount > 0) price = `$${amount.toFixed(2)}`
    else {
      const selling = card.clone()
      selling
        .find(
          `${STRUCK_PRICES}, .price--rrp, .price--non-sale, .rrp-price--withoutTax, .non-sale-price--withoutTax`,
        )
        .remove()
      price = clean(selling.text()).match(PRICE)?.[0] ?? null
    }
    if (!byUrl.has(url.href)) byUrl.set(url.href, { title, price })
  })
  return [...byUrl]
    .filter(([, item]) => item.title.length >= 8)
    .slice(0, MAX_SEARCH_CANDIDATES)
    .map(([url, item], index) => ({
      id: index + 1,
      url,
      title: truncate(item.title, TITLE_MAX),
      price: item.price,
    }))
}

/**
 * SMKW puts a brand prefix in front of most SKUs (SPC223GP for Spyderco
 * C223GP, BM535BK2 for Benchmade 535BK2) and often leaves the maker's
 * number out of the title. The SKU without that prefix is added so the
 * model-number check and AI can see the maker's number.
 */
export function smkwProductDetails(html: string): ProductPageDetails | null {
  const details = genericProductDetails(html)
  if (!details) return null
  const sku = details.details.match(
    /^SKU: ([A-Z]{2})([A-Z0-9][A-Z0-9.\-]{3,})$/im,
  )
  if (!sku || !/\d/.test(sku[2])) return details
  return {
    ...details,
    details: truncate(
      `${details.details}\nSKU without SMKW's brand prefix ${sku[1]}: ${sku[2]}`,
      DETAILS_MAX,
    ),
  }
}

export const DISCOVERY_STORES: Record<OtherStoreId, DiscoveryStore> = {
  bladehq: {
    id: 'bladehq',
    label: OTHER_STORE_LABELS.bladehq,
    laneKey: 'bladehq.com',
    marketplace: 'bladehq.com',
    // A close match redirects to the model's category page; both list
    // products as item-- links.
    searchUrl: (query) => {
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
  smkw: {
    id: 'smkw',
    label: OTHER_STORE_LABELS.smkw,
    laneKey: 'smkw.com',
    marketplace: 'smkw.com',
    // Results are rendered by Searchspring in the browser.
    searchUrl: (query) => {
      const url = new URL('https://smkw.com/shop/')
      url.searchParams.set('search_query', query)
      return url.href
    },
    parseResults: (html, pageUrl) => parseSmkwResults(html, pageUrl),
    productDetails: (html) => smkwProductDetails(html),
  },
  dlttrading: {
    id: 'dlttrading',
    label: OTHER_STORE_LABELS.dlttrading,
    laneKey: 'dlttrading.com',
    marketplace: 'dlttrading.com',
    // BigCommerce search; its SKU is the maker's model number (C223PBK).
    searchUrl: (query) => {
      const url = new URL('https://www.dlttrading.com/search.php')
      url.searchParams.set('search_query', query)
      return url.href
    },
    parseResults: (html, pageUrl) => parseSmkwResults(html, pageUrl),
    productDetails: (html) => genericProductDetails(html),
  },
}
