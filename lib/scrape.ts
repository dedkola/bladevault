import * as cheerio from 'cheerio'

export type ScrapedProduct = {
  name: string
  brand: string
  description: string
  images: string[]
  bladeStyle: string
  handleMaterial: string
  specs: {
    weight: string
    overallLength: string
    bladeLength: string
    bladeThickness: string
    bladeCoating: string
    bladeMaterial: string
    lockingMechanism: string
    designer: string
    modelNumber: string
    handleLength: string
    hardness: string
    price: string
    country: string
  }
  sourceUrl: string
}

export type ScrapeConfidence = {
  name: boolean
  brand: boolean
  description: boolean
  images: boolean
  bladeStyle: boolean
  handleMaterial: boolean
  specs: {
    weight: boolean
    overallLength: boolean
    bladeLength: boolean
    bladeThickness: boolean
    bladeCoating: boolean
    bladeMaterial: boolean
    lockingMechanism: boolean
    designer: boolean
    modelNumber: boolean
    handleLength: boolean
    hardness: boolean
    price: boolean
    country: boolean
  }
}

export type ScrapeResult = {
  product: ScrapedProduct
  confidence: ScrapeConfidence
}

function resolveUrl(
  href: string | undefined,
  base: string,
): string | undefined {
  if (!href) return undefined
  try {
    return new URL(href, base).href
  } catch {
    return href.startsWith('http') ? href : undefined
  }
}

// Detect Cloudflare and other bot/security challenge interstitials so we can
// surface a helpful error instead of parsing the challenge page as a product.
export function isSecurityChallengePage(html: string): boolean {
  if (!html || html.length < 100) return false
  const normalized = html.toLowerCase()
  const markers = [
    'just a moment...',
    'challenges.cloudflare.com',
    'enable javascript and cookies',
    'performing security verification',
    'security service to protect against malicious bots',
    'checking your browser before accessing',
    'ddos protection by cloudflare',
    'please wait while we verify',
    'please turn javascript on',
    'please enable cookies',
    '/_guard/',
    'interstitial?continue',
  ]
  return markers.some((marker) => normalized.includes(marker))
}

export type EnrichedScrapeResult = ScrapeResult & {
  html: string
  finalUrl: string
}

export async function scrapeAndEnrichProduct(
  html: string,
  finalUrl: string,
  sourceUrl?: string,
): Promise<EnrichedScrapeResult> {
  if (isSecurityChallengePage(html)) {
    throw new Error(
      'This retailer is showing a security verification page (bot protection). BladeVault cannot automatically scrape this URL. Try adding the knife manually, or paste the product details into the form.',
    )
  }

  const { product, confidence } = scrapeProduct(html, finalUrl, sourceUrl)

  // Shopify stores expose a .json endpoint with all product images and metadata.
  // Use it to augment the rendered-page data when available.
  if (isShopifyProductPage(finalUrl, html)) {
    const jsonUrl = getShopifyJsonUrl(finalUrl)
    if (jsonUrl) {
      try {
        const jsonResponse = await fetch(jsonUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            Accept: 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        })

        if (jsonResponse.ok) {
          const json = await jsonResponse.json()
          const shopifyProduct = extractShopifyProduct(json)
          if (shopifyProduct) {
            if (shopifyProduct.name) product.name = shopifyProduct.name
            if (shopifyProduct.brand) product.brand = shopifyProduct.brand
            if (shopifyProduct.description)
              product.description = shopifyProduct.description
            if (shopifyProduct.images?.length)
              product.images = shopifyProduct.images
          }
        }
      } catch {
        // Ignore Shopify JSON fetch errors and fall back to rendered-page data.
      }
    }
  }

  return { product, confidence, html, finalUrl }
}

function cleanText(text: string | undefined): string {
  return text?.replace(/\s+/g, ' ').trim() ?? ''
}

function cleanValue(text: string | undefined): string {
  return cleanText(text).replace(/[.,;:]+$/g, '')
}

function normalizeText(text: string): string {
  return text
    .replace(/[\u00A0\u202F\u2007]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Same as normalizeText but preserves newlines so line-based spec parsing works.
function normalizeMultilineText(text: string): string {
  return text
    .replace(/[\u00A0\u202F\u2007]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Extract text from an element while converting <br> and block-level
// boundaries into newlines. Cheerio's .text() collapses <br> to nothing,
// which joins consecutive spec lines into one unusable string.
function elementTextWithBreaks(
  $: cheerio.CheerioAPI,
  el: Parameters<cheerio.CheerioAPI>[0] | cheerio.CheerioAPI,
): string {
  const $el = $(el as any)
  const html = $el.html()
  if (!html) return $el.text()
  return htmlToPlainText(html)
}

function findMeta($: cheerio.CheerioAPI, names: string[]): string {
  for (const name of names) {
    const value =
      $(`meta[property="${name}"]`).attr('content') ??
      $(`meta[name="${name}"]`).attr('content')
    if (value) return cleanText(value)
  }
  return ''
}

function extractJsonLdBrandValue(node: Record<string, unknown>): string {
  const candidates: unknown[] = []
  for (const key of ['brand', 'manufacturer']) {
    const value = node[key]
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      candidates.push(...value)
    } else {
      candidates.push(value)
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      return cleanText(candidate)
    }
    if (typeof candidate === 'object' && candidate !== null) {
      const obj = candidate as Record<string, unknown>
      const name =
        typeof obj.name === 'string'
          ? cleanText(obj.name)
          : typeof obj.value === 'string'
            ? cleanText(obj.value)
            : ''
      if (name) return name
    }
  }
  return ''
}

function extractJsonLdProduct($: cheerio.CheerioAPI): Partial<ScrapedProduct> {
  const result: Partial<ScrapedProduct> = {}
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html() ?? ''
      const data = JSON.parse(raw)
      const candidates = Array.isArray(data) ? data : [data]
      for (const item of candidates) {
        const graph = item['@graph']
        const items = graph && Array.isArray(graph) ? graph : [item]
        for (const node of items) {
          const type = node?.['@type']
          if (
            type === 'Product' ||
            (Array.isArray(type) && type.includes('Product'))
          ) {
            result.name = result.name || cleanText(node.name)
            result.brand = result.brand || extractJsonLdBrandValue(node)
            result.description =
              result.description || htmlToPlainText(node.description)
            if (node.image) {
              const images = Array.isArray(node.image)
                ? node.image
                : [node.image]
              result.images = images
                .map((img: unknown) =>
                  typeof img === 'string'
                    ? img
                    : (img as { url?: string })?.url,
                )
                .filter(
                  (img: unknown): img is string =>
                    typeof img === 'string' && img.length > 0,
                )
            }
          }
        }
      }
    } catch {
      // ignore malformed JSON-LD
    }
  })
  return result
}

function extractTitle($: cheerio.CheerioAPI): string {
  return (
    findMeta($, ['og:title', 'twitter:title']) ||
    cleanText($('h1').first().text()) ||
    cleanText($('title').text())
  )
}

function cleanProductName(name: string, sourceUrl: string): string {
  let cleaned = cleanText(name)
  if (!cleaned) return cleaned

  // Remove common trailing site/marketing suffixes used by manufacturer sites.
  const suffixPatterns = [
    /\s*[»|]\s*.*$/,
    /\s*-\s*(?:Official Site|OFFICIAL SITE|Home|Shop|Store)$/i,
    /\s*\|\s*(?:Spyderco|Benchmade|Buck|Microtech|Chris Reeve|Victorinox|Böker|Boker|Morakniv|Fällkniven|Fallkniven|Fox|LionSteel|Extrema Ratio|CIVIVI|WE|Kizer)$/i,
  ]
  for (const pattern of suffixPatterns) {
    cleaned = cleaned.replace(pattern, '').trim()
  }

  // Strip the domain-derived brand from the end of the title if it appears
  // as a site suffix (e.g. "F1 (Elmax-stål) - Fällkniven").
  const domainBrand = extractBrandFromDomain(sourceUrl)
  if (domainBrand) {
    const escaped = domainBrand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    cleaned = cleaned
      .replace(new RegExp(`\\s*[-|]\\s*${escaped}$`, 'i'), '')
      .trim()
  }

  return cleaned
}

