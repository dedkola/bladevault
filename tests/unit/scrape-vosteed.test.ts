import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { scrapeAndEnrichProduct, scrapeProduct } from '@/lib/scrape'

const fixture = (name: string) =>
  readFileSync(
    new URL(`../fixtures/scrape/vosteed-${name}.html`, import.meta.url),
    'utf8',
  )
const url = (name: string) => `https://www.vosteed.com/products/${name}`
const parse = (name: string) => scrapeProduct(fixture(name), url(name))

afterEach(() => vi.unstubAllGlobals())

describe('Vosteed product scraping', () => {
  it('imports the CheesePirates fields without guessing between conflicting source lengths', () => {
    const { product, confidence, warnings } = parse('cheesepirates-a2932')
    expect(product).toMatchObject({
      brand: 'Vosteed',
      bladeStyle: 'Drop Point',
      handleMaterial: 'G10',
      specs: {
        modelNumber: 'A2932',
        bladeLength: '3.25" | 82.60 mm',
        overallLength: '7.60" | 193.10 mm',
        bladeThickness: '0.118" | 3.00 mm',
        bladeMaterial: '14C28N',
        bladeCoating: 'Stonewash',
        hardness: 'HRC 59±1',
        handleLength: '',
        weight: '3.89 oz | 110.0 g',
        lockingMechanism: 'Top Liner Lock',
        designer: 'Yue Dong',
        price: '69.00 USD',
        country: '',
      },
    })
    expect(confidence.specs.handleLength).toBe(false)
    expect(warnings).toEqual([
      expect.stringContaining('conflicting handle length'),
    ])
  })

  it('keeps all supported Corgi V V fields separate from grind, widths, opener and clip material', () => {
    const { product, warnings } = parse('corgi-v-v-a5103')
    expect(product.bladeStyle).toBe('Drop Point')
    expect(product.handleMaterial).toBe('Aluminum')
    expect(product.specs).toEqual({
      modelNumber: 'A5103',
      bladeLength: '2.91" | 74.00 mm',
      overallLength: '7.06" | 179.20 mm',
      bladeThickness: '0.118" | 3.00 mm',
      bladeMaterial: '154CM',
      bladeCoating: 'Satin',
      hardness: 'HRC 60±1',
      handleLength: '4.14" | 105.20 mm',
      weight: '4.29 oz | 121.50 g',
      lockingMechanism: 'Vanchor Lock',
      designer: 'Yue Dong',
      price: '105.00 USD',
      country: '',
    })
    expect(warnings).toBeUndefined()
  })

  it('reads specifications embedded in the product description', () => {
    const { product } = parse('raccoon-2-0-top-liner-lock-a2905')
    expect(product).toMatchObject({
      bladeStyle: 'Drop Point',
      handleMaterial: 'Micarta',
      specs: {
        modelNumber: 'A2905',
        bladeMaterial: '14C28N',
        handleLength: '4.36" | 110.80 mm',
        weight: '3.65 oz | 103.40 g',
        lockingMechanism: 'Top Liner Lock',
      },
    })
  })

  it('reads legacy tables with labels in td cells and deduplicates desktop/mobile copies', () => {
    const { product, warnings } = parse('grind')
    expect(product).toMatchObject({
      bladeStyle: 'Drop Point',
      handleMaterial: 'Micarta',
      specs: {
        overallLength: '7.70 inch | 195.67 mm',
        bladeLength: '3.25 inch | 82.51 mm',
        handleLength: '4.46 inch | 113.16 mm',
        bladeCoating: 'Stonewashed',
        lockingMechanism: 'Adjustable Cross-bar Lock',
        modelNumber: 'GR-BK-SW-F',
      },
    })
    expect(warnings).toBeUndefined()
  })

  it('reads the legacy kitchen heading/value lists without inventing absent dimensions', () => {
    const { product } = parse('morgan-chef-knife')
    expect(product).toMatchObject({
      handleMaterial: 'G10',
      specs: {
        bladeMaterial: '9Cr18MoV',
        weight: '7.1 oz / 202 g',
        hardness: '58~60',
        bladeThickness: '2.0mm',
        bladeLength: '',
        overallLength: '',
        handleLength: '',
        lockingMechanism: '',
      },
    })
  })

  it('reads bare specification lines on exclusive retailer products', () => {
    const { product } = parse('wmk-exclusive-raccoon-crossbar-lock-rccwa4')
    expect(product).toMatchObject({
      handleMaterial: 'Aluminum',
      specs: {
        bladeMaterial: '14C28N',
        bladeCoating: 'Satin',
        hardness: '60-62HRC',
        lockingMechanism: 'Crossbar Lock',
        weight: '3.04oz',
        designer: 'Vosteed',
        handleLength: '4.36"',
      },
    })
  })

  it.each([
    ['h-back-d0401', 'bladeThickness', 'blade thickness'],
    ['marmoset-d0701', 'weight', 'weight'],
  ] as const)(
    'flags incompatible imperial/metric values on %s',
    (name, key, label) => {
      const result = parse(name)
      expect(result.product.specs[key]).toBe('')
      expect(result.confidence.specs[key]).toBe(false)
      expect(result.warnings).toEqual([
        expect.stringContaining(`conflicting ${label}`),
      ])
    },
  )

  it('selects the correct column, SKU and price for each kitchen variant', () => {
    const html = fixture('hackney-chef-knife-8-inch')
    const arctic = scrapeProduct(
      html,
      `${url('hackney-chef-knife-8-inch')}?variant=42789851398396`,
    )
    const ocean = scrapeProduct(
      html,
      `${url('hackney-chef-knife-8-inch')}?variant=42789851431164`,
    )
    expect(arctic.product.specs).toMatchObject({
      modelNumber: 'Hackney/Chef/Knife/green',
      bladeLength: '8 inch',
      bladeMaterial: '5Cr15MoV',
      hardness: '56±2 HRC',
      bladeCoating: 'Stonewashed',
      price: '45.99 USD',
    })
    expect(ocean.product.specs).toMatchObject({
      modelNumber: 'Hackney/Chef/Knife/blue',
      bladeLength: '8 inch',
      bladeMaterial: '5Cr15MoV',
      hardness: '56±2 HRC',
      bladeCoating: 'Handcrafted polished',
      price: '45.99 USD',
    })
    expect(arctic.warnings).toBeUndefined()
    expect(ocean.warnings).toBeUndefined()
  })

  it('does not fill intentionally empty fields from unrelated recommendations', () => {
    const html = fixture('raccoon-tislim-a4512').replace(
      '</body>',
      '<aside><p>Blade Material: S35VN<br>Weight: 6 oz<br>Handle Material: G10</p></aside></body>',
    )
    const { product } = scrapeProduct(html, url('raccoon-tislim-a4512'))
    expect(product.specs.bladeMaterial).toBe('')
    expect(product.specs.weight).toBe('')
    expect(product.handleMaterial).toBe('Titanium')
  })

  it('rejects conflicting aliases and materials even when fallback text contains a plausible value', () => {
    const html =
      '<details><summary>Specifications</summary><p>Handle Length: 4 in<br>Closed Length: 5 in<br>Handle Material: G10<br>Handle Material: Micarta<br>Blade Style: Drop Point<br>Blade Style: Tanto</p></details>'
    const result = scrapeProduct(html, url('conflict'))
    expect(result.product.specs.handleLength).toBe('')
    expect(result.product.handleMaterial).toBe('')
    expect(result.product.bladeStyle).toBe('')
    expect(result.warnings).toHaveLength(3)
  })

  it('limits site-specific extraction to Vosteed product URLs', () => {
    const html = '<table><tr><th>Blade Length</th><td>3.24 in</td></tr></table>'
    for (const source of [
      'https://shop.example/products/folder',
      'https://vosteed.com.example/products/folder',
    ]) {
      expect(scrapeProduct(html, source).product.specs.bladeLength).toBe(
        '3.24 in',
      )
    }
  })

  it('leaves explicitly empty handle material empty instead of using the backspacer metal', () => {
    const html =
      '<details><summary>Specifications</summary><p>Handle Material:<br>Backspacer Material: Aluminum<br>Blade Style:<br>Blade Grind: Flat</p></details>'
    const { product } = scrapeProduct(html, url('incomplete-specs'))
    expect(product.handleMaterial).toBe('')
    expect(product.bladeStyle).toBe('')
  })

  it('prefers labeled specifications over descriptive headings with different spelling or casing', () => {
    const html =
      '<div class="product-info__description"><h3>CROSS-BAR LOCK</h3><p>Lock Type: Crossbar Lock</p><h3>60HRC</h3><p>Hardness: HRC 60±1</p><h3>Satin Finish</h3><p>Blade Finish: Satin</p></div>'
    const { product, warnings } = scrapeProduct(html, url('raccoon'))
    expect(product.specs).toMatchObject({
      lockingMechanism: 'Crossbar Lock',
      hardness: 'HRC 60±1',
      bladeCoating: 'Satin',
    })
    expect(warnings).toBeUndefined()
  })

  it('retains rejected fields and warnings through Shopify enrichment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            product: {
              title: 'CheesePirates',
              vendor: 'Vosteed',
              body_html: '<p>Current product description</p>',
              images: [{ src: 'https://cdn.example/knife.jpg' }],
            },
          }),
        ),
      ),
    )
    const result = await scrapeAndEnrichProduct(
      fixture('cheesepirates-a2932') + '<!-- cdn.shopify.com -->',
      url('cheesepirates-a2932'),
    )
    expect(result.product.specs.handleLength).toBe('')
    expect(result.confidence.specs.handleLength).toBe(false)
    expect(result.product.images).toEqual(['https://cdn.example/knife.jpg'])
    expect(result.warnings).toEqual([
      expect.stringContaining('conflicting handle length'),
    ])
  })
})
