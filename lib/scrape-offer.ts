import type { CheerioAPI } from 'cheerio'
import {
  normalizeCurrencyCode,
  parseMoneyText,
} from '@/lib/price-monitor/money'

/**
 * Price and stock status of the product a page sells. Price monitoring reads
 * this; Add-from-link keeps using the same JSON-LD offer selection through
 * `selectJsonLdOffer`, so both agree on which offer belongs to the page.
 */
export const OFFER_AVAILABILITIES = [
  'in_stock',
  'limited',
  'preorder',
  'out_of_stock',
  'unknown',
] as const
export type OfferAvailability = (typeof OFFER_AVAILABILITIES)[number]

export type OfferMethod =
  | 'jsonld'
  | 'microdata'
  | 'meta'
  | 'shopify'
  // Price monitoring's optional AI fallback (lib/price-monitor/ai.ts).
  | 'ai'

export type ExtractedOffer = {
  /** Major units, e.g. 129.99; null when the page shows no price. */
  amount: number | null
  /** ISO 4217 code, or '' when the page does not say. */
  currency: string
  availability: OfferAvailability
  method: OfferMethod
}

function cleanText(text: string | undefined): string {
  return text?.replace(/\s+/g, ' ').trim() ?? ''
}

function metaContent($: CheerioAPI, names: string[]): string {
  for (const name of names) {
    const value =
      $(`meta[property="${name}"]`).attr('content') ??
      $(`meta[name="${name}"]`).attr('content')
    if (value) return cleanText(value)
  }
  return ''
}

/**
 * Parse a JSON-LD script, tolerating the invalid `\'` escape that some
 * shop templates emit for apostrophes in descriptions.
 */