function htmlToPlainText(html: string): string {
  if (!html) return ''

  const $ = cheerio.load(html)
  $('script, style, noscript, template').remove()
  $('br').replaceWith('\n')
  $('p, div, li, h1, h2, h3, h4, h5, h6').each((_, element) => {
    $(element).append('\n')
  })

  return (
    $.root()
      .text()
      // Normalize whitespace while preserving paragraph breaks.
      .replace(/\r\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/ {2,}/g, ' ')
      .trim()
  )
}

function extractDescription($: cheerio.CheerioAPI): string {
  const meta = findMeta($, [
    'og:description',
    'twitter:description',
    'description',
  ])

  // Site-specific description containers take precedence over the meta
  // description because they are usually the full product description.
  const descriptionSelectors = [
    '.woocommerce-product-details__short-description',
    '.woocommerce-product-description',
    '.product-description',
    '#product-description',
    '#tab-description',
    '.productView-desc',
    '.product-detail-description',
    '[data-product-description]',
    '.product__description',
  ]
  for (const selector of descriptionSelectors) {
    const $el = $(selector).first()
    if ($el.length) {
      const text = elementTextWithBreaks($, $el as any)
      if (text && text.trim().length > 20) {
        return htmlToPlainText(text)
      }
    }
  }

  if (meta) return htmlToPlainText(meta)

  const paragraphs = $('p')
    .filter((_, el) => $(el).text().trim().length > 30)
    .slice(0, 3)
    .map((_, el) => $(el).text().trim())
    .get()
  if (paragraphs.length > 0) {
    return htmlToPlainText(paragraphs.join('\n\n'))
  }

  return ''
}

function isThumbnailUrl(url: string): boolean {
  // WordPress/WooCommerce resized images: name-150x150.jpg or -960x384.png
  // Shopify CDN crops: ?v=...&width=100 or _100x.jpg
  return (
    /-\d+x\d+\.[^/.]+$/.test(url) ||
    /[?&](width|height|w|h)=\d{2,3}\b/.test(url)
  )
}

function preferFullSizeImage(url: string): string {
  // Strip WordPress dimension suffix to recover the original file when possible.
  const withoutDims = url.replace(/-(\d+x\d+)(\.[^/.]+)$/, '$2')
  if (withoutDims !== url) return withoutDims
  // Strip Shopify width/height query params while keeping the cache-busting v param.
  try {
    const parsed = new URL(url)
    if (parsed.searchParams.has('width') || parsed.searchParams.has('height')) {
      parsed.searchParams.delete('width')
      parsed.searchParams.delete('height')
      return parsed.href
    }
  } catch {
    // ignore invalid URLs
  }
  return url
}

function extractImages($: cheerio.CheerioAPI, baseUrl: string): string[] {
  const seen = new Set<string>()
  const images: string[] = []

  const add = (href: string | undefined, preferFull = true) => {
    let resolved = resolveUrl(href, baseUrl)
    if (!resolved || seen.has(resolved)) return
    if (preferFull) {
      const full = preferFullSizeImage(resolved)
      if (full !== resolved && !seen.has(full)) {
        resolved = full
      }
    }
    // Skip obvious thumbnails unless we have no other images.
    if (isThumbnailUrl(resolved) && images.length > 0) return
    seen.add(resolved)
    images.push(resolved)
  }

  findMeta($, ['og:image', 'twitter:image'])
    .split(',')
    .forEach((href) => add(href, false))

  const imageSelectors = [
    '[data-main-image] img',
    '.product-image img',
    '.product__image img',
    '#product-image img',
    '.woocommerce-product-gallery__image img',
    '.woocommerce-product-gallery__wrapper img',
    '.flex-active-slide img',
    '.flex-control-nav img',
    '.wp-post-image',
    '.attachment-woocommerce_single',
    '.product-gallery img',
    '[data-media-id] img',
    '.product__media img',
    '.product-photo img',
    '.pdp-image img',
    '.image-gallery-image img',
    '.slick-active img',
    '.zoomImg',
    '#bigpic',
    '.js-qv-product-cover',
    '.product-cover img',
    '[data-image] img',
  ]

  $(imageSelectors.join(', ')).each((_, el) => {
    const $el = $(el)
    add(
      $el.attr('data-large_image') ||
        $el.attr('data-zoom-image') ||
        $el.attr('data-src') ||
        $el.attr('data-lazy-src') ||
        $el.attr('src') ||
        $el.attr('data-zoom') ||
        $el.attr('srcset')?.split(',')[0]?.trim().split(' ')[0],
    )
  })

  $('img').each((_, el) => {
    const $el = $(el)
    const src =
      $el.attr('data-large_image') ||
      $el.attr('data-zoom-image') ||
      $el.attr('data-src') ||
      $el.attr('data-lazy-src') ||
      $el.attr('src')
    if (src && /product|knife|blade|item/i.test(src)) {
      add(src)
    }
  })

  return images
}

const RETAILER_NAMES =
  /\bAmazon\b|Blade HQ|Knife Center|GP Knives|DLT Trading|KnifeWorks|KnivesPlus|Knife Art|KnifeJoy|NC Blade|Southern Edges|House of Blades|New Graham Knives|True North Knives|Steel Addiction|USA Made Blade/i

function normalizeBrandName(brand: string): string {
  const normalizations: Record<string, string> = {
    'microtech gear': 'Microtech',
    'microtech knives': 'Microtech',
    'mtk inc.': 'Microtech',
    mtknives: 'Microtech',
    milgov: 'Microtech',
    'milgov, inc.': 'Microtech',
    'spyderco knives': 'Spyderco',
    'chris reeve knives': 'Chris Reeve',
    'chris reeve knives, inc.': 'Chris Reeve',
    'bark river knives': 'Bark River',
    'buck knives': 'Buck',
    'buck knives, inc.': 'Buck',
    'case knives': 'Case',
    'demko knives': 'Demko',
    'fox knives': 'Fox',
    'fox cutlery': 'Fox',
    'hogue knives': 'Hogue',
    'kizer knives': 'Kizer',
    'kizer cutlery': 'Kizer',
    'we knife': 'WE',
    'we knife co': 'WE',
    'we knife co.': 'WE',
    'we knife co ltd': 'WE',
    weknife: 'WE',
    civivi: 'CIVIVI',
    lionsteel: 'LionSteel',
    'lion steel': 'LionSteel',
    'mora knives': 'Morakniv',
    'mora of sweden': 'Morakniv',
    morakniv: 'Morakniv',
    fallkniven: 'Fällkniven',
    fällkniven: 'Fällkniven',
    'fallkniven ab': 'Fällkniven',
    'extrema ratio': 'Extrema Ratio',
    victorinox: 'Victorinox',
    'victorinox ag': 'Victorinox',
    benchmade: 'Benchmade',
    'benchmade knife co.': 'Benchmade',
    'benchmade knife company': 'Benchmade',
    boker: 'Böker',
    böker: 'Böker',
    'boker plus': 'Böker Plus',
    'böker plus': 'Böker Plus',
    'böker solingen': 'Böker',
  }
  return normalizations[brand.toLowerCase()] ?? brand
}

function cleanBrand(text: string): string {
  const cleaned = cleanText(text)
    .replace(/\s+/g, ' ')
    .replace(/(?:store|shop|official)\s*$/i, '')
    .trim()
  return normalizeBrandName(cleaned)
}

