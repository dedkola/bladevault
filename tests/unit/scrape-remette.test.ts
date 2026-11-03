import { readFileSync } from 'node:fs'
import * as cheerio from 'cheerio'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  extractShopifyProduct,
  scrapeAndEnrichProduct,
  scrapeProduct,
} from '@/lib/scrape'

const { requestExternalUrl } = vi.hoisted(() => ({
  requestExternalUrl: vi.fn(),
}))
vi.mock('@/lib/external-http', () => ({ requestExternalUrl }))

vi.mock('dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]),
}))

const url =
  'https://www.remetteknife.com/products/remette-button-liner-lock-edc-knife-folding-pocket-outdoor-survival-edc-knife-hand-lapping-14c28n-blade-military-green-micarta-handle-rhino-mc25a'
const html = readFileSync(
  new URL('../fixtures/scrape/remette-rhino-mc25a.html', import.meta.url),
  'utf8',
)
const json = JSON.parse(
  readFileSync(
    new URL('../fixtures/scrape/remette-rhino-mc25a.json', import.meta.url),
    'utf8',
  ),
)
const imageFiles = [
  '1_267b60e1-5454-470c-a0a5-91ede139bdc1',
  '4_2841eb32-868a-4c6f-9227-39fd6c4bf895',
  '5_ed73158e-98ea-4864-8f47-5840fb699e2e',
  '6_448b15d5-cb5a-44e8-a8da-c009482f64e1',
  '7_3a75f648-94b9-4f2d-a153-5c621c5a2026',
  '8_0a346bf7-8fd3-452a-a593-88255be346bf',
  '9_144cdeff-48ba-472a-b3f5-c789bca4aa78',
  '10_36db90d1-08d8-44d2-9a10-d697f59f081c',
]
const pageImages = imageFiles.map(
  (file) =>
    `https://www.remetteknife.com/cdn/shop/files/${file}.jpg?v=1783134951`,
)
const expected = {
  name: 'Rhino',
  brand: 'REMETTE',
  bladeStyle: 'Drop Point',
  handleMaterial: 'Micarta',
  specs: {
    weight: '4.05oz / 114.82g',
    overallLength: '7.28" / 185mm',
    bladeLength: '3.07" / 78mm',
    bladeThickness: '0.12" / 3.0mm',
    bladeCoating: 'Ceramic Sandblasting Effect',
    bladeMaterial: '14C28N',
    lockingMechanism: 'Button+Liner Lock',
    modelNumber: 'MC25A',
    handleLength: '4.33" / 110mm',
    designer: '',
    hardness: '',
    price: '55.00 USD',
    country: '',
  },
  sourceUrl: url,
}

afterEach(() => requestExternalUrl.mockReset())