export function parseJsonLd(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (error) {
    const repaired = raw.replace(/(?<!\\)((?:\\\\)*)\\'/g, "$1'")
    if (repaired === raw) throw error
    return JSON.parse(repaired)
  }
}

/** The storefront's selected currency (Shopify presentment, data attributes, meta). */
export function extractActiveCurrency($: CheerioAPI): string {
  const html = $.html()
  return (
    html.match(/Shopify\.currency\s*=\s*\{[^}]*"active":"([A-Z]{3})"/i)?.[1] ||
    $('[data-currency]')
      .filter((_, el) => /^[A-Z]{3}$/.test($(el).attr('data-currency') || ''))
      .first()
      .attr('data-currency') ||
    metaContent($, ['product:price:currency', 'og:price:currency'])
  ).toUpperCase()
}

/**
 * Picks the JSON-LD offer for the page: the one whose URL carries the page's
 * `?variant=` when present, otherwise the first. Throws for an invalid
 * `sourceUrl`, as callers already guard each JSON-LD script.
 */
export function selectJsonLdOffer<T>(
  offers: readonly T[],
  sourceUrl?: string,
): T | undefined {
  const requestedVariant = sourceUrl
    ? new URL(sourceUrl).searchParams.get('variant')
    : null
  return (
    (requestedVariant
      ? offers.find((candidate) => {
          try {
            return (
              new URL(
                (candidate as { url?: string })?.url || '',
                sourceUrl,
              ).searchParams.get('variant') === requestedVariant
            )
          } catch {
            return false
          }
        })
      : undefined) || offers[0]
  )
}

/**
 * Maps schema.org availability (URL or bare name) and common feed or meta
 * wording such as "in stock" or "oos" to an OfferAvailability.
 */
export function normalizeAvailability(value: unknown): OfferAvailability {
  if (typeof value !== 'string') return 'unknown'
  const token = value
    .trim()
    .replace(/^https?:\/\/schema\.org\//i, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
  switch (token) {
    case 'instock':
    case 'onlineonly':
    case 'available':
    case 'availablefororder':
      return 'in_stock'
    case 'limitedavailability':
    case 'instoreonly':
      return 'limited'
    case 'preorder':
    case 'presale':
    case 'backorder':
      return 'preorder'
    case 'outofstock':
    case 'soldout':
    case 'discontinued':
    case 'oos':
    case 'unavailable':
      return 'out_of_stock'
    default:
      return 'unknown'
  }
}

type JsonLdNode = Record<string, unknown>

function hasType(node: JsonLdNode, name: string): boolean {
  return [node['@type']].flat().includes(name)
}

function asNodes(value: unknown): JsonLdNode[] {
  return [value]
    .flat()
    .filter(
      (item): item is JsonLdNode =>
        Boolean(item) && typeof item === 'object' && !Array.isArray(item),
    )
}

/** Offers of a product, with AggregateOffer expanded into its own offers. */
function productOffers(node: JsonLdNode): JsonLdNode[] {
  return asNodes(node.offers).flatMap((offer) => {
    const nested = hasType(offer, 'AggregateOffer') ? asNodes(offer.offers) : []
    return nested.length ? nested : [offer]
  })
}

function offerPriceValue(offer: JsonLdNode): {
  price: string
  currency: string
} {
  const direct = offer.price ?? offer.lowPrice
  if (direct !== undefined && direct !== null && direct !== '') {
    return {
      price: String(direct),
      currency:
        typeof offer.priceCurrency === 'string' ? offer.priceCurrency : '',
    }
  }
  for (const spec of asNodes(offer.priceSpecification)) {
    if (spec.price !== undefined && spec.price !== null && spec.price !== '') {
      return {
        price: String(spec.price),
        currency:
          typeof spec.priceCurrency === 'string'
            ? spec.priceCurrency
            : typeof offer.priceCurrency === 'string'
              ? offer.priceCurrency
              : '',
      }
    }
  }
  return { price: '', currency: '' }
}

function toOffer(
  price: string,
  currencyHint: string,
  availability: OfferAvailability,
  method: OfferMethod,
): ExtractedOffer | null {
  const parsed = price ? parseMoneyText(price, currencyHint) : null
  if (!parsed && availability === 'unknown') return null
  return {
    amount: parsed?.amount ?? null,
    currency: normalizeCurrencyCode(parsed?.currency ?? currencyHint),
    availability,
    method,
  }
}

function extractJsonLdOffer(
  $: CheerioAPI,
  pageUrl: string,
): ExtractedOffer | null {
  const activeCurrency = extractActiveCurrency($)
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    let data: unknown
    try {
      data = parseJsonLd($(script).html() ?? '')
    } catch {
      continue
    }
    for (const item of asNodes(data)) {
      const graph = Array.isArray(item['@graph']) ? asNodes(item['@graph']) : []
      for (const node of graph.length ? graph : [item]) {
        let offers: JsonLdNode[] = []
        if (hasType(node, 'Product')) {
          offers = productOffers(node)
        } else if (hasType(node, 'ProductGroup')) {
          offers = asNodes(node.hasVariant).flatMap(productOffers)
        }
        if (!offers.length) continue
        let offer: JsonLdNode | undefined
        try {
          offer = selectJsonLdOffer(offers, pageUrl)
        } catch {
          offer = offers[0]
        }
        if (!offer) continue
        const { price, currency } = offerPriceValue(offer)
        const result = toOffer(
          price,
          activeCurrency || currency,
          normalizeAvailability(offer.availability),
          'jsonld',
        )
        if (result) return result
      }
    }
  }
  return null
}

function extractMicrodataOffer($: CheerioAPI): ExtractedOffer | null {
  // Only the first Product item: related-product tiles come later in the page.
  const product = $('[itemscope][itemtype]')
    .filter((_, el) =>
      /schema\.org\/Product/i.test($(el).attr('itemtype') ?? ''),
    )
    .first()
  if (!product.length) return null
  const offer = product.find('[itemprop="offers"]').first()
  const scope = offer.length ? offer : product
  const read = (prop: string) => {
    const el = scope.find(`[itemprop="${prop}"]`).first()
    if (!el.length) return ''
    return cleanText(el.attr('content') ?? el.attr('href') ?? el.text())
  }
  return toOffer(
    read('price') || read('lowPrice'),
    extractActiveCurrency($) || read('priceCurrency'),
    normalizeAvailability(read('availability')),
    'microdata',
  )
}

function extractMetaOffer($: CheerioAPI): ExtractedOffer | null {
  return toOffer(
    metaContent($, ['product:price:amount', 'og:price:amount']),
    extractActiveCurrency($),
    normalizeAvailability(
      metaContent($, [
        'product:availability',
        'og:availability',
        'og:product:availability',
      ]),
    ),
    'meta',
  )
}

/**
 * Deterministic offer extraction from a product page: JSON-LD, then
 * microdata, then Open Graph meta.
 * A source that has the price but no stock status borrows the status from
 * the next source that has one.
 */
export function extractOffer(
  $: CheerioAPI,
  pageUrl: string,
): ExtractedOffer | null {
  const candidates = [
    extractJsonLdOffer($, pageUrl),
    extractMicrodataOffer($),
    extractMetaOffer($),
  ].filter((offer): offer is ExtractedOffer => offer !== null)
  const primary =
    candidates.find((offer) => offer.amount !== null) ?? candidates[0]
  if (!primary) return null
  if (primary.availability !== 'unknown') return primary
  const availability =
    candidates.find((offer) => offer.availability !== 'unknown')
      ?.availability ?? 'unknown'
  return { ...primary, availability }
}

/** `/products/<handle>.js`: Shopify's storefront JSON with cents and stock. */
export function getShopifyProductJsUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    const pattern = /\/products\/([^/.]+)\/?$/
    if (!pattern.test(parsed.pathname)) return undefined
    parsed.pathname = parsed.pathname.replace(pattern, '/products/$1.js')
    parsed.search = ''
    parsed.hash = ''
    return parsed.href
  } catch {
    return undefined
  }
}

