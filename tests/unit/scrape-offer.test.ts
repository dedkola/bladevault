import { readFileSync } from 'node:fs'
import * as cheerio from 'cheerio'
import { describe, expect, it } from 'vitest'
import {
  extractOffer,
  extractShopifyOffer,
  getShopifyProductJsUrl,
  normalizeAvailability,
} from '@/lib/scrape-offer'
import { amazonMarketplaceCurrency } from '@/lib/scrape-amazon'

const fixture = (name: string) =>
  cheerio.load(
    readFileSync(
      new URL(`../fixtures/scrape/${name}.html`, import.meta.url),
      'utf8',
    ),
  )

const page = (body: string, head = '') =>
  cheerio.load(`<html><head>${head}</head><body>${body}</body></html>`)

const jsonLd = (data: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(data)}</script>`

describe('normalizeAvailability', () => {
  it.each([
    ['https://schema.org/InStock', 'in_stock'],
    ['http://schema.org/OutOfStock', 'out_of_stock'],
    ['SoldOut', 'out_of_stock'],
    ['Discontinued', 'out_of_stock'],
    ['https://schema.org/PreOrder', 'preorder'],
    ['BackOrder', 'preorder'],
    ['LimitedAvailability', 'limited'],
    ['in stock', 'in_stock'],
    ['oos', 'out_of_stock'],
    ['something else', 'unknown'],
    [undefined, 'unknown'],
  ])('maps %s', (value, expected) => {
    expect(normalizeAvailability(value)).toBe(expected)
  })
})

describe('extractOffer from saved product pages', () => {
  it.each([
    [
      'kershaw-beskar-1439',
      'https://kershaw.kaiusa.com/beskar.html',
      'in_stock',
    ],
    [
      'remette-rt-bee-g',
      'https://www.remetteknife.com/product/rt-bee-g',
      'out_of_stock',
    ],
    [
      'straightlineedc-bigger-digger-natural-micarta-bdg-nc',
      'https://straightlineedc.com/en/bigger-digger',
      'in_stock',
    ],
  ])('%s', (name, url, availability) => {
    const offer = extractOffer(fixture(name), url)
    expect(offer).toMatchObject({ method: 'jsonld', availability })
    expect(offer?.amount).toBeGreaterThan(0)
    expect(offer?.currency).toMatch(/^[A-Z]{3}$/)
  })
})

describe('extractOffer', () => {
  it('selects the JSON-LD offer for the variant in the URL', () => {
    const $ = page(
      jsonLd({
        '@type': 'Product',
        name: 'Knife',
        offers: [
          {
            '@type': 'Offer',
            url: '/products/knife?variant=1',
            price: '100.00',
            priceCurrency: 'USD',
            availability: 'https://schema.org/InStock',
          },
          {
            '@type': 'Offer',
            url: '/products/knife?variant=2',
            price: '120.00',
            priceCurrency: 'USD',
            availability: 'https://schema.org/OutOfStock',
          },
        ],
      }),
    )
    expect(
      extractOffer($, 'https://shop.example/products/knife?variant=2'),
    ).toEqual({
      amount: 120,
      currency: 'USD',
      availability: 'out_of_stock',
      method: 'jsonld',
    })
  })

  it('reads AggregateOffer, ProductGroup variants and priceSpecification', () => {
    const aggregate = page(
      jsonLd({
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'Organization', name: 'Shop' },
          {
            '@type': 'Product',
            offers: {
              '@type': 'AggregateOffer',
              lowPrice: 80,
              priceCurrency: 'EUR',
              offers: [
                {
                  '@type': 'Offer',
                  priceSpecification: { price: 89.5, priceCurrency: 'EUR' },
                  availability: 'InStock',
                },
              ],
            },
          },
        ],
      }),
    )
    expect(extractOffer(aggregate, 'https://shop.example/p')).toMatchObject({
      amount: 89.5,
      currency: 'EUR',
      availability: 'in_stock',
    })

    const group = page(
      jsonLd({
        '@type': 'ProductGroup',
        hasVariant: [
          {
            '@type': 'Product',
            offers: {
              '@type': 'Offer',
              url: 'https://shop.example/p?variant=7',
              price: '59.00',
              priceCurrency: 'GBP',
              availability: 'https://schema.org/PreOrder',
            },
          },
        ],
      }),
    )
    expect(extractOffer(group, 'https://shop.example/p')).toMatchObject({
      amount: 59,
      currency: 'GBP',
      availability: 'preorder',
    })
  })

  it('prefers the storefront’s active currency, as Add-from-link does', () => {
    const $ = page(
      jsonLd({
        '@type': 'Product',
        offers: { price: '150.00', priceCurrency: 'USD' },
      }),
      '<script>Shopify.currency = {"active":"CAD","rate":"1.0"};</script>',
    )
    expect(extractOffer($, 'https://shop.example/p')).toMatchObject({
      amount: 150,
      currency: 'CAD',
    })
  })

  it('falls back to microdata of the first product only', () => {
    const $ = page(`
      <div itemscope itemtype="https://schema.org/Product">
        <h1 itemprop="name">Knife</h1>
        <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
          <meta itemprop="price" content="210.00">
          <meta itemprop="priceCurrency" content="USD">
          <link itemprop="availability" href="https://schema.org/InStock">
        </div>
      </div>
      <div itemscope itemtype="https://schema.org/Product">
        <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
          <meta itemprop="price" content="15.00">
        </div>
      </div>`)
    expect(extractOffer($, 'https://shop.example/p')).toEqual({
      amount: 210,
      currency: 'USD',
      availability: 'in_stock',
      method: 'microdata',
    })
  })

  it('falls back to Open Graph meta and borrows stock status', () => {
    const $ = page(
      `<div itemscope itemtype="https://schema.org/Product">
        <link itemprop="availability" href="https://schema.org/OutOfStock">
      </div>`,
      `<meta property="product:price:amount" content="75.00">
       <meta property="product:price:currency" content="usd">`,
    )
    expect(extractOffer($, 'https://shop.example/p')).toEqual({
      amount: 75,
      currency: 'USD',
      availability: 'out_of_stock',
      method: 'meta',
    })
  })

  it('reports a sold-out product without a price', () => {
    const $ = page(
      jsonLd({
        '@type': 'Product',
        offers: { availability: 'https://schema.org/SoldOut' },
      }),
    )
    expect(extractOffer($, 'https://shop.example/p')).toEqual({
      amount: null,
      currency: '',
      availability: 'out_of_stock',
      method: 'jsonld',
    })
  })

  it('returns null when the page has no offer data', () => {
    expect(
      extractOffer(page('<h1>Knife</h1><p>$99</p>'), 'https://shop.example/p'),
    ).toBeNull()
  })

  it('skips malformed JSON-LD and keeps looking', () => {
    const $ = page(
      `<script type="application/ld+json">{ broken</script>${jsonLd({
        '@type': 'Product',
        offers: { price: 42, priceCurrency: 'USD' },
      })}`,
    )
    expect(extractOffer($, 'not a url')).toMatchObject({ amount: 42 })
  })
})

describe('Amazon offers', () => {
  const amazon = (buyBox: string) =>
    page(`<span id="productTitle">Vosteed Raccoon Pocket Knife</span>${buyBox}`)

  it('reads the buy-box price in the marketplace currency', () => {
    const $ = amazon(`
      <div id="corePriceDisplay_desktop_feature_div">
        <span class="a-price priceToPay"><span class="a-offscreen">$64.99</span></span>
      </div>
      <div id="availability"><span>In Stock</span></div>`)
    expect(extractOffer($, 'https://www.amazon.ca/dp/B0FRRWK52D')).toEqual({
      amount: 64.99,
      currency: 'CAD',
      availability: 'in_stock',
      method: 'amazon',
    })
    expect(
      extractOffer($, 'https://www.amazon.com/dp/B0FRRWK52D'),
    ).toMatchObject({ currency: 'USD' })
  })

  it('reads dot-thousands prices on European marketplaces', () => {
    const $ = amazon(`
      <div id="corePrice_feature_div">
        <span class="a-price"><span class="a-offscreen">1.249,00 €</span></span>
      </div>
      <div id="availability">Nur noch 2 auf Lager</div>`)
    expect(extractOffer($, 'https://www.amazon.de/dp/B0FRRWK52D')).toEqual({
      amount: 1249,
      currency: 'EUR',
      availability: 'limited',
      method: 'amazon',
    })
  })

  it.each([
    ['Currently unavailable.', 'out_of_stock'],
    ['Temporarily out of stock.', 'out_of_stock'],
    ['Only 3 left in stock - order soon.', 'limited'],
    ['Available to ship in 1-2 days.', 'in_stock'],
    ['Pre-order now', 'preorder'],
    ['No disponible por el momento.', 'out_of_stock'],
  ])('maps availability "%s"', (text, availability) => {
    const $ = amazon(`<div id="availability">${text}</div>`)
    expect(extractOffer($, 'https://www.amazon.com/dp/B0FRRWK52D')).toEqual({
      amount: null,
      currency: '',
      availability,
      method: 'amazon',
    })
  })

  it('treats the out-of-stock buy box as out of stock', () => {
    const $ = amazon('<div id="outOfStock">See all buying options</div>')
    expect(
      extractOffer($, 'https://www.amazon.com/dp/B0FRRWK52D')?.availability,
    ).toBe('out_of_stock')
  })

  it('ignores non-product pages such as the checkpoint', () => {
    const $ = fixture('amazon-checkpoint')
    expect(extractOffer($, 'https://www.amazon.com/dp/B0FRRWK52D')).toBeNull()
  })

  it('maps marketplaces to currencies', () => {
    expect(amazonMarketplaceCurrency('https://www.amazon.co.uk/dp/X')).toBe(
      'GBP',
    )
    expect(amazonMarketplaceCurrency('https://www.amazon.com.mx/dp/X')).toBe(
      'MXN',
    )
    expect(amazonMarketplaceCurrency('https://www.amazon.co.jp/dp/X')).toBe(
      'JPY',
    )
    expect(amazonMarketplaceCurrency('https://example.com/dp/X')).toBe('')
  })
})

describe('Shopify offers', () => {
  it('builds the storefront .js URL', () => {
    expect(
      getShopifyProductJsUrl(
        'https://shop.example/collections/edc/products/raccoon?variant=2',
      ),
    ).toBe('https://shop.example/collections/edc/products/raccoon.js')
    expect(getShopifyProductJsUrl('https://shop.example/pages/about')).toBe(
      undefined,
    )
  })

  const js = {
    variants: [
      { id: 1, price: 12900, available: false },
      { id: 2, price: 13900, available: true },
    ],
  }

  it('reads cents and stock from the .js endpoint', () => {
    expect(
      extractShopifyOffer(js, 'https://shop.example/products/raccoon', 'usd'),
    ).toEqual({
      amount: 139,
      currency: 'USD',
      availability: 'in_stock',
      method: 'shopify',
    })
    expect(
      extractShopifyOffer(
        js,
        'https://shop.example/products/raccoon?variant=1',
      ),
    ).toEqual({
      amount: 129,
      currency: '',
      availability: 'out_of_stock',
      method: 'shopify',
    })
  })

  it('reads decimal prices from the .json endpoint without stock status', () => {
    expect(
      extractShopifyOffer(
        { product: { variants: [{ id: 5, price: '89.95' }] } },
        'https://shop.example/products/raccoon',
        'EUR',
      ),
    ).toEqual({
      amount: 89.95,
      currency: 'EUR',
      availability: 'unknown',
      method: 'shopify',
    })
  })

  it('returns null for unrelated JSON', () => {
    expect(extractShopifyOffer({ product: {} }, 'https://x.example')).toBeNull()
    expect(extractShopifyOffer(null, 'https://x.example')).toBeNull()
  })
})
