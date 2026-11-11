import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { scrapeAndEnrichProduct, scrapeProduct } from '@/lib/scrape'

const url =
  'https://www.straightlineedc.com/en/bigger-digger-natural-micarta-bdg-nc-p982558.html'
const html = readFileSync(
  new URL(
    '../fixtures/scrape/straightlineedc-bigger-digger-natural-micarta-bdg-nc.html',
    import.meta.url,
  ),
  'utf8',
)

describe('Straight Line EDC product scraping', () => {
  it('extracts the product, specs, and price from the page and its JSON-LD', async () => {
    const { product } = await scrapeAndEnrichProduct(html, url)

    expect(product.name).toBe('Bigger Digger Natural Micarta')
    expect(product.brand).toBe('StraightLine EDC')
    expect(product.handleMaterial).toBe('Canvas Micarta')
    expect(product.specs).toMatchObject({
      overallLength: '191.00 mm - 7.52 in',
      bladeLength: '95.00 mm - 3.74 in',
      bladeThickness: '2.70 mm - 0.11 in',
      bladeMaterial: '14C28N',
      bladeCoating: 'Stonewashed',
      hardness: 'HRC 58-60',
      weight: '90 gr - 3.17 oz',
      designer: 'David C Andersen & Igor Bortolussi',
      modelNumber: 'BDG-NC',
      price: '79.90 EUR',
      country: 'China',
    })
  })

  it('reads full-size gallery photos from the site root set by <base href>', () => {
    const { product } = scrapeProduct(html, url)

    expect(product.images).toEqual(
      [119444, 624773, 618813, 573523, 696140, 83746].map(
        (id) =>
          `https://www.straightlineedc.com/files/${id}/bigger-digger-natural-micarta.webp`,
      ),
    )
  })

  it('keeps the description paragraphs and list without the related products', () => {
    const { product } = scrapeProduct(html, url)

    expect(product.description).toMatch(
      /^Bigger Digger\n\n"Same friendship, same philosophy — just more knife\."\n\nThe Digger grown up/,
    )
    expect(product.description).toContain(
      "it's corrosion-resistant, easy to maintain, and ready for real work.",
    )
    expect(product.description).toContain(
      'Key Features\n\nCollaboration with David C. Andersen\n\nCompact EDC fixed blade',
    )
    expect(product.description).not.toMatch(
      /\t|\u00A0|\n{3,}|Keybar|Pocket clip/i,
    )
  })

  it("reads JSON-LD that escapes apostrophes as \\'", () => {
    const { product } = scrapeProduct(
      `<script type="application/ld+json">
        {"@type":"Product","name":"Test Knife","description":"It\\'s sharp",
         "brand":{"@type":"Brand","name":"Maker"},"sku":"TK-1",
         "offers":{"@type":"Offer","price":"10.00","priceCurrency":"EUR"}}
      </script>`,
      'https://example.com/test-knife',
    )

    expect(product).toMatchObject({
      name: 'Test Knife',
      brand: 'Maker',
      description: "It's sharp",
      specs: { modelNumber: 'TK-1', price: '10.00 EUR' },
    })
  })
})
