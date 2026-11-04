import { readFileSync } from 'node:fs'
import * as cheerio from 'cheerio'
import { describe, expect, it } from 'vitest'
import { scrapeAndEnrichProduct, scrapeProduct } from '@/lib/scrape'

const url = 'https://www.sogknives.com/instinct-mini-g10-satin/'
const html = readFileSync(
  new URL(
    '../fixtures/scrape/sog-instinct-mini-g10-satin.html',
    import.meta.url,
  ),
  'utf8',
)
const imageFiles = [
  '13225/NB1002-CP_product_alt_1__24990__69036__87109-min__35198.1745880690.jpg',
  '6847/NB1002-CP_product_alt_vertical__02522__46360.1745880689.jpg',
  '6848/NB1002-CP_product_alt_2__44402__68690__30686.1745880689.jpg',
  '6849/NB1002-CP_product_alt_3__51802__36978__28621.1745880689.jpg',
  '6850/NB1002-CP_product_alt_4__95321__72803__43751.1745880690.jpg',
  '6851/NB1002-CP_product_alt_5__32150__59259__22047.1745880689.jpg',
  '6852/NB1002-CP_product_alt_6__64345__73211__11239.1745880690.jpg',
  '6853/NB1002-CP_product_alt_7__88896__66901__89210.1745880690.jpg',
  '6854/NB1002-CP_product_alt_8__17130__73701__95092.1745880690.jpg',
]
const expected = {
  name: 'Instinct Mini - G10, Satin',
  brand: 'SOG',
  bladeStyle: 'Clip Point',
  handleMaterial: 'Stainless Steel and G10',
  images: imageFiles.map(
    (file) =>
      `https://cdn11.bigcommerce.com/s-43l4b17cyb/images/stencil/original/products/581/${file}?c=2`,
  ),
  specs: {
    weight: '1.60 oz',
    overallLength: '4.8"',
    bladeLength: '1.9"',
    bladeThickness: '0.16"',
    bladeCoating: 'Satin Polished',
    bladeMaterial: '5Cr15MoV',
    lockingMechanism: '',
    designer: '',
    modelNumber: 'SOG-NB1002-CP',
    handleLength: '',
    hardness: 'Rc. 53-57',
    price: '44.95 USD',
    country: '',
  },
  sourceUrl: url,
}

describe('SOG product scraping', () => {
  it('imports the current product specs, full description, and nine original photos', async () => {
    const { product, confidence, warnings } = await scrapeAndEnrichProduct(
      html,
      url,
    )

    expect(product).toMatchObject(expected)
    expect(product.description).toMatch(/^There's a feeling and intuition/)
    expect(product.description).toMatch(/consider the SOG Instinct\.$/)
    expect(product.description).not.toMatch(/Free shipping|Other knife|</i)
    expect(confidence.brand).toBe(true)
    expect(confidence.specs.bladeLength).toBe(true)
    expect(confidence.specs.country).toBe(false)
    expect(confidence.specs.lockingMechanism).toBe(false)
    expect(warnings).toBeUndefined()
  })

  it('reads the embedded description before hydration without inventing missing specs', () => {
    const $ = cheerio.load(html)
    $('.productView-description').html('<div class="content-loading"></div>')
    $('.spec-items').empty()

    const { product } = scrapeProduct($.html(), url)

    expect(product.description).toBe(
      scrapeProduct(html, url).product.description,
    )
    expect(product).toMatchObject({
      ...expected,
      bladeStyle: '',
      handleMaterial: '',
      specs: {
        ...Object.fromEntries(
          Object.keys(expected.specs).map((key) => [key, '']),
        ),
        modelNumber: 'SOG-NB1002-CP',
        price: '44.95 USD',
      },
    })
  })

  it('leaves missing attributes empty despite unrelated page specifications', () => {
    const $ = cheerio.load(html)
    $('.spec-item')
      .filter((_, el) =>
        /^(?:Blade Shape|Handle Material|Hardness|Product Weight)$/.test(
          $(el).find('.label').text(),
        ),
      )
      .remove()
    $('aside')
      .append(`<div class="spec-item"><h3 class="label">Product Weight</h3><span class="value">9 oz</span></div>
      <p>Blade Shape: Drop Point<br>Handle Material: Titanium<br>Hardness: 60 HRC</p>`)

    const { product } = scrapeProduct($.html(), url)

    expect(product).toMatchObject({
      name: expected.name,
      bladeStyle: '',
      handleMaterial: '',
      specs: {
        hardness: '',
        weight: '',
        designer: '',
        country: '',
        handleLength: '',
      },
    })
    expect(product.images).toEqual(expected.images)
  })

  it('rejects conflicting attributes, contradictory unit pairs, and placeholder values', () => {
    const $ = cheerio.load(html)
    $('.spec-items')
      .append(`<div class="spec-item"><h3 class="label">Blade Shape</h3><span class="value">Drop Point</span></div>
      <div class="spec-item"><h3 class="label">Country of Origin</h3><span class="value">N/A</span></div>`)
    $('.spec-item')
      .filter((_, el) => $(el).find('.label').text() === 'Blade Length')
      .find('.value')
      .text('1.9" / 90mm')

    const { product, confidence, warnings } = scrapeProduct($.html(), url)

    expect(product.bladeStyle).toBe('')
    expect(product.specs.bladeLength).toBe('')
    expect(product.specs.country).toBe('')
    expect(confidence.specs.bladeLength).toBe(false)
    expect(warnings).toEqual([
      expect.stringContaining('conflicting blade shape values'),
      expect.stringContaining('conflicting blade length measurements'),
    ])
  })

  it('falls back to the main original image without importing engraving assets or videos', () => {
    const $ = cheerio.load(html)
    $('.productView-thumbnails').remove()

    expect(scrapeProduct($.html(), url).product.images).toEqual([
      expected.images[0],
    ])

    $('.productView').append(`<div class="productView-thumbnails">
      <a class="productView-thumbnail-link" href="${expected.images[0]}"></a>
      <a class="productView-thumbnail-link" href="${expected.images[0]}"></a>
      <a class="productView-thumbnail-link" href="https://www.youtube.com/watch?v=123"></a>
      <a class="productView-thumbnail-link" href="javascript:alert(1)"></a>
      </div>`)
    expect(scrapeProduct($.html(), url).product.images).toEqual([
      expected.images[0],
    ])
  })

  it('ignores malformed bootstrap data without executing it', () => {
    const $ = cheerio.load(html)
    $('.productView-description').empty()
    $('script').text('window.stencilBootstrap("product", "not JSON").load();')

    const { product } = scrapeProduct($.html(), url)

    expect(product.description).toBe('')
    expect(product.specs).toEqual(expected.specs)
  })

  it('keeps the adapter restricted to SOG product pages', () => {
    const generic = `<div class="productView"><h1 class="productView-title">Example Knife</h1></div>
      <table><tr><th>Blade Length</th><td>3 in.</td></tr></table>`
    for (const otherUrl of [
      'https://shop.example/knife',
      'https://sogknives.com.example/knife',
    ]) {
      const { product } = scrapeProduct(generic, otherUrl)
      expect(product.brand).toBe('')
      expect(product.specs.bladeLength).toBe('3 in')
    }
    expect(scrapeProduct(html, url.replace('www.', '')).product).toMatchObject({
      ...expected,
      sourceUrl: url.replace('www.', ''),
    })
  })
})
