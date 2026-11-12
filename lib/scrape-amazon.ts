import * as cheerio from 'cheerio'

const clean = (value: string) =>
  value
    .replace(/[\u200e\u200f\u00a0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

export function isAmazonProductUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      /(?:^|\.)amazon\.(?:com|ca|com\.mx|com\.br|co\.uk|de|fr|it|es|nl|se|pl|com\.be|ie|co\.jp|com\.au|sg|ae|sa|in|com\.tr)$/i.test(
        url.hostname,
      ) &&
      /\/(?:dp|gp\/product|gp\/aw\/d)\/[A-Z0-9]{10}(?:[/?]|$)/i.test(
        url.pathname + '/',
      )
    )
  } catch {
    return false
  }
}

// Amazon's generic catalog values describe a category, not the knife's steel.
const GENERIC_BLADE_MATERIAL =
  /^(?:(?:high[\s-]*)?(?:carbon|alloy|stainless|tool)(?:\s+steel)?|steel|metal|stainless\s+steel,?\s*alloy\s+steel)$/i

const STEEL_PATTERN =
  /\b(?:CPM[\s-]?(?:S30V|S35VN|S45VN|S90V|S110V|S125V|3V|4V|10V|M4|20CV|154|Cru-?Wear|MagnaCut|Magna\s?Cut|Rex\s?\d+)|Magna\s?Cut|S30V|S35VN|S45VN|S90V|S110V|M390|20CV|204P|Elmax|K390|K110|N690(?:Co)?|VG-?10|AUS-?8A?|AUS-?10A?|D2|14C28N|12C27|13C26|Nitro-?V|AEB-?L|LC200N|CTS[\s-]?(?:XHP|BD1N?|204P|B75P)|BD1N|154CM|440C|420HC|8Cr13MoV|9Cr18MoV|10Cr15CoMoV|Cru-?Wear|Maxamet|SPY27|1095|Damascus|Damasteel|H-1|N695|Sleipner|ZDP-?189)\b/i

const LOCK_PATTERN =
  /\b(?:(?:top\s+)?(?:liner|frame|button|cross[\s-]?bar|axis|compression|back|ball[\s-]bearing|bolt|arc|tri-ad|reeve\s+integral|plunge|thumb)\s+lock|lockback|slip[\s-]?joint)\b/i

export type AmazonProduct = {
  title: string
  description: string
  images: string[]
  /** Normalized label → value pairs for the shared spec parser. */
  attributes: Map<string, string>
  bladeStyle: string
  /** Title segment naming the handle, e.g. "Green Micarta Handle". */
  handleTitle: string
  handleMaterial: string
  modelName: string
}

