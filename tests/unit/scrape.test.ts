import { describe, expect, it } from 'vitest'
import {
  extractShopifyProduct,
  getShopifyJsonUrl,
  isSecurityChallengePage,
  isShopifyProductPage,
  scrapeProduct,
} from '@/lib/scrape'

describe('product scraping', () => {
  it('extracts structured identity, images, description, and specifications', () => {
    const html = `
      <html><head>
        <script type="application/ld+json">
          {"@type":"Product","name":"Benchmade Bugout","brand":{"name":"Benchmade"},"description":"Light folder","image":["/one.jpg"]}
        </script>
      </head><body>
        <table>
          <tr><th>Blade Length</th><td>3.24 in</td></tr>
          <tr><th>Blade Material</th><td>CPM-S30V</td></tr>
          <tr><th>Country of Origin</th><td>USA</td></tr>
        </table>
        <p>Handle Material: Grivory<br>Blade Style: Drop Point</p>
      </body></html>
    `

    const { product, confidence } = scrapeProduct(
      html,
      'https://shop.example/products/bugout',
    )

    expect(product).toMatchObject({
      name: 'Benchmade Bugout',
      brand: 'Benchmade',
      description: 'Light folder',
      images: ['/one.jpg'],
      bladeStyle: 'Drop Point',
      handleMaterial: 'Grivory',
      specs: {
        bladeLength: '3.24 in',
        bladeMaterial: 'CPM-S30V',
        country: 'USA',
      },
    })
    expect(confidence.name).toBe(true)
    expect(confidence.specs.bladeLength).toBe(true)
  })

  it.each(['Kanseptknives', 'KANSEPTKNIVES', 'Kansept Knives', 'KANSEPT'])(
    'normalizes Kansept brand alias "%s" from page metadata and Shopify',
    (brand) => {
      const url =
        'https://kanseptknives.com/products/kansept-flank-fixed-blade-shred-carbon-fiber-handle-3-69-black-stonewashed-d2-blade-tuffknives-designed-g006a1'
      const name = 'KANSEPT Flank Fixed Blade G006A1'
      const metadata = [
        `<script type="application/ld+json">${JSON.stringify({
          '@type': 'Product',
          name,
          brand: { '@type': 'Brand', name: brand },
        })}</script>`,
        `<meta property="og:site_name" content="${brand}">`,
      ]

      for (const head of metadata) {
        const html = `<html><head>${head}</head><body><h1>${name}</h1></body></html>`
        const { product, confidence } = scrapeProduct(html, url)
        expect(product.brand).toBe('Kansept')
        expect(confidence.brand).toBe(true)
      }

      expect(
        extractShopifyProduct({ product: { title: name, vendor: brand } })
          ?.brand,
      ).toBe('Kansept')
    },
  )

  it('detects security interstitials without treating short normal pages as challenges', () => {
    expect(
      isSecurityChallengePage(
        `<html>${'x'.repeat(120)} Just a moment... challenges.cloudflare.com</html>`,
      ),
    ).toBe(true)
    expect(isSecurityChallengePage('<html>Just a moment...</html>')).toBe(false)
  })

  it('merges JSON-LD and rendered gallery images while excluding video thumbnails', () => {
    const html = `
      <html><head>
        <script type="application/ld+json">
          {"@type":"Product","name":"Razel","image":"https://cdn.example/structured.jpg"}
        </script>
      </head><body>
        <div class="product-gallery">
          <img alt="Razel fixed profile" src="https://cdn.example/profile.jpg">
          <img alt="Razel angled tip" src="https://cdn.example/images/stencil/3840w/tip.jpg">
          <img alt="Video Thumbnail" src="https://img.youtube.com/vi/example/hqdefault.jpg">
        </div>
        <img class="option-swatch" alt="Black D2 G10" src="https://cdn.example/products/variant.jpg">
      </body></html>
    `

    expect(
      scrapeProduct(html, 'https://shop.example/razel').product.images,
    ).toEqual([
      'https://cdn.example/structured.jpg',
      'https://cdn.example/profile.jpg',
      'https://cdn.example/images/stencil/original/tip.jpg',
    ])
  })

  it('extracts Poikilo product details without recommendations or footer content', () => {
    const html = `
      <html><body><div class="product-detail">
        <div class="image-gallery">
          <div class="thumbnail-item"><img src="/photos/one.png"></div>
          <div class="thumbnail-item"><img src="/photos/two.png"></div>
          <div class="main-image"><img src="/photos/one.png"></div>
        </div>
        <div class="product-info">
          <h1>TASK-DENZOKU STD DSW</h1>
          <div class="price-section"><span class="price-amount">$640.00</span><span class="price-currency">USD</span></div>
          <div class="specifications"><ul>
            <li>Overall Length: 8.35 "</li><li>Weight: 6.14 oz</li>
            <li>Blade Finish: Physical Vapor Deposition (PVD)</li>
            <li>Blade Material: M398</li><li>Blade Style: Modified Tanto</li>
            <li>Blade Thickness: 0.157 "</li><li>Blade Length: 3.70 "</li>
            <li>Handle Material: Titanium (Ti)</li><li>Handle Length: 4.65 "</li>
            <li>Lockbar: TASK Lock</li>
          </ul></div>
        </div>
        <div class="recommendations"><img src="/product/recommended.png"><p>Blade Material: D2</p></div>
      </div><footer><p>© 2026 POIKILO BLADE · Privacy Policy · Contact Information</p></footer></body></html>
    `
    const { product } = scrapeProduct(
      html,
      'https://poikiloblade.com/shop/product/228?cateId=35,81,96',
    )
    expect(product).toMatchObject({
      name: 'TASK-DENZOKU STD DSW',
      brand: 'Poikilo Blade',
      description: '',
      images: [
        'https://poikiloblade.com/photos/one.png',
        'https://poikiloblade.com/photos/two.png',
      ],
      bladeStyle: 'Modified Tanto',
      handleMaterial: 'Titanium (Ti)',
      specs: {
        overallLength: '8.35 "',
        weight: '6.14 oz',
        bladeCoating: 'Physical Vapor Deposition (PVD)',
        bladeMaterial: 'M398',
        bladeThickness: '0.157 "',
        bladeLength: '3.70 "',
        handleLength: '4.65 "',
        lockingMechanism: 'TASK Lock',
        price: '640.00 USD',
      },
    })
  })

  it('recognizes and extracts Shopify product data', () => {
    const url = 'https://shop.example/products/bugout?variant=1#details'
    expect(getShopifyJsonUrl(url)).toBe(
      'https://shop.example/products/bugout.json',
    )
    expect(isShopifyProductPage(url, 'cdn.shopify.com')).toBe(true)
    expect(
      extractShopifyProduct({
        product: {
          title: ' Bugout ',
          vendor: ' Benchmade ',
          body_html: '<p>Light <strong>folder</strong></p>',
          images: [{ src: 'https://cdn.example/one.jpg' }],
        },
      }),
    ).toEqual({
      name: 'Bugout',
      brand: 'Benchmade',
      description: 'Light folder',
      images: ['https://cdn.example/one.jpg'],
    })

    expect(
      extractShopifyProduct(
        {
          product: {
            variants: [
              { id: 1, sku: 'SMALL', price: '425.00' },
              { id: 2, sku: 'LARGE', price: '500.00' },
            ],
          },
        },
        'https://shop.example/products/sebenza?variant=2',
      ),
    ).toEqual({
      specs: { modelNumber: 'LARGE', price: '500.00' },
    })
  })

  it('extracts colonless heading/value specification cards without matching marketing prose', () => {
    const html = `
      <html><head>
        <script type="application/ld+json">
          {"@type":"Product","name":"Bugout","sku":"535GRY-1","offers":{"@type":"Offer","price":"180.00","priceCurrency":"USD"}}
        </script>
      </head><body>
        <p>This lightweight folder will be ready when you are.</p>
        <section>
          <div><h4>Open Length</h4><p>7.46'' | 18.95cm</p></div>
          <div><h4>Blade Length</h4><p>3.24'' | 8.23cm</p></div>
          <div><h4>Blade Thickness</h4><p>0.09'' | 2.29mm</p></div>
          <div><h4>Closed Length</h4><p>4.22'' | 10.72cm</p></div>
          <div><h4>Weight</h4><p>1.85oz | 52.45g</p></div>
          <div><h4>Blade Steel</h4><p>S30V Stainless Steel</p></div>
          <div><h4>Blade Finish</h4><p>Cerakote®</p></div>
          <div><h4>Mechanism</h4><p>AXIS® Lock</p></div>
          <div><h4>Blade Style</h4><p>Drop-Point</p></div>
          <div><h4>Handle Material</h4><p>Grivory®</p></div>
        </section>
      </body></html>
    `

    expect(
      scrapeProduct(html, 'https://benchmade.example/bugout').product,
    ).toMatchObject({
      bladeStyle: 'Drop-Point',
      handleMaterial: 'Grivory®',
      specs: {
        modelNumber: '535GRY-1',
        price: '180.00 USD',
        overallLength: "7.46'' | 18.95cm",
        bladeLength: "3.24'' | 8.23cm",
        bladeThickness: "0.09'' | 2.29mm",
        handleLength: "4.22'' | 10.72cm",
        weight: '1.85oz | 52.45g',
        bladeMaterial: 'S30V Stainless Steel',
        bladeCoating: 'Cerakote®',
        lockingMechanism: 'AXIS® Lock',
      },
    })
  })

  it('extracts plain td rows and alternating definition-list specifications', () => {
    const html = `
      <html><head>
        <meta property="og:price:amount" content="369">
        <meta property="og:price:currency" content="USD">
      </head><body>
        <table>
          <tr><td>Model Number</td><td>"T2030C1"</td></tr>
          <tr><td>Overall Length</td><td>7.84" / 199.14 mm</td></tr>
          <tr><td>Blade Material</td><td>154CM</td></tr>
        </table>
        <dl>
          <dt>Blade Length</dt><dd>3.40"</dd>
          <dt>Blade Thickness</dt><dd>0.10"</dd>
          <dt>Total Weight</dt><dd>2.78oz</dd>
          <dt>Blade Hardness</dt><dd>63-64 HRC</dd>
          <dt>Closed Length</dt><dd>4.50"</dd>
        </dl>
      </body></html>
    `

    expect(
      scrapeProduct(html, 'https://shop.example/products/knife').product.specs,
    ).toMatchObject({
      modelNumber: 'T2030C1',
      price: '369.00 USD',
      overallLength: '7.84" / 199.14 mm',
      bladeLength: '3.40"',
      bladeThickness: '0.10"',
      bladeMaterial: '154CM',
      handleLength: '4.50"',
      hardness: '63-64 HRC',
      weight: '2.78oz',
    })
  })

  it('rejects prose captured after weight, hardness, designer, and mechanism labels', () => {
    const html = `
      <h3>Weight</h3><p>Built to feel lightweight in hand</p>
      <h3>Hardness</h3><p>This steel has excellent toughness and edge retention</p>
      <h3>Designer</h3><p>Kit retired as a ranking Master Sergeant and became a high profile maker whose influence was felt far and wide.</p>
      <h3>Mechanism</h3><p>Washers</p>
    `
    const specs = scrapeProduct(html, 'https://shop.example/knife').product
      .specs
    expect(specs.weight).toBe('')
    expect(specs.hardness).toBe('')
    expect(specs.designer).toBe('')
    expect(specs.lockingMechanism).toBe('')
  })

  it('rejects contradictory imperial and metric measurements', () => {
    const html = `
      <table>
        <tr><th>Weight</th><td>6.5oz / 39g</td></tr>
        <tr><th>Blade Length</th><td>3.5in / 20mm</td></tr>
      </table>
    `
    const result = scrapeProduct(html, 'https://shop.example/knife')
    expect(result.product.specs.weight).toBe('')
    expect(result.product.specs.bladeLength).toBe('')
    expect(result.warnings).toEqual([
      expect.stringContaining('conflicting weight measurements'),
      expect.stringContaining('conflicting blade length measurements'),
    ])
  })
})
