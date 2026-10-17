import * as cheerio from 'cheerio'
import type { ScrapedProduct } from './scrape'

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()

export function isVosteedProductUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      /(^|\.)vosteed\.com$/i.test(parsed.hostname) &&
      /\/products\/[^/]+/.test(parsed.pathname)
    )
  } catch {
    return false
  }
}

const SPEC_FIELDS: Record<string, keyof ScrapedProduct['specs']> = {
  model: 'modelNumber',
  'model number': 'modelNumber',
  sku: 'modelNumber',
  'blade length': 'bladeLength',
  'overall length': 'overallLength',
  'handle length': 'handleLength',
  'closed length': 'handleLength',
  'blade thickness': 'bladeThickness',
  thickness: 'bladeThickness',
  'blade material': 'bladeMaterial',
  'blade steel': 'bladeMaterial',
  'blabe material': 'bladeMaterial', // Typo in the legacy Hackney tables.
  'blade finish': 'bladeCoating',
  finish: 'bladeCoating',
  'lock type': 'lockingMechanism',
  'locking mechanism': 'lockingMechanism',
  hardness: 'hardness',
  'rockwell hardness': 'hardness',
  weight: 'weight',
  designer: 'designer',
  'designed by': 'designer',
  'country of origin': 'country',
}

// A field may contain one imperial/metric pair, but never two competing
// lengths. Vosteed has published concatenated values in a single source row.
function measurementIsConflicting(value: string, weight: boolean): boolean {
  const units = weight
    ? 'oz|kg|lbs?\\b|grams?\\b|g\\b'
    : "mm|cm|inches|inch|in\\b|[\"″”“]|''"
  const matches = [
    ...value.matchAll(new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(${units})`, 'gi')),
  ]
  const factors: Record<string, number> = weight
    ? {
        oz: 28.3495,
        kg: 1000,
        lb: 453.592,
        lbs: 453.592,
        gram: 1,
        grams: 1,
        g: 1,
      }
    : {
        mm: 1,
        cm: 10,
        in: 25.4,
        inch: 25.4,
        inches: 25.4,
        '"': 25.4,
        '″': 25.4,
        '”': 25.4,
        '“': 25.4,
        "''": 25.4,
      }
  const seen = new Set<number>()
  const converted: number[] = []
  for (const match of matches) {
    const factor = factors[match[2].toLowerCase()]
    if (seen.has(factor)) return true
    seen.add(factor)
    converted.push(Number(match[1].replace(',', '.')) * factor)
  }
  if (converted.length < 2) return false
  const min = Math.min(...converted)
  const max = Math.max(...converted)
  return max - min > Math.max(weight ? 1 : 0.5, max * 0.02)
}

export function extractVosteedSpecs($: cheerio.CheerioAPI, url: string) {
  const variantId =
    new URL(url).searchParams.get('variant') ||
    $('form[action*="/cart/add"] input[name="id"]').first().attr('value')
  let offer:
    | {
        name?: string
        sku?: string
        price?: number | string
        priceCurrency?: string
      }
    | undefined
  $('script[type="application/ld+json"]').each((_, el) => {
    if (offer) return
    try {
      const json = JSON.parse($(el).text())
      const nodes = Array.isArray(json) ? json : json['@graph'] || [json]
      for (const node of nodes) {
        if (![node['@type']].flat().includes('Product')) continue
        const offers = node.offers ? [node.offers].flat() : []
        offer = variantId
          ? offers.find(
              (candidate: { url?: string }) =>
                new URL(candidate.url || '', url).searchParams.get(
                  'variant',
                ) === variantId,
            )
          : offers.length === 1
            ? offers[0]
            : undefined
        if (!offer && typeof node.sku === 'string') offer = { sku: node.sku }
        break
      }
    } catch {
      // Malformed structured metadata must not prevent parsing visible specs.
    }
  })
  const values = new Map<string, Set<string>>()
  const seenLabels = new Set<string>()
  const fallbackPairs: Array<[string, string]> = []
  const add = (label: string, rawValue: string) => {
    const key = normalize(label)
      .replace(/[:：]$/, '')
      .trim()
      .toLowerCase()
    const value = normalize(rawValue)
    if (key) seenLabels.add(key)
    if (!value || /^(?:[\/—–-]|n\/?a)$/i.test(value)) return
    if (!values.has(key)) values.set(key, new Set())
    values.get(key)!.add(value)
  }

  // Restrict extraction to this product's specification accordion. Reading the
  // whole page also picks up recommendations and confuses blade grind/style.
  let $sections = $('details').filter((_, el) =>
    /^specifications?$/i.test(normalize($(el).find('summary').text())),
  )
  if (!$sections.length) {
    $sections = $('.product-info__description, [data-product-description]')
  }
  let text = ''
  $sections.each((_, section) => {
    const $content = $(section).clone()
    $content.find('summary, script, style').remove()
    $content
      .find('*')
      .addBack()
      .contents()
      .each((_, node) => {
        if (node.type === 'text') node.data = node.data.replace(/\s+/g, ' ')
      })
    $content.find('br').replaceWith('\n')
    $content.find('p, div, li, tr, h1, h2, h3, h4, h5, h6').append('\n')
    const $lines = $content.clone()
    $lines.find('table').remove()
    text += `\n${$lines.text()}`
    for (const line of $lines.text().split('\n')) {
      const match = line.match(/^\s*([^:：]{1,55})[:：]\s*(.*?)\s*$/)
      if (match) add(match[1], match[2])
      const clean = normalize(line)
      if (/^\d+(?:\s*[-~±]\s*\d+)?\s*HRC$/i.test(clean))
        fallbackPairs.push(['hardness', clean])
      if (
        /^(?:Satin|Stonewash(?:ed)?|Blackwash|Bead Blast) Finish$/i.test(clean)
      )
        fallbackPairs.push(['blade finish', clean.replace(/ Finish$/i, '')])
      if (
        /^(?:Crossbar|Cross-bar|Liner|Frame|Button|Top Liner|Trek|Vanchor) Lock$/i.test(
          clean,
        )
      )
        fallbackPairs.push(['lock type', clean])
    }
    $content.find('table').each((_, table) => {
      const $table = $(table)
      const colorRow = $table
        .find('tr')
        .filter((_, row) =>
          /^colou?r$/i.test(normalize($(row).children().first().text())),
        )
        .first()
      const colors = colorRow
        .children('td, th')
        .toArray()
        .map((cell) => normalize($(cell).text()).toLowerCase())
      let selectedColumn =
        typeof offer?.name === 'string'
          ? colors.indexOf(normalize(offer.name).toLowerCase())
          : -1
      if (selectedColumn < 1 && typeof offer?.sku === 'string') {
        const tokens = offer.sku.toLowerCase().split(/[\s/_-]+/)
        const matches = colors
          .map((color, index) => (tokens.includes(color) ? index : -1))
          .filter((index) => index > 0)
        if (matches.length === 1) selectedColumn = matches[0]
      }
      $table.find('tr').each((_, row) => {
        const cells = $(row).children('th, td')
        if (cells.length < 2) return
        const label = normalize(cells.first().text())
        const mappedLabel = /^size$/i.test(label) ? 'blade length' : label
        if (cells.length === 2) add(mappedLabel, cells.eq(1).text())
        else if (selectedColumn > 0)
          add(mappedLabel, cells.eq(selectedColumn).text())
        else
          cells.slice(1).each((_, cell) => {
            add(mappedLabel, $(cell).text())
          })
      })
    })
  })

  // Older kitchen pages render a desktop/mobile pair of heading/value lists.
  $sections
    .find('.specifications_ul li, .specifications_box li')
    .each((_, row) => {
      const $row = $(row)
      add($row.find('h3').first().text(), $row.find('p').first().text())
    })

  const explicitLabels = [...seenLabels]
  for (const [label, value] of fallbackPairs) {
    if (
      !explicitLabels.some(
        (seen) => seen === label || SPEC_FIELDS[seen] === SPEC_FIELDS[label],
      )
    ) {
      add(label, value)
    }
  }

  const warnings: string[] = []
  const blocked = new Set([...seenLabels].filter((label) => !values.has(label)))
  const read = (labels: string[], measurement?: 'length' | 'weight') => {
    const candidates = [
      ...new Set(labels.flatMap((label) => [...(values.get(label) ?? [])])),
    ]
    if (!candidates.length) return ''
    if (
      candidates.length > 1 ||
      (measurement &&
        measurementIsConflicting(candidates[0], measurement === 'weight'))
    ) {
      labels.forEach((label) => blocked.add(label))
      warnings.push(
        `Vosteed lists conflicting ${labels[0]} values (${candidates.join(' / ')}). This field was left empty; verify it before saving.`,
      )
      return ''
    }
    return candidates[0]
  }
  const specs: Partial<ScrapedProduct['specs']> = {}
  const labelsByField = new Map<keyof ScrapedProduct['specs'], string[]>()
  for (const [label, key] of Object.entries(SPEC_FIELDS)) {
    labelsByField.set(key, [...(labelsByField.get(key) ?? []), label])
  }
  for (const [key, labels] of labelsByField) {
    const measurement =
      key === 'weight'
        ? 'weight'
        : /Length|Thickness/.test(key)
          ? 'length'
          : undefined
    const value = read(labels, measurement)
    if (value) specs[key] = value
  }
  const handleMaterial = read(['handle material'])
  const bladeStyle = read(['blade style'])

  // Legacy kitchen pages combine blade steel and handle material in one row.
  const material = read(['material']).match(/^(.+?)\s+steel\s*\+\s*(.+)$/i)
  if (material) {
    specs.bladeMaterial ||= material[1]
  }
  if (
    !specs.modelNumber &&
    !blocked.has('model') &&
    typeof offer?.sku === 'string'
  )
    specs.modelNumber = normalize(offer.sku)

  const amount = $('meta[property="product:price:amount"]').attr('content')
  const currency = $('meta[property="product:price:currency"]').attr('content')
  const price = offer?.price ?? amount
  const priceCurrency = offer?.priceCurrency || currency
  if (price !== undefined && /^\d+(?:\.\d+)?$/.test(String(price))) {
    const formatted = Number(price).toFixed(2)
    specs.price = priceCurrency ? `${formatted} ${priceCurrency}` : formatted
  }
  return {
    specs,
    bladeStyle,
    handleMaterial: handleMaterial || material?.[2] || '',
    warnings,
    text,
    blocked,
  }
}
