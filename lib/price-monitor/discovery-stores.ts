import * as cheerio from 'cheerio'
import {
  MAX_SEARCH_CANDIDATES,
  type MatchCandidate,
  type ProductPageDetails,
} from '@/lib/price-monitor/discovery-ai'
import { laneKeyForUrl, parseHttpUrl } from '@/lib/price-monitor/shared'
import { extractAmazonProduct } from '@/lib/scrape-amazon'
import { OTHER_STORE_LABELS, type OtherStoreId } from '@/lib/settings-shared'

/**
 * The stores Other stores can search: how to search them, read their
 * result lists and read a product page for AI to confirm. Everything after
 * that (checks, history, drops) is the ordinary price-source pipeline.
 * Shopify stores (KnifeJoy, Northwest Knives) are searched and read through
 * their JSON, and Amazon over plain HTTP with a US delivery session, instead
 * of a rendered page.
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
  /**
   * Shopify stores are searched and read through their JSON with plain
   * HTTP (search suggestions, `/products/<handle>.js`), not the browser.
   */
  shopify?: boolean
  /** The store's own minimum gap between two searches (a slower pace). */
  searchGapMs?: number
  /**
   * Whether a search page without products is the store saying it has
   * none. Stores without it: such a page always counts as empty.
   */
  emptySearch?: (html: string) => EmptySearchKind
}

/**
 * Why a search page gave AI nothing to read. 'empty': the store's own result
 * list with no products in it. 'unreadable': not a result list (a sign-in,
 * error or location page) or product cards BladeVault could not read. Only
 * an empty page means the knife is not there.
 */
export type EmptySearchKind = 'empty' | 'unreadable'

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
/**
 * Stores glue the brand's first letters onto the maker's number in their
 * SKU: DLT Trading and Blade HQ list Vosteed A4501 as VOSA4501 and CIVIVI
 * C19046-1 as CIVC190461. That prefix is split off (only when it is the
 * start of the brand's name) so the model-number check and AI see the
 * maker's number. `brand` may be the page title when the page names no
 * brand; its first word is the brand there.
 */