function extractBrandFromAmazon($: cheerio.CheerioAPI): string {
  // Amazon's byline info: "Kershaw", "Visit the Kershaw Store", or "by Kershaw".
  const rawByline = cleanText($('#bylineInfo').first().text())
  if (rawByline) {
    const m =
      rawByline.match(/visit the\s+(.+?)\s+(?:store|shop)/i) ||
      rawByline.match(/^by\s+(.+)$/i)
    const byline = cleanBrand(m?.[1] ?? rawByline)
    if (byline && !RETAILER_NAMES.test(byline)) {
      return byline
    }
  }

  // Amazon product details tables label the brand row.
  const detailSelectors = [
    '#productDetails_detailBullets_sections1 tr',
    '#productDetails_techSpec_section_1 tr',
    '.a-keyvalue tr',
    'table tr',
  ]
  for (const selector of detailSelectors) {
    let found = ''
    $(selector).each((_, row) => {
      if (found) return
      const $row = $(row)
      const label = cleanText(
        $row.find('td.a-text-bold, th, td:first-child').first().text(),
      )
      if (/^brand$/i.test(label) || /^manufacturer$/i.test(label)) {
        found = cleanBrand($row.find('td').last().text())
      }
    })
    if (found && !isRetailerBrand(found)) return found
  }

  // Amazon "product overview" feature lists key/value pairs including Brand.
  const overview = $(
    '[data-feature-name="productOverview"], #productOverview_feature_div',
  )
  let overviewBrand = ''
  overview.find('div, span, tr, li').each((_, el) => {
    if (overviewBrand) return
    const text = normalizeMultilineText(elementTextWithBreaks($, el as any))
    // Some overviews use "Brand: Value", others just "Brand Value" with inline spans.
    const match = text.match(/brand\s*[:\uFF1A]?\s*(.{1,80}?)(?:\n|$)/i)
    if (match) {
      overviewBrand = cleanBrand(match[1])
    }
  })
  if (overviewBrand && !RETAILER_NAMES.test(overviewBrand)) return overviewBrand

  return ''
}

function isRetailerBrand(brand: string): boolean {
  return RETAILER_NAMES.test(brand)
}

function extractBrandFromLabeledElements($: cheerio.CheerioAPI): string {
  const rowSelectors = [
    'table tr',
    'table tbody tr',
    'dl div',
    '.spec-row',
    '.product-spec',
    '.product-attribute',
    '.product-data-row',
    '.woocommerce-product-attributes-item',
    '.pdp-specs-row',
    '.specifications-row',
  ]
  const labelSelectors =
    'th, dt, .spec-label, [class*="label"], [class*="title"], .attribute-label'
  const valueSelectors =
    'td, dd, .spec-value, [class*="value"], [class*="data"], .attribute-value'

  let found = ''
  $(rowSelectors.join(', ')).each((_, row) => {
    if (found) return
    const $row = $(row)
    const label = cleanText($row.find(labelSelectors).first().text())
    if (/^brand$/i.test(label) || /^manufacturer$/i.test(label)) {
      found = cleanBrand($row.find(valueSelectors).first().text())
    }
  })

  // Standard definition lists have dt/dd as siblings, not nested rows.
  if (!found) {
    $('dt').each((_, dt) => {
      if (found) return
      const $dt = $(dt)
      const label = cleanText($dt.text())
      if (/^brand$/i.test(label) || /^manufacturer$/i.test(label)) {
        const value = cleanBrand($dt.next('dd').text())
        if (value) found = value
      }
    })
  }

  if (found && !isRetailerBrand(found)) return found
  return ''
}

function extractBrandFromName(name: string): string {
  const commonBrands = [
    'Chris Reeve',
    'Spyderco',
    'Benchmade',
    'Microtech',
    'Hinderer',
    'Grimsmo',
    'Pro-Tech',
    'ZT',
    'Zero Tolerance',
    'Bark River',
    'Boker',
    'Böker',
    'Boker Plus',
    'Buck',
    'Buck Knives',
    'Case',
    'Case Knives',
    'Cold Steel',
    'CRKT',
    'Demko',
    'Demko Knives',
    'Emerson',
    'ESEE',
    'Extrema Ratio',
    'Fox',
    'Fox Knives',
    'Ferrum Forge',
    'GiantMouse',
    'Graham',
    'Heretic',
    'Hogue',
    'Hogue Knives',
    'Jake Hoback',
    'Kershaw',
    'Kizer',
    'Kizer Cutlery',
    'Liong Mah',
    'Les George',
    'LionSteel',
    'Marfione',
    'Medford',
    'Medford Knife & Tool',
    'MKM',
    'Mikov',
    'Mora',
    'Maserin',
    'Nemesis',
    'Olamic',
    'QuietCarry',
    'Reate',
    'Rike',
    'Schrade',
    'Shirogorov',
    'Smith & Wesson',
    'Spartan Blades',
    'Survive! Knives',
    'Toor',
    'Tops',
    'Tashi Bharucha',
    'Tuff Knives',
    'Viper',
    'WE Knife',
    'WE',
    'William Henry',
    'Wilson Combat',
    'Winkler',
    'Work Tuff Gear',
    'CIVIVI',
    'Civivi',
    'Bestech',
    'QSP',
    'Kansept',
    'Petrified Fish',
    'Sencut',
    'Twosun',
    'CJRB',
    'Artisan',
    'Artisan Cutlery',
    'Real Steel',
    'James Brand',
    'Opinel',
    'Victorinox',
    'Leatherman',
    'SOG',
    'Brous Blades',
    'Chaves',
    'CRK',
    'Midgards-Messer',
    'Miguron',
    'North Arms',
    'Pena',
    'Rassenti',
    'Rogers',
    'Sergey Rogovets',
    'Skiff',
    'SBD',
    'Strider',
    'Tactile Turn',
    'Terrain 365',
    'Trevor Burger',
    'Vero Engineering',
    'Vosteed',
    'Bastinelli',
  ]

  // Sort longer/more specific brands first so "Boker Plus" wins over "Boker"
  // and "Buck Knives" wins over "Buck".
  const sortedBrands = commonBrands.slice().sort((a, b) => b.length - a.length)
  for (const brand of sortedBrands) {
    const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(name)) {
      return cleanBrand(brand)
    }
  }
  return ''
}

function extractBrandFromDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    const domainBrands: Record<string, string> = {
      'spyderco.com': 'Spyderco',
      'benchmade.com': 'Benchmade',
      'buckknives.com': 'Buck',
      'microtechknives.com': 'Microtech',
      'chrisreeve.com': 'Chris Reeve',
      'victorinox.com': 'Victorinox',
      'boker.de': 'Böker',
      'boker-plus.de': 'Böker Plus',
      'morakniv.se': 'Morakniv',
      'morakniv.com': 'Morakniv',
      'fallkniven.com': 'Fällkniven',
      'fallkniven.se': 'Fällkniven',
      'foxknives.com': 'Fox',
      'lionsteel.it': 'LionSteel',
      'extremaratio.com': 'Extrema Ratio',
      'civivi.com': 'CIVIVI',
      'weknife.com': 'WE',
      'kizerknives.com': 'Kizer',
    }
    for (const [domain, brand] of Object.entries(domainBrands)) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) return brand
    }
  } catch {
    // ignore invalid URLs
  }
  return ''
}

