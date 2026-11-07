import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { scrapeProduct } from '@/lib/scrape'

const url =
  'https://www.buckknives.com/product/110-slim-heritage-elite-knife/?sku=0110BRS19-B'
// Rendered page (as displayed in a browser) trimmed to the image viewer,
// structured data, and part of the "You may also like" recommendations.
const html = readFileSync(
  new URL(
    '../fixtures/scrape/buck-110-slim-heritage-elite-0110brs19-b.html',
    import.meta.url,
  ),
  'utf8',
)
const galleryFiles = [
  '24851/0110BRS19-B__78208.1780093733',
  '24852/0110BRS19-B_1__53914.1780093945',
  '24853/0110BRS19-B_2__49380.1780093945',
  '24854/0110BRS19-B_3__28805.1780093733',
  '24855/0110BRS19-B_4__59894.1780093945',
  '24856/0110BRS19-B_5__52816.1780093945',
  '24857/0110BRS19-B_6__02718.1780093981',
  '24858/0110BRS19-B_7__97630.1780094209',
  '24859/0110BRS19-B_8__14135.1780094208',
  '24957/0110BRS19-B_9__58988.1780094944',
]

describe('Buck Knives product pages', () => {
  it("keeps the selected SKU's gallery and leaves recommendations out", () => {
    const { product } = scrapeProduct(html, url)

    expect(product.name).toBe('110 Slim Heritage Elite Knife')
    expect(product.images).toEqual(
      galleryFiles.map(
        (file) =>
          `https://cdn11.bigcommerce.com/s-725cx91vwz/images/stencil/original/products/2571/${file}.386.513.png?c=2`,
      ),
    )
    // Recommendation cards and the variant-rule duplicate of the first photo.
    expect(product.images.join(' ')).not.toMatch(
      /0110BRS18-B|0110BRS-B|CKS110|attribute_(?:rule|value)_images/,
    )
  })

  it('falls back to the page images when the viewer is absent', () => {
    const { product } = scrapeProduct(
      html.replace(/product-image-viewer/g, 'image-area'),
      url,
    )

    expect(product.images).toContain(
      'https://cdn11.bigcommerce.com/s-725cx91vwz/product_images/attribute_rule_images/12696_source_1778193825.png',
    )
    expect(product.images.join(' ')).not.toMatch(/0110BRS18-B|CKS110/)
  })
})

describe('generic image extraction', () => {
  it('skips recommendation product cards that reuse product-image classes', () => {
    const { product } = scrapeProduct(
      `<html><head><title>Example Knife</title></head><body>
        <h1>Example Knife</h1>
        <div class="product-image"><img src="https://shop.example.com/media/example-knife.jpg"></div>
        <section class="related">
          <article class="product-card"><div class="product-image"><img src="https://shop.example.com/media/other-knife.jpg"></div></article>
          <div data-product-card><div class="product-image"><img src="https://shop.example.com/media/third-knife.jpg"></div></div>
        </section>
      </body></html>`,
      'https://shop.example.com/products/example-knife',
    )

    expect(product.images).toEqual([
      'https://shop.example.com/media/example-knife.jpg',
    ])
  })
})
