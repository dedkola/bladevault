import * as cheerio from 'cheerio'

const clean = (value: string) => value.replace(/\s+/g, ' ').trim()

export function isSogProductUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      (url.hostname === 'sogknives.com' ||
        url.hostname === 'www.sogknives.com') &&
      url.pathname !== '/'
    )
  } catch {
    return false
  }
}

function embeddedDescription($: cheerio.CheerioAPI): string {
  for (const script of $('script').toArray()) {
    // Stencil embeds a JSON string argument containing another JSON string.
    // Parse only that data; never evaluate the retailer's JavaScript.
    const match = $(script)
      .text()
      .match(/stencilBootstrap\(\s*"product"\s*,\s*("(?:\\.|[^"\\])*")/)
    if (!match) continue
    try {
      const context = JSON.parse(JSON.parse(match[1]))
      const content = JSON.parse(context.contentfulData)
      const description = content?.description?.['en-US']
      if (typeof description === 'string') return description
    } catch {
      // A missing/malformed bootstrap must not discard the visible product.
    }
  }
  return ''
}

export function extractSogProduct($: cheerio.CheerioAPI, url: string) {
  if (!isSogProductUrl(url) || !$('.productView').length) return null

  const attributes = new Map<string, string>()
  const warnings: string[] = []
  const values = new Map<string, Set<string>>()
  const aliases: Record<string, string> = {
    'product weight': 'weight',
    'blade steel type': 'blade material',
    finish: 'blade finish',
  }
  $('.productSpecifications .spec-item').each((_, el) => {
    const row = $(el)
    const label = clean(row.find('.label').first().text()).toLowerCase()
    const value = clean(row.find('.value').first().text())
    if (!label || !value || /^(?:n\/?a|[-–—]+)$/i.test(value)) return
    const key = aliases[label] ?? label
    if (!values.has(key)) values.set(key, new Set())
    values.get(key)!.add(value)
  })
  for (const [label, candidates] of values) {
    if (candidates.size === 1) attributes.set(label, [...candidates][0])
    else
      warnings.push(
        `SOG lists conflicting ${label} values (${[...candidates].join(' / ')}). This field was left empty; verify it before saving.`,
      )
  }
  attributes.set(
    'sku',
    clean($('.productView [data-product-sku]').first().text()),
  )
  const price =
    $('meta[property="product:price:amount"]').attr('content') ||
    $('.productView [data-product-price-without-tax]').first().text()
  const currency =
    $('meta[property="product:price:currency"]').attr('content') || ''
  if (price) attributes.set('price', clean(`${price} ${currency}`))

  // The thumbnail links contain all originals; the main image is a duplicate.
  // Keep recommendations, engraving templates, and lifestyle sections out.
  const thumbnails = $('.productView .productView-thumbnail-link')
  const gallery = thumbnails.length
    ? thumbnails
    : $('.productView .productView-image')
  const images = gallery
    .toArray()
    .map((el) => {
      const image = $(el)
      const href =
        image.attr('href') ||
        image.attr('data-zoom-image') ||
        image.find('img').attr('data-src') ||
        image.find('img').attr('src') ||
        ''
      if (!href || /video|youtube|vimeo/i.test(href)) return ''
      try {
        const parsed = new URL(href, url)
        if (!/^https?:$/.test(parsed.protocol)) return ''
        if (/(^|\.)bigcommerce\.com$/i.test(parsed.hostname)) {
          parsed.pathname = parsed.pathname.replace(
            /\/images\/stencil\/(?:original|\d+w|\d+x\d+)\//i,
            '/images/stencil/original/',
          )
        }
        return parsed.href
      } catch {
        return ''
      }
    })
    .filter(Boolean)

  return {
    name: clean($('.productView .productView-title').first().text()),
    description: $('.productView .productView-description')
      .first()
      .text()
      .trim()
      ? $('.productView .productView-description').first().html() || ''
      : embeddedDescription($),
    attributes,
    images: [...new Set(images)],
    warnings,
  }
}