function extractBrand(
  name: string,
  $: cheerio.CheerioAPI,
  ldBrand?: string,
  sourceUrl?: string,
): string {
  // 1) Trust JSON-LD brand/manufacturer when present.
  if (ldBrand) {
    const cleaned = cleanBrand(ldBrand)
    if (cleaned && !RETAILER_NAMES.test(cleaned)) return cleaned
  }

  // 2) Dedicated brand meta tags.
  const metaBrand = findMeta($, [
    'brand',
    'og:brand',
    'manufacturer',
    'og:manufacturer',
  ])
  if (metaBrand && !RETAILER_NAMES.test(metaBrand)) return cleanBrand(metaBrand)

  // 3) Amazon-specific DOM patterns.
  const amazonBrand = extractBrandFromAmazon($)
  if (amazonBrand) return amazonBrand

  // 4) Generic spec rows with Brand/Manufacturer labels.
  const labeledBrand = extractBrandFromLabeledElements($)
  if (labeledBrand) return labeledBrand

  // 5) Site name only when it is not a retailer/marketplace.
  const siteName = findMeta($, ['og:site_name', 'application-name'])
  if (siteName && !RETAILER_NAMES.test(siteName)) return cleanBrand(siteName)

  // 6) Fall back to known brand names in the product title/name.
  const brandFromName = extractBrandFromName(name)
  if (brandFromName) return brandFromName

  // 7) Some sites put the brand only in <title> while h1 is a short model name.
  const titleBrand = extractBrandFromName(normalizeText($('title').text()))
  if (titleBrand) return titleBrand

  // 8) Last resort: known manufacturer domain.
  if (sourceUrl) {
    const domainBrand = extractBrandFromDomain(sourceUrl)
    if (domainBrand) return domainBrand
  }

  return ''
}