function galleryImages($: cheerio.CheerioAPI): string[] {
  // The image block's initial gallery is the selected variant's photos.
  for (const script of $('script').toArray()) {
    const source = $(script).text()
    const match = source.match(
      /['"]colorImages['"]\s*:\s*\{\s*['"]initial['"]\s*:\s*(?:A\.\$\.parseJSON\(\s*'((?:\\.|[^'\\])*)'\s*\)|(\[[\s\S]*?\])\s*\})/,
    )
    if (!match) continue
    const raw = match[1] ? match[1].replace(/\\(['\\])/g, '$1') : match[2]
    try {
      const entries = JSON.parse(raw) as Array<Record<string, unknown>>
      const images = entries
        .map((entry) =>
          typeof entry.hiRes === 'string' && entry.hiRes
            ? entry.hiRes
            : typeof entry.large === 'string'
              ? entry.large
              : '',
        )
        .filter((url) => /^https:\/\//.test(url))
      if (images.length) return [...new Set(images)]
    } catch {
      // Fall back to the visible main image below.
    }
  }
  const landing = $('#landingImage, #imgBlkFront').first()
  const hiRes = landing.attr('data-old-hires') || ''
  if (/^https:\/\//.test(hiRes)) return [hiRes]
  try {
    const dynamic = JSON.parse(landing.attr('data-a-dynamic-image') || '{}')
    const largest = Object.entries(dynamic as Record<string, number[]>).sort(
      ([, a], [, b]) => (b?.[0] ?? 0) - (a?.[0] ?? 0),
    )[0]?.[0]
    if (largest && /^https:\/\//.test(largest)) return [largest]
  } catch {
    // No usable main image.
  }
  return []
}

function detailRows($: cheerio.CheerioAPI): Map<string, string> {
  const rows = new Map<string, string>()
  const add = (label: string, value: string) => {
    const key = clean(label)
      .replace(/[:\u200e\u200f]+$/g, '')
      .trim()
      .toLowerCase()
    const text = clean(value)
    if (key && text && !rows.has(key)) rows.set(key, text)
  }
  $(
    [
      '#productOverview_feature_div tr',
      '#productDetails_techSpec_section_1 tr',
      '#productDetails_techSpec_section_2 tr',
      '#productDetails_detailBullets_sections1 tr',
      '#prodDetails tr',
      '#tech tr',
    ].join(', '),
  ).each((_, el) => {
    const cells = $(el).children('th, td')
    if (cells.length >= 2) add(cells.eq(0).text(), cells.eq(1).text())
  })
  $('#detailBullets_feature_div li, #productFactsDesktopExpander li').each(
    (_, el) => {
      const text = clean($(el).text())
      const separator = text.search(/\s*:\s*/)
      if (separator > 0)
        add(
          text.slice(0, separator),
          text.slice(separator + 1).replace(/^\s*:?\s*/, ''),
        )
    },
  )
  return rows
}

function buyBoxPrice($: cheerio.CheerioAPI): string {
  for (const selector of [
    '#corePrice_feature_div .a-price .a-offscreen',
    '#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen',
    '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
    '#apex_desktop .priceToPay .a-offscreen',
    '#apex_desktop .apexPriceToPay .a-offscreen',
    '#price_inside_buybox',
    '#priceblock_ourprice',
    '#priceblock_dealprice',
  ]) {
    const text = clean($(selector).first().text())
    if (/\d/.test(text)) return text
  }
  return ''
}

function titleSegment(title: string, word: RegExp): string {
  return (
    title.split(/\s+[-–—|]\s+|,\s*/).find((segment) => word.test(segment)) ?? ''
  )
}

export function extractAmazonProduct(
  $: cheerio.CheerioAPI,
  url: string,
): AmazonProduct | null {
  if (!isAmazonProductUrl(url) || !$('#productTitle').length) return null

  const title = clean($('#productTitle').first().text())
  const bullets = $('#feature-bullets li')
    .toArray()
    .map((el) => clean($(el).text()))
    .filter((text) => text && !/^›?\s*see more product details$/i.test(text))
  const productDescription = clean($('#productDescription').first().text())
  const description = [...bullets, productDescription]
    .filter(Boolean)
    .join('\n\n')
  const rows = detailRows($)
  const row = (...labels: string[]) =>
    labels.map((label) => rows.get(label) ?? '').find(Boolean) ?? ''

  const attributes = new Map<string, string>()
  const set = (label: string, value: string) => {
    if (value) attributes.set(label, value)
  }

  // Amazon's title usually states the exact blade length and steel, while its
  // catalog fields hold category values such as "Alloy Steel".
  const titleLength = title.match(
    /(\d+(?:\.\d+)?)\s*(?:"|”|''|-?\s*inch(?:es)?\b|\s?in\b)(?=[^,|–—-]{0,40}\bblade\b)/i,
  )
  set(
    'blade length',
    row('blade length') || (titleLength ? `${titleLength[1]} in` : ''),
  )
  set('weight', row('item weight', 'weight'))
  set('blade thickness', row('blade thickness'))
  set('closed length', row('closed length', 'folded length'))
  set('overall length', row('overall length', 'open length'))
  const listedSteel = row('blade material', 'blade steel')
  set(
    'blade material',
    title.match(STEEL_PATTERN)?.[0] ||
      (listedSteel && !GENERIC_BLADE_MATERIAL.test(listedSteel)
        ? listedSteel
        : '') ||
      bullets.join('\n').match(STEEL_PATTERN)?.[0] ||
      '',
  )
  set(
    'locking mechanism',
    title.match(LOCK_PATTERN)?.[0] ||
      row('lock type', 'locking mechanism') ||
      bullets.join('\n').match(LOCK_PATTERN)?.[0] ||
      '',
  )
  const titleModel = title.match(
    /\s[-–—]\s*([A-Z]{0,4}\d{2,6}[A-Z0-9]{0,6}(?:-[A-Z0-9]{1,6})?)\s*$/,
  )
  set(
    'model number',
    row('item model number', 'model number', 'part number') ||
      titleModel?.[1] ||
      '',
  )
  set('hardness', row('hardness', 'item hardness'))
  set('country of origin', row('country of origin'))
  set('price', buyBoxPrice($))

  return {
    title,
    description,
    images: galleryImages($),
    attributes,
    bladeStyle: row('blade shape'),
    handleTitle: titleSegment(title, /\bhandle\b/i),
    handleMaterial: row('handle material'),
    modelName: row('model name'),
  }
}