export function withoutBrandPrefix(
  sku: string,
  brand: string,
): { prefix: string; code: string } | null {
  const letters = (brand.trim().split(/\s+/)[0] ?? '')
    .replace(/[^\p{L}]/gu, '')
    .toUpperCase()
  const upper = sku.trim().toUpperCase()
  for (const length of [4, 3, 2]) {
    if (letters.length < length) continue
    const prefix = letters.slice(0, length)
    if (!upper.startsWith(prefix)) continue
    const code = sku.trim().slice(length)
    if (/^[A-Z0-9][A-Z0-9.\-]{2,}$/i.test(code) && /\d/.test(code))
      return { prefix: sku.trim().slice(0, length), code }
  }
  return null
}

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
  const sku = text(product?.sku)
  const unprefixed = withoutBrandPrefix(sku, brandName || title)
  const lines = [
    brandName && `Brand: ${brandName}`,
    text(product?.mpn) && `MPN: ${text(product?.mpn)}`,
    sku && `SKU: ${sku}`,
    unprefixed &&
      `SKU without the store's brand prefix ${unprefixed.prefix}: ${unprefixed.code}`,
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

/** Shopify product links: /products/<handle>, also under a collection. */
const SHOPIFY_PRODUCT = /^(?:\/collections\/[^/]+)?\/products\/[^/.]+\/?$/i

/** Small Shopify stores: at most one Other stores search in this time. */
export const SHOPIFY_SEARCH_GAP_MS = 15 * 60_000
/** Amazon: one search per 5 minutes. */
export const AMAZON_SEARCH_GAP_MS = 5 * 60_000

/** Shopify's product search suggestions as JSON (no page, no browser). */
export function shopifySearchUrl(origin: string, query: string): string {
  const url = new URL('/search/suggest.json', origin)
  url.searchParams.set('q', query)
  url.searchParams.set('resources[type]', 'product')
  url.searchParams.set('resources[limit]', '10')
  return url.href
}

/** Shopify money as text: "159.95" in search suggestions. */
function shopifyPrice(value: unknown): string | null {
  const amount =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(amount) || amount <= 0) return null
  return `$${amount.toFixed(2)}`
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function htmlText(value: unknown): string {
  return typeof value === 'string' ? clean(decodeEntities(value)) : ''
}

/**
 * Shopify search suggestions (`/search/suggest.json`): one candidate per
 * product at its selling price, linked as `/products/<handle>` without the
 * search's tracking parameters. A storefront page (a search that came back
 * as HTML) is read for its product links instead.
 */
export function parseShopifySearch(
  body: string,
  pageUrl: string,
): DiscoveryCandidate[] {
  const base = parseHttpUrl(pageUrl)
  if (!base) return []
  const json = parseJson(body) as
    { resources?: { results?: { products?: unknown } } } | null | undefined
  if (json === undefined)
    return parseStoreProductLinks(body, pageUrl, (path) =>
      SHOPIFY_PRODUCT.test(path),
    )
  const products = json?.resources?.results?.products
  if (!Array.isArray(products)) return []
  const lane = laneKeyForUrl(base.href)
  const byUrl = new Map<string, { title: string; price: string | null }>()
  for (const item of products) {
    if (!item || typeof item !== 'object') continue
    const product = item as Record<string, unknown>
    const handle = typeof product.handle === 'string' ? product.handle : ''
    let url: URL
    try {
      url = handle
        ? new URL(`/products/${encodeURIComponent(handle)}`, base)
        : new URL(String(product.url ?? ''), base)
    } catch {
      continue
    }
    if (laneKeyForUrl(url.href) !== lane) continue
    if (!SHOPIFY_PRODUCT.test(url.pathname)) continue
    url.search = ''
    url.hash = ''
    let title = htmlText(product.title)
    const vendor = htmlText(product.vendor)
    // The brand helps AI when the store leaves it out of the title.
    if (vendor && !title.toLowerCase().includes(vendor.toLowerCase()))
      title = `${vendor} ${title}`
    if (!byUrl.has(url.href))
      byUrl.set(url.href, { title, price: shopifyPrice(product.price) })
  }
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
 * A Shopify product from `/products/<handle>.js`: title, vendor as brand,
 * the variants' SKUs (often the maker's model number, sometimes behind the
 * store's brand prefix) and the description. A product page reached in the
 * browser (AI browsing the store) is read as an ordinary page.
 */
export function shopifyProductDetails(body: string): ProductPageDetails | null {
  const json = parseJson(body)
  if (json === undefined) return genericProductDetails(body)
  if (!json || typeof json !== 'object') return null
  const wrapped = (json as { product?: unknown }).product
  const product = (
    wrapped && typeof wrapped === 'object' ? wrapped : json
  ) as Record<string, unknown>
  const title = htmlText(product.title)
  if (!title) return null
  const brand = htmlText(product.vendor)
  const variants = (
    Array.isArray(product.variants) ? product.variants : []
  ).filter(
    (variant): variant is Record<string, unknown> =>
      Boolean(variant) && typeof variant === 'object',
  )
  const skus = [...new Set(variants.map((variant) => htmlText(variant.sku)))]
    .filter(Boolean)
    .slice(0, 5)
  const options = variants
    .map((variant) => htmlText(variant.title))
    .filter((name) => name && name !== 'Default Title')
    .slice(0, 5)
  const lines = [
    brand && `Brand: ${brand}`,
    ...skus.flatMap((sku) => {
      const unprefixed = withoutBrandPrefix(sku, brand || title)
      return [
        `SKU: ${sku}`,
        unprefixed &&
          `SKU without the store's brand prefix ${unprefixed.prefix}: ${unprefixed.code}`,
      ]
    }),
    options.length > 0 && `Variants: ${options.join('; ')}`,
    htmlText(product.description),
  ].filter(Boolean)
  return {
    title: truncate(title, TITLE_MAX),
    details: truncate(lines.join('\n'), DETAILS_MAX),
  }
}

/** A Shopify store searched through its JSON at a slow pace. */
function shopifyStore(
  id: OtherStoreId,
  origin: string,
  laneKey: string,
): DiscoveryStore {
  return {
    id,
    label: OTHER_STORE_LABELS[id],
    laneKey,
    marketplace: laneKey,
    shopify: true,
    searchGapMs: SHOPIFY_SEARCH_GAP_MS,
    searchUrl: (query) => shopifySearchUrl(origin, query),
    parseResults: (body, pageUrl) => parseShopifySearch(body, pageUrl),
    productDetails: (body) => shopifyProductDetails(body),
  }
}

const ASIN = /^[A-Z0-9]{10}$/
/** Amazon puts the ad label in the title heading: "Sponsored Ad - Corgi V…". */
const SPONSORED_PREFIX = /^Sponsored Ad\s*[-–—]\s*/i
const SPONSORED_LABEL = /\bSponsored\b/i

/**
 * A search result's title. Amazon often shows the brand in its own heading
 * ("KIZER") above the product title heading, so every heading is read: the
 * longest one is the title, and the brand goes in front when it is missing.
 */
function amazonResultTitle(
  $: cheerio.CheerioAPI,
  block: ReturnType<cheerio.CheerioAPI>,
): string {
  const headings = block
    .find('h2')
    .toArray()
    .map((el) =>
      clean($(el).attr('aria-label') || $(el).text()).replace(
        SPONSORED_PREFIX,
        '',
      ),
    )
    .filter(Boolean)
  const title = headings.reduce(
    (longest, text) => (text.length > longest.length ? text : longest),
    '',
  )
  if (!title)
    return clean(
      block.find('[data-cy="title-recipe"]').first().text() ||
        block.find('img.s-image').first().attr('alt') ||
        '',
    )
  const lower = title.toLowerCase()
  const brand = headings.find(
    (text) =>
      text !== title &&
      text.length <= 40 &&
      !lower.includes(text.toLowerCase()),
  )
  return brand ? `${brand} ${title}` : title
}

function amazonSponsored(
  $: cheerio.CheerioAPI,
  block: ReturnType<cheerio.CheerioAPI>,
): boolean {
  return (
    SPONSORED_LABEL.test(
      clean(
        block
          .find(
            '.puis-label-popover, .s-label-popover-default, .puis-sponsored-label-text',
          )
          .text(),
      ),
    ) ||
    block
      .find('h2')
      .toArray()
      .some((el) =>
        SPONSORED_PREFIX.test(clean($(el).attr('aria-label') || $(el).text())),
      )
  )
}

/**
 * Products on an amazon.com search results page, without sponsored ones:
 * the product link (`/dp/<ASIN>`), title and shown price. Falls back to
 * product links when the result blocks are missing (other layouts).
 */
export function parseAmazonSearchResults(
  html: string,
  pageUrl: string,
): DiscoveryCandidate[] {
  const $ = cheerio.load(html)
  const origin = parseHttpUrl(pageUrl)?.origin ?? 'https://www.amazon.com'
  const found: Array<Omit<DiscoveryCandidate, 'id'>> = []
  const seen = new Set<string>()
  $('[data-component-type="s-search-result"][data-asin]').each((_, el) => {
    const block = $(el)
    const asin = (block.attr('data-asin') ?? '').trim().toUpperCase()
    if (!ASIN.test(asin) || seen.has(asin)) return
    seen.add(asin)
    if (amazonSponsored($, block)) return
    const title = amazonResultTitle($, block)
    if (!title) return
    const price = clean(
      block.find('.a-price:not(.a-text-price) .a-offscreen').first().text(),
    )
    found.push({
      url: `${origin}/dp/${asin}`,
      title: truncate(title, TITLE_MAX),
      price: price || null,
    })
  })
  if (!found.length && !seen.size) {
    $('a[href*="/dp/"]').each((_, el) => {
      const href = $(el).attr('href') ?? ''
      const asin = href
        .match(/\/dp\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1]
        ?.toUpperCase()
      const title = clean($(el).text())
      if (!asin || seen.has(asin) || title.length < 12) return
      seen.add(asin)
      found.push({
        url: `${origin}/dp/${asin}`,
        title: truncate(title, TITLE_MAX),
        price: null,
      })
    })
  }
  return found
    .slice(0, MAX_SEARCH_CANDIDATES)
    .map((candidate, index) => ({ ...candidate, id: index + 1 }))
}

/**
 * Amazon's search page keeps its result list when nothing matches ("No
 * results for your search query") and shows products as cards with an ASIN.
 * Other boxes in the list, such as Shop Direct offers, are not cards.
 */
export function amazonEmptySearchKind(html: string): EmptySearchKind {
  const $ = cheerio.load(html)
  const list = $('[data-component-type="s-search-results"]')
  if (!list.length) return 'unreadable'
  const cards = list
    .find('[data-component-type="s-search-result"], .s-main-slot > [data-asin]')
    .toArray()
    .some((el) => ASIN.test(($(el).attr('data-asin') ?? '').trim()))
  return cards ? 'unreadable' : 'empty'
}

/** An Amazon product page for AI to confirm: title, spec rows, bullets. */
export function amazonProductDetails(
  html: string,
  url: string,
): ProductPageDetails | null {
  const product = extractAmazonProduct(cheerio.load(html), url)
  if (!product?.title) return null
  const attributes = [...product.attributes]
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n')
  return {
    title: truncate(product.title, TITLE_MAX),
    details: truncate(
      [attributes, product.description].filter(Boolean).join('\n\n'),
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
  knifejoy: shopifyStore('knifejoy', 'https://knifejoy.com', 'knifejoy.com'),
  northwestknives: shopifyStore(
    'northwestknives',
    'https://northwestknives.com',
    'northwestknives.com',
  ),
  amazon: {
    id: 'amazon',
    label: OTHER_STORE_LABELS.amazon,
    // One lane for every Amazon marketplace, shared with its price checks.
    laneKey: 'amazon',
    marketplace: 'amazon.com',
    // At least 5 minutes between searches (the shared minimum); a search
    // reads the results page and one product page, 2.5 s apart.
    searchGapMs: AMAZON_SEARCH_GAP_MS,
    searchUrl: (query) => {
      const url = new URL('https://www.amazon.com/s')
      url.searchParams.set('k', query)
      return url.href
    },
    parseResults: (html, pageUrl) => parseAmazonSearchResults(html, pageUrl),
    emptySearch: amazonEmptySearchKind,
    productDetails: (html, url) => amazonProductDetails(html, url),
  },
}