const SPEC_PATTERNS: Array<[keyof ScrapedProduct['specs'], RegExp]> = [
  // Length / Länge / Lunghezza / Longueur / Longitud / Comprimento
  // Require an explicit length keyword so bare "Blade:" or "Handle:" doesn't match.
  // Allow hyphens/underscores between words (e.g. WooCommerce pa_blade-length).
  [
    'bladeLength',
    /(?:blade|klinge|lama|lame)[\s_-]*(?:length|size|len|länge|längd|lunga|lunghezza|longitud|longueur|comprimento|largo|breite|breedte)/i,
  ],
  [
    'overallLength',
    /(?:overall|total|gesamt|totallängd|lunghezza\s*totale|longueur\s*totale|longitud\s*total|comprimento\s*totale|totale\s*lengte)[\s_-]*(?:length|size|len|länge|längd|lunga|lunghezza|longitud|longueur|comprimento|largo)/i,
  ],
  [
    'handleLength',
    /(?:handle|griff|manche|impugnatura|mango|handtag)[\s_-]*(?:length|size|len|länge|längd|lunga|lunghezza|longitud|longueur|comprimento|largo)/i,
  ],
  // Thickness / Dicke / Spessore / Épaisseur / Dikte
  [
    'bladeThickness',
    /(?:blade|klinge|lama|lame)[\s_-]*(?:thickness|thick|dicke|spessore|épaisseur|dikte|tjocklek|grosor)/i,
  ],
  // Weight / Gewicht / Peso / Poids / Vikt
  ['weight', /weight|gewicht|peso|poids|vikt|mass/i],
  // Blade finish / coating / steel
  [
    'bladeCoating',
    /(?:blade|klinge|lama|lame)[\s_-]*(?:coating|finish|finishing|coating\s*\/\s*finish|beschichtung|finitura|finition|revestimiento|beläggning|ytbehandling)/i,
  ],
  [
    'bladeMaterial',
    /(?:blade|klinge|lama|lame|stål|steel)[\s_-]*(?:material|steel|stahl|acciaio|acier|acero|materiale)/i,
  ],
  // Locking
  [
    'lockingMechanism',
    /locking\s*mechanism|lock\s*type|lock\s*mechanism|verschluss|serratura|chiusura|verrouillage|cierre|låsmekanism/i,
  ],
  [
    'designer',
    /designer|designed\s*by|entworfen\s*von|progettista|conçu\s*par|diseñador|designad/i,
  ],
  [
    'modelNumber',
    /model\s*(?:number|#|no\.?)|\bsku\b|artikelnummer|numero\s*modello|numéro\s*de\s*modèle|número\s*de\s*modelo|modellnummer/i,
  ],
  ['hardness', /hardness|hrc|rockwell|härte|durezza|dureté|dureza|hårdhet/i],
  [
    'price',
    /\b(?:price|msrp|retail\s*price|preis|prezzo|prix|precio|prijs)\b/i,
  ],
  [
    'country',
    /country\s*(?:of\s*origin)?|made\s*in|origin|hergestellt\s*in|fabriqué\s*en|fatto\s*in|hecho\s*en|tillverkad\s*i|paese\s*di\s*origine|país\s*de\s*origen/i,
  ],
]

const COUNTRIES = [
  'USA',
  'United States',
  'China',
  'Taiwan',
  'Japan',
  'Italy',
  'Germany',
  'France',
  'Spain',
  'Sweden',
  'Finland',
  'Norway',
  'Denmark',
  'Austria',
  'Czech Republic',
  'Russia',
  'South Africa',
  'Canada',
  'Mexico',
  'Brazil',
  'Argentina',
  'Australia',
  'New Zealand',
  'UK',
  'United Kingdom',
  'England',
]

function normalizeCountry(value: string): string {
  const clean = cleanText(value)
  for (const country of COUNTRIES) {
    if (
      new RegExp(
        `\\b${country.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
        'i',
      ).test(clean)
    ) {
      if (country.toLowerCase() === 'united states') return 'USA'
      if (country.toLowerCase() === 'united kingdom') return 'UK'
      return country
    }
  }
  return ''
}

function normalizeLength(value: string): string {
  // Preserve the original value (including dual imperial/metric units like
  // `8.18" / 207.7 mm`). Only trim trailing punctuation/whitespace.
  const cleaned = cleanValue(value)
  // Reject non-numeric values (e.g. "No", "Sheepsfoot", blade steels).
  if (!cleaned || !/\d/.test(cleaned)) return ''
  return cleaned
}

function normalizeWeight(value: string): string {
  // Preserve the original value (including dual oz/g units like
  // `4.50 oz/127.5g`). Only trim trailing punctuation/whitespace.
  return cleanValue(value)
}

function extractLabeledValue(text: string, labels: string[]): string {
  if (!text) return ''
  const lowerLabels = labels.map((l) => l.toLowerCase())

  // Primary strategy: split the text at known spec-label boundaries, then
  // look for a chunk whose label matches one of the requested labels. This
  // handles both normal "Label: Value\n" lines and the concatenated format
  // "Label: ValueLabel2: Value2" that Shopify themes emit in JSON-LD.
  const chunks = splitBySpecLabels(text)
  for (const chunk of chunks) {
    const m = chunk.match(/^(.{2,40}?)\s*[:\uFF1A]\s*(.{1,80}?)\s*$/)
    if (!m) continue
    if (lowerLabels.includes(m[1].toLowerCase().trim())) {
      return cleanText(m[2])
    }
  }

  // Fallback: simple "Label: value" with newline/end boundary.
  const escapedLabels = labels.map((label) =>
    label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  )
  const simplePattern = new RegExp(
    `(?:${escapedLabels.join('|')})\\s*[:\uFF1A]\\s*(.{1,80}?)(?=\\n|$)`,
    'i',
  )
  const simpleMatch = text.match(simplePattern)
  if (simpleMatch) return cleanText(simpleMatch[1])

  return ''
}

// Known spec labels used for label-aware splitting. Order matters: longer
// and more specific labels come first so they win over prefix labels
// (e.g. "Model Number" must be tried before "Model"). Labels we do not
// extract (like "Color" or "Model") are still listed because they act as
// boundaries when values run into the next label without a separator.
// Note: we intentionally do NOT use \b word boundaries here, because brand
// sites often concatenate specs without separators (e.g. "MicartaWeight:"),
// and \b would fail to match between two word characters. The trailing ":"
// requirement already prevents most false positives.
const SPEC_LABEL_ALTERNATIONS = [
  'model\\s*number',
  'model\\s*#',
  'model\\s*no\\.?',
  'sku',
  'artikelnummer',
  'numero\\s*modello',
  'overall\\s*(?:length|size|len|längd|lunghezza|longitud|longueur|comprimento|largo)',
  'gesamtlänge',
  'totallängd',
  'lunghezza\\s*totale',
  'longueur\\s*totale',
  'longitud\\s*total',
  'handle\\s*(?:length|size|len|längd|lunghezza|longitud|longueur|comprimento|largo)',
  'closed\\s*length',
  'handle\\s*thickness',
  'handle\\s*material',
  'handle-material',
  'handle\\s*color',
  'handle-color',
  'handle\\s*finish',
  'handle-finish',
  'handle\\s*color/finish',
  'handle-color/finish',
  'handle\\s*length',
  'handle-length',
  'griffmaterial',
  'materiale\\s*impugnatura',
  'materiale\\s*manico',
  'matériau\\s*de\\s*la\\s*poignée',
  'blade\\s*style',
  'blade-style',
  'blade\\s*grind',
  'blade-grind',
  'blade\\s*hardness',
  'blade-hardness',
  'back\\s*spacer\\s*material',
  'back-spacer-material',
  'back\\s*spacer\\s*color',
  'back-spacer-color',
  'back\\s*spacer\\s*color/finish',
  'back-spacer-color/finish',
  'liner\\s*material',
  'liner-material',
  'clip\\s*material',
  'clip-material',
  'pivot\\s*assembly',
  'pivot-assembly',
  'pivot\\s*cap',
  'pivot-cap',
  'screws\\s*material',
  'screws-material',
  'model\\s*name',
  'model-name',
  'pocket\\s*clip',
  'pocket-clip',
  'blade\\s*(?:length|size|len|längd|lunghezza|longitud|longueur|comprimento|largo)',
  'klingenlänge',
  'lunghezza\\s*lama',
  'longueur\\s*de\\s*lame',
  'longitud\\s*de\\s*hoja',
  'blade\\s*(?:thickness|thick|dicke|spessore|épaisseur|dikte|tjocklek)',
  'bladtjocklek',
  'spessore\\s*lama',
  'blade\\s*(?:coating|finish|finishing|beschichtung|finitura|finition|revestimiento|ytbehandling)',
  'finitura\\s*lama',
  'blade\\s*(?:material|steel|stahl|acciaio|acier|acero|materiale)',
  'materiale\\s*lama',
  'stålinformation',
  'locking\\s*mechanism',
  'lock\\s*type',
  'lock\\s*mechanism',
  'verschluss',
  'serratura',
  'chiusura',
  'verrouillage',
  'cierre',
  'låsmekanism',
  'country\\s*of\\s*origin',
  'made\\s*in',
  'herstellt\\s*in',
  'fabriqué\\s*en',
  'fatto\\s*in',
  'hecho\\s*en',
  'tillverkad\\s*i',
  'paese\\s*di\\s*origine',
  'weight',
  'gewicht',
  'peso',
  'poids',
  'vikt',
  'mass',
  'designer',
  'designed\\s*by',
  'entworfen\\s*von',
  'progettista',
  'conçu\\s*par',
  'diseñador',
  'hardness',
  'härte',
  'durezza',
  'dureté',
  'dureza',
  'hårdhet',
  'hrc',
  'rockwell',
  'color',
  'colour',
  'model', // generic - keep last so "Model Number" wins first
]

const SPEC_LABEL_SPLIT_RE = new RegExp(
  `(?=(?:${SPEC_LABEL_ALTERNATIONS.join('|')})\\s*[:\\uFF1A])`,
  'gi',
)

// Measurement-focused labels that are commonly concatenated without a colon
// (e.g. Bootstrap grids on manufacturer sites). Excludes generic words like
// "model" or "color" to reduce false positives in prose.
const MEASUREMENT_LABEL_ALTERNATIONS = [
  'overall\\s*(?:length|size|len|längd|lunghezza|longitud|longueur|comprimento|largo)',
  'overall-length',
  'gesamtlänge',
  'totallängd',
  'lunghezza\\s*totale',
  'longueur\\s*totale',
  'longitud\\s*total',
  'total-length',
  'handle\\s*(?:length|size|len|längd|lunghezza|longitud|longueur|comprimento|largo)',
  'handle-length',
  'closed\\s*length',
  'closed-length',
  'handle\\s*thickness',
  'handle-thickness',
  'blade\\s*(?:length|size|len|längd|lunghezza|longitud|longueur|comprimento|largo)',
  'blade-length',
  'klingenlänge',
  'lunghezza\\s*lama',
  'longueur\\s*de\\s*lame',
  'longitud\\s*de\\s*hoja',
  'blade\\s*(?:thickness|thick|dicke|spessore|épaisseur|dikte|tjocklek)',
  'blade-thickness',
  'bladtjocklek',
  'spessore\\s*lama',
  'blade\\s*(?:coating|finish|finishing|beschichtung|finitura|finition|revestimiento|ytbehandling)',
  'blade-coating',
  'blade-finish',
  'finitura\\s*lama',
  'blade\\s*(?:material|steel|stahl|acciaio|acier|acero|materiale)',
  'blade-material',
  'blade-steel',
  'materiale\\s*lama',
  'stålinformation',
  'handle\\s*material',
  'griffmaterial',
  'materiale\\s*impugnatura',
  'materiale\\s*manico',
  'matériau\\s*de\\s*la\\s*poignée',
  'locking\\s*mechanism',
  'lock\\s*type',
  'lock\\s*mechanism',
  'verschluss',
  'serratura',
  'chiusura',
  'verrouillage',
  'cierre',
  'låsmekanism',
  'weight',
  'gewicht',
  'peso',
  'poids',
  'vikt',
  'country\\s*of\\s*origin',
  'made\\s*in',
  'herstellt\\s*in',
  'fabriqué\\s*en',
  'fatto\\s*in',
  'hecho\\s*en',
  'tillverkad\\s*i',
  'paese\\s*di\\s*origine',
]

const MEASUREMENT_LABEL_SPLIT_RE = new RegExp(
  `(?=(?:${MEASUREMENT_LABEL_ALTERNATIONS.join('|')})(?:\\s*[:\\uFF1A]\\s*|\\s+))`,
  'gi',
)

// Split text at each known label that is followed by a colon. This lets us
// recover individual `Label: Value` pairs even when a Shopify theme renders
// them concatenated without separators (e.g. in JSON-LD descriptions).
function splitBySpecLabels(text: string): string[] {
  if (!text) return []
  return text
    .split(SPEC_LABEL_SPLIT_RE)
    .map((part) => part.trim())
    .filter(Boolean)
}

// Split text at measurement labels even when no colon is present. This handles
// Bootstrap-style grids where label and value cells are concatenated in the DOM.
function splitByMeasurementLabels(text: string): string[] {
  if (!text) return []
  return text
    .split(MEASUREMENT_LABEL_SPLIT_RE)
    .map((part) => part.trim())
    .filter(Boolean)
}

// Try to extract a measurement label and its value from a chunk even when no
// colon separates them (e.g. "Vikt, endast kniv (g) 149"). Returns null when
// the chunk does not start with a known measurement label.
function extractMeasurementPair(
  chunk: string,
): { label: string; value: string } | null {
  const pattern = new RegExp(
    `^((?:${MEASUREMENT_LABEL_ALTERNATIONS.join('|')}))\\s*[:\\uFF1A]?\\s*(.{1,120}?)\\s*$`,
    'i',
  )
  const m = chunk.match(pattern)
  if (!m) return null
  return { label: cleanText(m[1]), value: cleanText(m[2]) }
}

// Parse a block of text line-by-line, calling onPair for every `Label: Value`
// line. Also splits concatenated specs (e.g. Shopify/JSON-LD descriptions with
// multiple labels on one line) before applying the colon regex, so "Blade
// Length: X Closed Length: Y" is parsed into two separate pairs.
function parseSpecLines(
  text: string,
  onPair: (label: string, value: string) => void,
) {
  if (!text) return
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  for (const line of lines) {
    // First split by known labels, even if they share a single line, so the
    // colon regex below only sees one label/value pair at a time.
    const chunks = splitBySpecLabels(line)
    const partsToParse = chunks.length > 1 ? chunks : [line]

    for (const part of partsToParse) {
      const m = part.match(/^(.{2,40}?)\s*[:\uFF1A]\s*(.{1,120}?)\s*$/)
      if (m) {
        onPair(m[1], m[2])
        continue
      }
      // Some manufacturer sites concatenate label/value cells without any colon.
      const measurementChunks = splitByMeasurementLabels(part)
      if (measurementChunks.length > 1) {
        for (const chunk of measurementChunks) {
          const pair = extractMeasurementPair(chunk)
          if (pair) onPair(pair.label, pair.value)
        }
      }
    }
  }
}

// Find a SPECIFICATIONS (or Specs / Details) section heading and return the
// following block of text with line breaks preserved. Brand sites typically
// render this as a heading followed by a <p> with <br>-separated spec lines.
function extractSpecBlock($: cheerio.CheerioAPI): string {
  const headingSelectors =
    'h1, h2, h3, h4, h5, h6, strong, b, p, div, span, dt, th'
  const $heading = $(headingSelectors)
    .filter((_, el) => {
      const t = $(el).text().trim()
      return /^(specifications?|specs?|details?|technical\s+(?:data|specs|details)|product\s+(?:specs|details|specifications))$/i.test(
        t,
      )
    })
    .first()

  if (!$heading.length) return ''

  let text = ''
  let $next = $heading.next()
  let safety = 50
  while ($next.length > 0 && safety-- > 0) {
    if ($next.is('h1, h2, h3, h4, h5, h6')) break
    const t = elementTextWithBreaks($, $next as any)
    if (t) text += '\n' + t
    $next = $next.next()
  }
  // Also include the heading's own siblings if the heading itself contained
  // spec text (some sites put everything inside one <p> with the heading
  // inline as <strong>SPECIFICATIONS</strong>).
  return normalizeMultilineText(text)
}

// Prestashop stores embed product features as an HTML-escaped JSON array.
// Extract it directly so we don't have to rely on visible tables.
function extractPrestashopFeatures(
  $: cheerio.CheerioAPI,
): Array<{ label: string; value: string }> {
  const pairs: Array<{ label: string; value: string }> = []
  const html = $.html()
  // Match both escaped (&quot;) and regular JSON feature arrays.
  const featureMatches =
    html.match(/&quot;features&quot;:\[(.*?)\]|"features":\[(.*?)\]/g) || []
  for (const match of featureMatches) {
    try {
      const decoded = htmlToPlainText(match)
        .replace(/“|”/g, '"')
        .replace(/'/g, '"')
      const json = JSON.parse(`{${decoded}}`)
      const features = json.features
      if (Array.isArray(features)) {
        for (const feature of features) {
          if (
            feature &&
            typeof feature.name === 'string' &&
            typeof feature.value === 'string'
          ) {
            pairs.push({
              label: cleanText(feature.name),
              value: cleanText(feature.value),
            })
          }
        }
      }
    } catch {
      // ignore malformed feature JSON
    }
  }
  return pairs
}

// Some Next.js/commercetools sites (e.g. Victorinox) embed product specs as
// `"name":"Length","values":["3.6"]` classification attributes inside a large
// JSON payload. Pull them out generically before falling back to text regexes.
function extractEmbeddedClassificationSpecs(
  $: cheerio.CheerioAPI,
): Array<{ label: string; value: string }> {
  const pairs: Array<{ label: string; value: string }> = []
  const html = $.html()
  // Match attribute objects: "name":"...","values":["..."] and optionally
  // capture a nearby unit symbol (e.g. "unit":{"symbol":"in"}).
  const re =
    /"name":"([^"]{1,60})","description":"[^"]{0,60}","type":[^,]*,"values":\[(.*?)\](?:[^}]{0,200}?"unit"\s*:\s*\{[^}]*"symbol"\s*:\s*"([^"]*)"\s*\})?/g
  const labelMap: Record<string, string> = {
    length: 'overall length',
    height: 'blade thickness',
    weight: 'weight',
    material: 'handle material',
    'country of origin': 'country',
  }
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const name = cleanText(m[1])
    const values = m[2]
      .split(',')
      .map((v) => cleanText(v.replace(/^"|"$/g, '')))
      .filter(Boolean)
    const unit = cleanText(m[3] || '')
    const value = values[0]
    if (name && value) {
      pairs.push({
        label: labelMap[name.toLowerCase()] || name,
        value: unit ? `${value} ${unit}` : value,
      })
    }
  }
  return pairs
}

// Extract schema.org PropertyValue / additionalProperty arrays from JSON-LD.
// These are heavily used by WooCommerce product-attribute plugins (e.g.
// Fällkniven stores blade length, weight, steel, etc. as `pa_*` properties).
function extractJsonLdProperties(
  $: cheerio.CheerioAPI,
): Array<{ label: string; value: string }> {
  const pairs: Array<{ label: string; value: string }> = []
  // Normalize common WooCommerce attribute slugs so the generic spec patterns
  // can match them (e.g. "pa_blade-length" -> "blade length").
  const normalizeSlug = (name: string): string => {
    const lower = name.toLowerCase().replace(/^pa_/, '')
    const slugMap: Record<string, string> = {
      'blade-length': 'blade length',
      'total-length': 'overall length',
      'overall-length': 'overall length',
      'blade-thickness': 'blade thickness',
      'weight-knife': 'weight',
      weight: 'weight',
      steel: 'blade steel',
      'blade-steel': 'blade steel',
      'handle-material': 'handle material',
      hardness: 'hardness',
      coating: 'blade coating',
      finish: 'blade finish',
    }
    return slugMap[lower] || name
  }
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html() ?? ''
      const data = JSON.parse(raw)
      const candidates = Array.isArray(data) ? data : [data]
      for (const item of candidates) {
        const graph = item['@graph']
        const items = graph && Array.isArray(graph) ? graph : [item]
        for (const node of items) {
          const props =
            node?.additionalProperty ||
            node?.hasVariant?.[0]?.additionalProperty
          if (Array.isArray(props)) {
            for (const prop of props) {
              if (
                prop &&
                typeof prop.name === 'string' &&
                (typeof prop.value === 'string' ||
                  typeof prop.value === 'number')
              ) {
                pairs.push({
                  label: normalizeSlug(cleanText(prop.name)),
                  value: cleanText(String(prop.value)),
                })
              }
            }
          }
        }
      }
    } catch {
      // ignore malformed JSON-LD
    }
  })
  return pairs
}

