import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  extractShopifyProduct,
  scrapeAndEnrichProduct,
  scrapeProduct,
} from '@/lib/scrape'

const cases = [
  {
    fixture: 'tenable-entity-b1036h3',
    url: 'https://www.tenableknives.com/collections/new-arrivals/products/tenable-entity-b1036h3',
    title:
      'Tenable Entity Top Liner Lock Folding Knife | 3.52“ Blackwash 14C28N Blade | Black G10 Handle | Nalu Knives Design - B1036H3',
    brand: 'Tenable',
    name: 'Entity',
    bladeStyle: 'Drop-point',
    handleMaterial: 'Black G10',
    specs: {
      modelNumber: 'B1036H3',
      bladeLength: "3.52''/89.4mm",
      overallLength: "8.11''/206.1mm",
      bladeThickness: '0.118" / 3.0mm',
      weight: '4.45oz/126.2g',
      bladeMaterial: '14C28N',
      bladeCoating: 'Blackwash',
      lockingMechanism: 'Top Liner Lock',
      designer: 'Nalu Knives',
      handleLength: '',
      hardness: '',
      country: '',
      price: '68.89 USD',
    },
  },
  {
    fixture: 'artisan-mousebird-1889g-mgn',
    url: 'https://artisancutlery.net/products/artisancutlery-mousebird-thumb-hole-top-liner-lock-edc-knife-micarta-handle-titanium-clip3-n690-stone-wash-blade-1889g-mgn?_pos=4&_sid=ead53aa8b&_ss=r',
    title:
      "ArtisanCutlery Mousebird Thumb Hole Top Liner Lock EDC Knife Micarta Handle Steel Clip(3'' N690 Stone Wash Blade ) 1889G-MGN",
    brand: 'Artisan Cutlery',
    name: 'Mousebird',
    bladeStyle: 'Clip point',
    handleMaterial: 'Micarta',
    specs: {
      modelNumber: '1889G-MGN',
      bladeLength: '3"(76mm)',
      overallLength: '7"(178mm)',
      bladeThickness: '0.13"(3.2mm)',
      weight: '75.7g/2.68oz',
      bladeMaterial: 'N690',
      bladeCoating: 'Stone Wash',
      lockingMechanism: 'Top liner lock',
      designer: 'Dustin Rhodes',
      handleLength: '4"(102mm)',
      hardness: 'HRC60-62',
      country: '',
      price: '69.99 USD',
    },
  },
]

afterEach(() => vi.unstubAllGlobals())

describe('issue #379 retailer field normalization', () => {
  it.each(cases)('extracts $name fields from the captured page', (test) => {
    const html = readFileSync(
      new URL(`../fixtures/scrape/${test.fixture}.html`, import.meta.url),
      'utf8',
    )
    const { product, confidence, warnings } = scrapeProduct(html, test.url)
    expect(product).toMatchObject({
      name: test.name,
      brand: test.brand,
      bladeStyle: test.bladeStyle,
      handleMaterial: test.handleMaterial,
      specs: test.specs,
      sourceUrl: test.url,
    })
    expect(confidence.specs.designer).toBe(true)
    expect(warnings).toBeUndefined()
  })

  it.each(cases)(
    'preserves $name normalization after Shopify enrichment',
    async (test) => {
      const html = readFileSync(
        new URL(`../fixtures/scrape/${test.fixture}.html`, import.meta.url),
        'utf8',
      )
      const bodyHtml = html.match(
        /<div class="product-description">([\s\S]*)<\/div>/,
      )![1]
      const json = {
        product: {
          title: test.title,
          vendor: test.brand === 'Tenable' ? 'Tenable Knives' : test.brand,
          body_html: bodyHtml,
          variants: [{ sku: test.specs.modelNumber }],
        },
      }
      expect(extractShopifyProduct(json, test.url)).toMatchObject({
        name: test.name,
        brand: test.brand,
      })
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(json)))
      const { product } = await scrapeAndEnrichProduct(html, test.url)
      expect(product).toMatchObject({
        name: test.name,
        brand: test.brand,
        bladeStyle: test.bladeStyle,
        specs: test.specs,
      })
    },
  )

  it('does not use grind as blade shape when no shape is supplied', () => {
    const { product } = scrapeProduct(
      '<table><tr><td>Blade Grind</td><td>Flat</td></tr></table>',
      'https://shop.example/knife',
    )
    expect(product.bladeStyle).toBe('')
  })

  it('keeps unfamiliar titles and other retailers on the regular fallback', () => {
    const title = 'ArtisanCutlery Mousebird Thumb Hole Folding Knife'
    for (const url of [
      'https://shop.example/knife',
      'https://artisancutlery.net.example/knife',
    ]) {
      expect(scrapeProduct(`<h1>${title}</h1>`, url).product.name).toBe(title)
    }
    expect(
      scrapeProduct(
        '<h1>Artisan Cutlery Special Edition</h1>',
        'https://artisancutlery.net/products/special',
      ).product.name,
    ).toBe('Artisan Cutlery Special Edition')
  })

  it('reads a model label without losing the brand in the original title', () => {
    const { product } = scrapeProduct(
      '<h1>Benchmade Bugout Folding Knife</h1><dl><dt>Model Name</dt><dd>Bugout</dd></dl>',
      'https://shop.example/knife',
    )
    expect(product.name).toBe('Bugout')
    expect(product.brand).toBe('Benchmade')
  })

  it('ignores designer credits outside the product description', () => {
    const { product } = scrapeProduct(
      `<script type="application/ld+json">{"@type":"Product","description":"Designed by you."}</script>
       <aside><p>Designed by A Different Product Designer.</p></aside>`,
      'https://shop.example/knife',
    )
    expect(product.specs.designer).toBe('')
  })

  it.each(['ArtisanCutlery', 'Artisancutlery.net', 'ARTISAN CUTLERY'])(
    'normalizes the Artisan brand alias %s',
    (brand) => {
      expect(
        scrapeProduct(
          `<meta property="og:site_name" content="${brand}"><h1>Mousebird</h1>`,
          'https://artisancutlery.net/products/mousebird',
        ).product.brand,
      ).toBe('Artisan Cutlery')
      expect(extractShopifyProduct({ product: { vendor: brand } })?.brand).toBe(
        'Artisan Cutlery',
      )
    },
  )
})
