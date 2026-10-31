import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { scrapeAndEnrichProduct, scrapeProduct } from '@/lib/scrape'

const fixtures = {
  '0004': readFileSync(
    new URL('../fixtures/scrape/zt-0004.html', import.meta.url),
    'utf8',
  ),
  '0450': readFileSync(
    new URL('../fixtures/scrape/zt-0450.html', import.meta.url),
    'utf8',
  ),
}

describe('Zero Tolerance product scraping', () => {
  it('extracts the 0004 fixed blade without unrelated images or placeholder specs', () => {
    const url = 'https://zt.kaiusa.com/0004.html'
    const { product, confidence, warnings } = scrapeProduct(
      fixtures['0004'],
      url,
    )

    expect(product).toMatchObject({
      name: '0004',
      brand: 'Zero Tolerance',
      bladeStyle: 'Clip Point',
      handleMaterial: 'Micarta',
      images: [
        'https://zt.kaiusa.com/media/catalog/product/0/0/0004_profile_web.png',
        'https://zt.kaiusa.com/media/catalog/product/0/0/0004_back_web.png',
        'https://zt.kaiusa.com/media/catalog/product/0/0/0004_in-sheath_web.png',
      ],
      specs: {
        weight: '6.1 oz. (173 g)',
        overallLength: '',
        bladeLength: '4.2 in. (10.7 cm)',
        bladeThickness: '',
        bladeCoating: 'Cerakote',
        bladeMaterial: 'CPM Cru-Wear, Swedish steel',
        lockingMechanism: '',
        designer: 'ZT Originals',
        modelNumber: '0004',
        handleLength: '4.8 in. (12.2 cm)',
        hardness: '63-64',
        price: '288.00 USD',
        country: 'USA',
      },
      sourceUrl: url,
    })
    expect(product.description).toMatch(/^The 0004 workhorse/)
    expect(product.description).toContain('ready for paracord wrapping.')
    expect(product.description).toMatch(/can vary in both color and finish\.$/)
    expect(product.description).not.toMatch(/<p>|About|Features \+ Details/)
    expect(confidence.brand).toBe(true)
    expect(confidence.specs.lockingMechanism).toBe(false)
    expect(confidence.specs.overallLength).toBe(false)
    expect(confidence.specs.bladeThickness).toBe(false)
    expect(warnings).toBeUndefined()
  })

  it('preserves the listed lock, designer, and gallery for a folding knife', async () => {
    const url = 'https://zt.kaiusa.com/0450.html'
    const { product } = await scrapeAndEnrichProduct(fixtures['0450'], url)

    expect(product).toMatchObject({
      name: '0450',
      brand: 'Zero Tolerance',
      bladeStyle: 'Drop Point',
      handleMaterial: 'Titanium',
      images: [
        'https://zt.kaiusa.com/media/catalog/product/0/4/0450_profile_web.png',
        'https://zt.kaiusa.com/media/catalog/product/0/4/0450_in-hand_web.png',
        'https://zt.kaiusa.com/media/catalog/product/0/4/0450_back-open_web.png',
        'https://zt.kaiusa.com/media/catalog/product/0/4/0450_clipside-closed_web.png',
      ],
      specs: {
        weight: '2.9 oz. (82 g)',
        bladeLength: '3.25 in. (8.3 cm)',
        bladeCoating: 'Stonewashed and satin finish',
        bladeMaterial: 'CPM S35VN, Swedish steel',
        lockingMechanism: 'Titanium frame lock, hardened steel lockbar insert',
        designer: 'Dmitry Sinkevich',
        modelNumber: '0450',
        handleLength: '4.1 in. (10.4 cm)',
        hardness: '60–62',
        price: '240.00 USD',
        country: 'USA',
      },
    })
    expect(product.description).toMatch(
      /^A smaller, more pocket-friendly version/,
    )
    expect(product.description).toMatch(/lanyard hole$/)
  })

  it('uses the full authored description when only the initial HTML is available', () => {
    const html = `
      <script type="application/ld+json">{
        "@type": "Product", "name": "0004", "sku": "0004",
        "description": "0004 &lt;p&gt;Truncated description",
        "image": "https://zt.kaiusa.com/media/catalog/product/0/0/0004_profile_web.png"
      }</script>
      <div class="product-details">
        <div><div><h2 id="images">Images</h2></div><div><img src="about:error"></div></div>
        <div><div><h2 id="description">Description</h2></div><div><p>The complete product description with a canvas micarta handle.</p></div></div>
      </div>
      <div class="product-recommendations"><p>Blade Length: 99 in.</p></div>
    `
    const { product } = scrapeProduct(html, 'https://zt.kaiusa.com/0004.html')

    expect(product.description).toBe(
      'The complete product description with a canvas micarta handle.',
    )
    expect(product.brand).toBe('Zero Tolerance')
    expect(product.images).toEqual([
      'https://zt.kaiusa.com/media/catalog/product/0/0/0004_profile_web.png',
    ])
    expect(product.specs.bladeLength).toBe('')
  })

  it('keeps other stores on the standard extraction path', () => {
    for (const url of [
      'https://shop.example/0004.html',
      'https://zt.kaiusa.com.example/0004.html',
    ]) {
      const { product } = scrapeProduct(
        `<script type="application/ld+json">{"@type":"Product","description":"Structured description"}</script>
         <h1>Example knife</h1>
         <div class="product-details"><div class="pdp-description">ZT description</div></div>
         <table><tr><th>Blade Length</th><td>3 in.</td></tr></table>`,
        url,
      )
      expect(product.brand).toBe('')
      expect(product.description).toBe('Structured description')
      expect(product.specs.bladeLength).toBe('3 in')
    }
  })
})