function extractSpecs($: cheerio.CheerioAPI): ScrapedProduct['specs'] {
  const specs: ScrapedProduct['specs'] = {
    weight: '',
    overallLength: '',
    bladeLength: '',
    bladeThickness: '',
    bladeCoating: '',
    bladeMaterial: '',
    lockingMechanism: '',
    designer: '',
    modelNumber: '',
    handleLength: '',
    hardness: '',
    price: '',
    country: '',
  }

  const setSpec = (key: keyof ScrapedProduct['specs'], value: string) => {
    if (!value) return
    if (key === 'country') {
      const country = normalizeCountry(value)
      if (country) specs[key] = country
    } else if (
      key === 'bladeLength' ||
      key === 'overallLength' ||
      key === 'bladeThickness' ||
      key === 'handleLength'
    ) {
      const v = normalizeLength(value)
      if (v) specs[key] = v
    } else if (key === 'weight') {
      const v = normalizeWeight(value)
      if (v) specs[key] = v
    } else {
      const v = cleanValue(value)
      if (v) specs[key] = v
    }
  }

  const tryExtract = (rawLabel: string, rawValue: string) => {
    const label = normalizeText(rawLabel)
    const value = normalizeText(rawValue)
    if (!label || !value) return

    for (const [key, pattern] of SPEC_PATTERNS) {
      if (pattern.test(label) && !specs[key]) {
        setSpec(key, value)
      }
    }
  }

  // 1) Structured rows: tables, definition lists, and divs with label/value
  // classes. These are still the most reliable source when present.
  const rowSelectors = [
    'table tr',
    'table tbody tr',
    'dl div',
    'dl dd',
    '.spec-row',
    '.product-spec',
    '[class*="spec"]',
    '[class*="ProductSpec"]',
    '.product-attribute',
    '.product-data-row',
    '.woocommerce-product-attributes-item',
    '.pdp-specs-row',
    '.specifications-row',
    '.accordion__content tr',
    '.product-card-specification',
  ]

  const labelSelectors =
    'th, dt, .spec-label, [class*="label"], .attribute-label, .pdp-specs-label, [class*="specification-data-title"], [class*="specification-title"]'
  const valueSelectors =
    'td, dd, .spec-value, [class*="value"], .attribute-value, .pdp-specs-value, [class*="specification-data-value"], [class*="specification-value"]'

  $(rowSelectors.join(', ')).each((_, row) => {
    const $row = $(row)
    const label = $row.find(labelSelectors).first().text()
    const value = $row.find(valueSelectors).first().text()
    tryExtract(label, value)
  })

  // 1.5) Prestashop product features embedded as escaped JSON.
  for (const pair of extractPrestashopFeatures($)) {
    tryExtract(pair.label, pair.value)
  }

  // 1.6) Schema.org additionalProperty arrays (common for WooCommerce product
  // attributes such as Fällkniven's pa_blade-length / pa_weight-knife).
  for (const pair of extractJsonLdProperties($)) {
    tryExtract(pair.label, pair.value)
  }

  // 1.7) Next.js/commercetools embedded classification attributes.
  for (const pair of extractEmbeddedClassificationSpecs($)) {
    tryExtract(pair.label, pair.value)
  }

  // 2) SPECIFICATIONS section heading followed by <br>-separated spec lines.
  // This handles Kizer, GiantMouse, and most Shopify-theme spec blocks where
  // all specs live inside a single <p> with <strong>Label</strong>: Value<br>.
  const specBlockText = extractSpecBlock($)
  if (specBlockText) {
    parseSpecLines(specBlockText, tryExtract)
  }

  // 3) Per-element line-based extraction. We re-extract each element's text
  // with <br> preserved as newlines so a single <p> holding many spec lines
  // is parsed correctly.
  $('div, span, p, li').each((_, el) => {
    const text = normalizeMultilineText(elementTextWithBreaks($, el as any))
    if (!text) return
    parseSpecLines(text, tryExtract)
  })

  // 4) Label-aware extraction from JSON-LD / meta descriptions. These often
  // concatenate specs without separators, so we split by known labels.
  const metaDescription = $('meta[name="description"]').attr('content') ?? ''
  const ldDescription = extractJsonLdProduct($).description ?? ''

  for (const source of [ldDescription, metaDescription]) {
    if (!source) continue
    const normalized = normalizeMultilineText(source)
    const chunks = splitBySpecLabels(normalized)
    for (const chunk of chunks) {
      const m = chunk.match(/^(.{2,40}?)\s*[:\uFF1A]\s*(.{1,120}?)\s*$/)
      if (m) tryExtract(m[1], m[2])
    }
    // Also try plain line-by-line in case the description kept newlines.
    parseSpecLines(normalized, tryExtract)
  }

  // 5) Final plain-text fallback regexes. These use word boundaries and
  // require meaningful units so we don't pick up "font-weight:400" or
  // Shopify JSON `"weight":0`.
  const pageText = normalizeMultilineText(
    elementTextWithBreaks($, 'body' as any),
  )
  const allText = `${ldDescription}\n${metaDescription}\n${pageText}`

  const runFallback = (
    key: keyof ScrapedProduct['specs'],
    pattern: RegExp,
    transform: (v: string) => string,
  ) => {
    if (specs[key]) return
    const m = allText.match(pattern)
    if (m) {
      const v = transform(m[1])
      if (v) specs[key] = v
    }
  }

  runFallback(
    'bladeLength',
    /\b(?:blade|klinge|lama)\s*(?:length|size|len|länge|längd|lunghezza|longitud|longueur|comprimento|largo)\s*[:\uFF1A]\s*([\d.,/]+\s*(?:"|''|in|inches|mm|cm)?)/i,
    normalizeLength,
  )
  runFallback(
    'overallLength',
    /\b(?:overall|total|gesamt|totallängd|lunghezza\s*totale|longueur\s*totale|longitud\s*total|comprimento\s*totale)\s*(?:length|size|len|länge|längd|lunghezza|longitud|longueur|comprimento|largo)\s*[:\uFF1A]\s*([\d.,/]+\s*(?:"|''|in|inches|mm|cm)?)/i,
    normalizeLength,
  )
  runFallback(
    'handleLength',
    /\b(?:handle|griff|manche|impugnatura|mango|handtag)\s*(?:length|size|len|länge|längd|lunghezza|longitud|longueur|comprimento|largo)\s*[:\uFF1A]\s*([\d.,/]+\s*(?:"|''|in|inches|mm|cm)?)/i,
    normalizeLength,
  )
  runFallback(
    'bladeThickness',
    /\b(?:blade|klinge|lama)\s*(?:thickness|thick|dicke|spessore|épaisseur|dikte|tjocklek)\s*[:\uFF1A]\s*([\d.,/]+\s*(?:"|''|in|inches|mm|cm)?)/i,
    normalizeLength,
  )
  runFallback(
    'weight',
    /\b(?:weight|gewicht|peso|poids|vikt)\s*[:\uFF1A]\s*([\d.,]+\s*(?:oz|g|grams|lbs|lb|kg)\b)/i,
    normalizeWeight,
  )
  runFallback(
    'bladeMaterial',
    /\b(?:blade|klinge|lama)\s*(?:material|steel|stahl|acciaio|acier|acero|materiale)\s*[:\uFF1A]\s*(.{1,40}?)(?=\n|$)/i,
    cleanValue,
  )
  runFallback(
    'bladeCoating',
    /\b(?:blade|klinge|lama)\s*(?:coating|finish|finishing|beschichtung|finitura|finition|revestimiento|ytbehandling)\s*[:\uFF1A]\s*(.{1,40}?)(?=\n|$)/i,
    cleanValue,
  )
  runFallback(
    'lockingMechanism',
    /\b(?:locking\s*mechanism|lock\s*type|lock\s*mechanism|verschluss|serratura|chiusura|verrouillage|cierre|låsmekanism)\s*[:\uFF1A]\s*(.{1,40}?)(?=\n|$)/i,
    cleanValue,
  )
  runFallback(
    'designer',
    /\b(?:designer|designed\s*by|entworfen\s*von|progettista|conçu\s*par|diseñador|designad)\s*[:\uFF1A]\s*(.{1,40}?)(?=\n|$)/i,
    cleanValue,
  )
  runFallback(
    'modelNumber',
    /\b(?:model\s*(?:number|#|no\.?)|sku|artikelnummer|numero\s*modello|numéro\s*de\s*modèle|número\s*de\s*modelo|modellnummer)\s*[:\uFF1A]\s*(.{1,40}?)(?=\n|$)/i,
    cleanValue,
  )
  runFallback(
    'hardness',
    /\b(?:hardness|härte|durezza|dureté|dureza|hårdhet|hrc|rockwell)\s*[:\uFF1A]\s*([\d.-]+\s*(?:hrc|rockwell)?)/i,
    cleanValue,
  )

  // Country needs special normalization.
  if (!specs.country) {
    const countryMatch = allText.match(
      /\b(?:country\s*of\s*origin|made\s*in|herstellt\s*in|fabriqué\s*en|fatto\s*in|hecho\s*en|tillverkad\s*i|paese\s*di\s*origine|país\s*de\s*origen)\s*[:\uFF1A]\s*([A-Za-z\s]+?)(?=\n|\.|\s{2,}|$)/i,
    )
    if (countryMatch) {
      const country = normalizeCountry(countryMatch[1])
      if (country) specs.country = country
    }
  }

  return specs
}

const HANDLE_MATERIALS = [
  'Natural Canvas Micarta',
  'Linen Micarta',
  'Canvas Micarta',
  'Micarta',
  'Carbon Fiber',
  'G-10',
  'G10',
  'FRN',
  'PEI',
  'Ultem',
  'Titanium',
  'Aluminum',
  'Aluminium',
  'Brass',
  'Copper',
  'Bronze',
  'Stabilized Wood',
  'Wood',
  'Bone',
  'Stag',
  'Mother of Pearl',
  'Abalone',
  'Rubber',
  'Kraton',
  'Grivory',
  'Nylon',
  'Polymer',
]

function normalizeHandleMaterial(material: string): string {
  const lower = material.toLowerCase()
  if (lower === 'g10') return 'G-10'
  if (lower === 'stag') return 'Stag'
  return material.trim()
}

function extractHandleMaterial(text: string): string {
  const found = new Set<string>()
  for (const material of HANDLE_MATERIALS) {
    const escaped = material.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) {
      found.add(normalizeHandleMaterial(material))
    }
  }
  if (found.size === 0) return ''
  const materials = Array.from(found)
  // Drop generic materials when a more specific variant is present (e.g. Stabilized Wood over Wood).
  const filtered = materials.filter((material) => {
    const lower = material.toLowerCase()
    return !materials.some(
      (other) =>
        other !== material &&
        other.toLowerCase().includes(lower) &&
        other.length > material.length,
    )
  })
  // Sort for stable output.
  return filtered.join(' / ')
}

const BLADE_STYLES = [
  'Reverse Tanto',
  'Drop Point',
  'Clip Point',
  'Tanto',
  'Spear Point',
  'Sheepsfoot',
  'Wharncliffe',
  'Hawkbill',
  'Dagger',
  'Spanto',
  'Trailing Point',
  'Needle Point',
  'Pen Blade',
  'Warncliffe',
  'Harpoons',
  'Hawksbill',
  'Straight back',
  'Straight Back',
]

function extractBladeStyle(text: string): string {
  for (const style of BLADE_STYLES) {
    const escaped = style.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) {
      return style
    }
  }
  return ''
}

function stripHtml(html: string): string {
  return htmlToPlainText(html)
}

export function getShopifyJsonUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    const match = parsed.pathname.match(/\/products\/([^/]+)\/?$/)
    if (!match) return undefined
    parsed.pathname = `/products/${match[1]}.json`
    parsed.search = ''
    parsed.hash = ''
    return parsed.href
  } catch {
    return undefined
  }
}

export function isShopifyProductPage(url: string, html: string): boolean {
  if (!getShopifyJsonUrl(url)) return false
  const shopifyMarkers = [
    'Shopify.shop',
    'myshopify.com',
    'cdn.shopify.com',
    'shopify-checkout-api-token',
    '"@type":"Product"',
  ]
  return shopifyMarkers.some((marker) => html.includes(marker))
}

export function extractShopifyProduct(
  json: unknown,
): Partial<ScrapedProduct> | null {
  const product = (json as { product?: Record<string, unknown> })?.product
  if (!product || typeof product !== 'object') return null

  const title =
    typeof product.title === 'string' ? cleanText(product.title) : ''
  const vendor =
    typeof product.vendor === 'string' ? cleanText(product.vendor) : ''
  const bodyHtml =
    typeof product.body_html === 'string' ? product.body_html : ''
  const description = stripHtml(bodyHtml)

  const images: string[] = []
  const rawImages = product.images
  if (Array.isArray(rawImages)) {
    for (const img of rawImages) {
      if (
        typeof img === 'object' &&
        img &&
        typeof (img as { src?: string }).src === 'string'
      ) {
        images.push((img as { src: string }).src)
      }
    }
  }

  const result: Partial<ScrapedProduct> = {}
  if (title) result.name = title
  if (vendor) result.brand = cleanBrand(vendor)
  if (description) result.description = description
  if (images.length > 0) result.images = images

  return result
}

function buildConfidence(product: ScrapedProduct): ScrapeConfidence {
  return {
    name: Boolean(product.name),
    brand: Boolean(product.brand),
    description: Boolean(product.description),
    images: product.images.length > 0,
    bladeStyle: Boolean(product.bladeStyle),
    handleMaterial: Boolean(product.handleMaterial),
    specs: {
      weight: Boolean(product.specs.weight),
      overallLength: Boolean(product.specs.overallLength),
      bladeLength: Boolean(product.specs.bladeLength),
      bladeThickness: Boolean(product.specs.bladeThickness),
      bladeCoating: Boolean(product.specs.bladeCoating),
      bladeMaterial: Boolean(product.specs.bladeMaterial),
      lockingMechanism: Boolean(product.specs.lockingMechanism),
      designer: Boolean(product.specs.designer),
      modelNumber: Boolean(product.specs.modelNumber),
      handleLength: Boolean(product.specs.handleLength),
      hardness: Boolean(product.specs.hardness),
      price: Boolean(product.specs.price),
      country: Boolean(product.specs.country),
    },
  }
}

export function scrapeProduct(
  html: string,
  baseUrl: string,
  sourceUrl?: string,
): ScrapeResult {
  const $ = cheerio.load(html)
  const ld = extractJsonLdProduct($)

  const rawName = ld.name || extractTitle($)
  const name = cleanProductName(rawName, sourceUrl ?? baseUrl)
  const brand = extractBrand(name, $, ld.brand, sourceUrl ?? baseUrl)
  const description = ld.description || extractDescription($)
  const images = ld.images?.length ? ld.images : extractImages($, baseUrl)
  // Use elementTextWithBreaks so block-level tags and <br> become word
  // boundaries; cheerio's .text() concatenates table cells and <br> lines
  // without separators, which breaks keyword matching (e.g. "MaterialAluminum").
  const pageText = normalizeMultilineText(
    elementTextWithBreaks($, 'body' as any),
  )
  const titleText = normalizeText($('title').text())
  const h1Text = normalizeText($('h1').first().text())
  const searchText = `${titleText} ${h1Text} ${pageText}`
  const specs = extractSpecs($)

  // Use the product description for material/style extraction when available,
  // since it is more likely to describe this exact knife than the full page text.
  const productDescriptionText = normalizeText(description ?? '')

  // Schema.org additionalProperty often carries structured attributes such as
  // handle material or blade style (e.g. WooCommerce pa_* attributes).
  const ldProperties = new Map<string, string>()
  for (const { label, value } of extractJsonLdProperties($)) {
    ldProperties.set(label.toLowerCase(), value)
  }
  const ldHandleMaterial =
    ldProperties.get('pa_handle-material') ||
    ldProperties.get('handle material') ||
    ldProperties.get('materiale impugnatura') ||
    ldProperties.get('materiale manico') ||
    ''
  const ldBladeStyle =
    ldProperties.get('pa_blade-style') ||
    ldProperties.get('blade style') ||
    ldProperties.get('pa_edge') ||
    ''

  const bladeStyle =
    cleanValue(ldBladeStyle) ||
    cleanValue(
      extractLabeledValue(productDescriptionText, [
        'blade style',
        'blade grind',
      ]),
    ) ||
    cleanValue(
      extractLabeledValue(searchText, ['blade style', 'blade grind']),
    ) ||
    extractBladeStyle(productDescriptionText) ||
    extractBladeStyle(searchText)
  const handleMaterial =
    cleanValue(ldHandleMaterial) ||
    cleanValue(
      extractLabeledValue(productDescriptionText, ['handle material']),
    ) ||
    extractHandleMaterial(productDescriptionText) ||
    cleanValue(extractLabeledValue(searchText, ['handle material'])) ||
    extractHandleMaterial(searchText)

  const product: ScrapedProduct = {
    name,
    brand,
    description,
    images,
    bladeStyle,
    handleMaterial,
    specs,
    sourceUrl: sourceUrl ?? baseUrl,
  }

  return {
    product,
    confidence: buildConfidence(product),
  }
}
