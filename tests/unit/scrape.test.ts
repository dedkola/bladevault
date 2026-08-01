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

  it('detects security interstitials without treating short normal pages as challenges', () => {
    expect(
      isSecurityChallengePage(
        `<html>${'x'.repeat(120)} Just a moment... challenges.cloudflare.com</html>`,
      ),
    ).toBe(true)
    expect(isSecurityChallengePage('<html>Just a moment...</html>')).toBe(false)
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
  })
})