describe('Remette product scraping', () => {
  it('extracts the Rhino specs and original gallery without related product data', () => {
    const { product, confidence, warnings } = scrapeProduct(html, url)

    expect(product).toMatchObject(expected)
    expect(product.images).toEqual(pageImages)
    expect(product.description).toMatch(/^REMETTE Rhino/)
    expect(product.description).toContain('\nBlade Type: Drop Point\n')
    expect(product.description).not.toContain('RT-Peregrine Falcon')
    expect(confidence.specs.weight).toBe(true)
    expect(confidence.specs.designer).toBe(false)
    expect(confidence.specs.hardness).toBe(false)
    expect(confidence.specs.country).toBe(false)
    expect(warnings).toBeUndefined()
  })

  it('preserves normalized fields when Shopify enriches the product', async () => {
    const fetch = requestExternalUrl.mockResolvedValue(Response.json(json))

    expect(extractShopifyProduct(json, url)).toMatchObject({
      name: 'Rhino',
      brand: 'REMETTE',
    })
    const { product, warnings } = await scrapeAndEnrichProduct(html, url)

    expect(fetch).toHaveBeenCalledWith(
      new URL(`${url}.json`),
      { address: '8.8.8.8', family: 4 },
      expect.objectContaining({
        redirect: 'manual',
        signal: expect.any(AbortSignal),
      }),
    )
    expect(product).toMatchObject(expected)
    expect(product.images).toEqual(
      imageFiles.map(
        (file) =>
          `https://cdn.shopify.com/s/files/1/0840/0001/4630/files/${file}.jpg?v=1783134951`,
      ),
    )
    expect(warnings).toBeUndefined()
  })

  it.each(['unavailable', 'network error'])(
    'retains the complete gallery and specs when Shopify is %s',
    async (failure) => {
      if (failure === 'unavailable') {
        requestExternalUrl.mockResolvedValue(
          new Response(null, { status: 503 }),
        )
      } else {
        requestExternalUrl.mockRejectedValue(new Error('Network error'))
      }

      const { product, warnings } = await scrapeAndEnrichProduct(html, url)

      expect(product).toMatchObject(expected)
      expect(product.images).toEqual(pageImages)
      expect(warnings).toBeUndefined()
    },
  )

  it('keeps missing fields empty and reads Blade Type from the current product', () => {
    const { product, warnings } = scrapeProduct(
      `<aside><p>Model Name:REMETTE Other Knife<br>Weight: 100g<br>Handle Material: Titanium<br>Blade Type: Drop Point</p></aside>
       <div class="product-details"><div id="tab-description">
         <p>Model Name:REMETTE Scout Knife<br>Blade Material: 14C28N<br>Blade Type: Wharncliffe</p>
       </div></div>`,
      url,
    )

    expect(product.name).toBe('Scout')
    expect(product.bladeStyle).toBe('Wharncliffe')
    expect(product.handleMaterial).toBe('')
    expect(product.specs.weight).toBe('')
    expect(product.specs.bladeMaterial).toBe('14C28N')
    expect(warnings).toBeUndefined()
  })

  it('falls back to this product’s JSON-LD description when its detail section is absent', () => {
    const $ = cheerio.load(html)
    $('.product-details').remove()

    const { product, warnings } = scrapeProduct($.html(), url)

    expect(product).toMatchObject(expected)
    expect(warnings).toBeUndefined()
  })

  it('uses the store domain and price metadata when JSON-LD is absent', () => {
    const $ = cheerio.load(html)
    $('script, meta[property="og:site_name"]').remove()
    $('head').append(
      '<meta property="product:price:amount" content="55.00"><meta property="product:price:currency" content="USD">',
    )

    expect(scrapeProduct($.html(), url).product).toMatchObject(expected)
  })

  it('extracts the RT-BEE while leaving contradictory source measurements empty', () => {
    const beeHtml = readFileSync(
      new URL('../fixtures/scrape/remette-rt-bee-g.html', import.meta.url),
      'utf8',
    )
    const { product, confidence, warnings } = scrapeProduct(
      beeHtml,
      'https://www.remetteknife.com/products/remette-rt-bee-g-folding-pocket-knives',
    )

    expect(product).toMatchObject({
      name: 'RT-BEE',
      brand: 'REMETTE',
      handleMaterial: 'G10',
      bladeStyle: 'Drop Point',
      specs: {
        modelNumber: 'RT-BEE-G',
        weight: '3.55oz / 100g',
        overallLength: '6.97" / 177mm',
        bladeLength: '2.8" / 71mm',
        handleLength: '4.02" / 102mm',
        bladeThickness: '',
        bladeMaterial: '14C28N',
        bladeCoating: 'Ceramic Sand Spraying Process Surface Treatment',
        lockingMechanism: 'Line Lock',
        hardness: '58-59HRC',
        price: '57.00 USD',
      },
    })
    expect(confidence.specs.bladeThickness).toBe(false)
    expect(warnings).toEqual([
      expect.stringContaining('conflicting blade thickness measurements'),
    ])
  })

  it.each(['REMETTE', 'Remette', 'REMETTE KNIFE'])(
    'normalizes the brand alias %s',
    (vendor) => {
      expect(
        extractShopifyProduct({ product: { title: 'Rhino', vendor } })?.brand,
      ).toBe('REMETTE')
    },
  )

  it('keeps other stores and deceptive hostnames on the standard extraction path', () => {
    const title = 'REMETTE Folding Pocket Knife Rhino-MC25A'
    for (const sourceUrl of [
      'https://shop.example/products/rhino',
      'https://www.remetteknife.com.example/products/rhino',
    ]) {
      const body = '<p>Model Name:REMETTE Rhino Knife</p>'
      expect(
        scrapeProduct(`<h1>${title}</h1>${body}`, sourceUrl).product.name,
      ).toBe(title)
      expect(
        extractShopifyProduct(
          { product: { title, body_html: body } },
          sourceUrl,
        )?.name,
      ).toBe(title)
    }
  })
})