/**
 * Reads a Shopify product from either `/products/<handle>.js` (prices in
 * cents, per-variant `available`) or `/products/<handle>.json` (decimal
 * prices, no stock status). The page's `?variant=` wins; otherwise the first
 * available variant, as the storefront preselects it.
 */
export function extractShopifyOffer(
  json: unknown,
  sourceUrl: string,
  currencyHint = '',
): ExtractedOffer | null {
  if (!json || typeof json !== 'object') return null
  const wrapped = (json as { product?: unknown }).product
  const isJsonEndpoint = Boolean(wrapped && typeof wrapped === 'object')
  const product = (isJsonEndpoint ? wrapped : json) as Record<string, unknown>
  const variants = asNodes(product.variants)
  if (!variants.length) return null

  let requested: string | null = null
  try {
    requested = new URL(sourceUrl).searchParams.get('variant')
  } catch {
    // Fall back to the default variant.
  }
  const variant =
    (requested
      ? variants.find((candidate) => String(candidate.id) === requested)
      : undefined) ??
    (isJsonEndpoint
      ? undefined
      : variants.find((candidate) => candidate.available === true)) ??
    variants[0]

  const rawPrice = variant.price
  let amount: number | null = null
  if (isJsonEndpoint) {
    amount = parseMoneyText(String(rawPrice ?? ''))?.amount ?? null
  } else if (typeof rawPrice === 'number' && rawPrice > 0) {
    amount = rawPrice / 100
  } else if (typeof rawPrice === 'string' && /^\d+$/.test(rawPrice)) {
    amount = Number(rawPrice) / 100 || null
  }
  const availability: OfferAvailability =
    typeof variant.available === 'boolean'
      ? variant.available
        ? 'in_stock'
        : 'out_of_stock'
      : 'unknown'
  if (amount === null && availability === 'unknown') return null
  return {
    amount,
    currency: normalizeCurrencyCode(currencyHint),
    availability,
    method: 'shopify',
  }
}
