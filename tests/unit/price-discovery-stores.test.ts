import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isIgnoredOfficialOutOfStock } from '@/lib/price-monitor/eligibility'
import {
  DISCOVERY_STORES,
  genericProductDetails,
  withoutBrandPrefix,
} from '@/lib/price-monitor/discovery-stores'
import { extractOfferFromHtml } from '@/lib/price-monitor/fetch'
import { pageShowsModelNumber } from '@/lib/price-monitor/discovery-ai'
import {
  isNetworkBlockError,
  isNetworkBlockPage,
  isSecurityChallengePage,
  networkBlockError,
} from '@/lib/scrape'
import { toScrapeError } from '@/lib/scrape-errors'
import { storeLabel } from '@/components/price-drops/price-format'
import {
  DEFAULT_PRICE_MONITORING,
  normalizePriceMonitoring,
} from '@/lib/settings-shared'

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/scrape/${name}`, import.meta.url), 'utf8')

// Trimmed from a Blade HQ category page (search redirects there).
const BLADEHQ_HTML = `
<header><a href="https://www.bladehq.com/item--Gift-Card--1">Gift Card for knife lovers</a></header>
<nav><a href="https://www.bladehq.com/cat--Pocket-Knives--45">Pocket Knives</a></nav>
<ul>
  <li class="product">
    <a class="flex-1" href="https://www.bladehq.com/item--Spyderco-Paramilitary-3--50648"><img alt="Para 3"></a>
    <a class="flex-1 text-copy" href="https://www.bladehq.com/item--Spyderco-Paramilitary-3--50648?ref=list">Spyderco Para 3 Compression Lock Knife Black G-10 (3" Stonewash) C223GP</a>
    <span>$187.50</span>
  </li>
  <li class="product">
    <a class="flex-1 text-copy" href="/item--Spyderco-Para-3-Lightweight--106189">Spyderco Para 3 Lightweight Compression Lock Knife Blue (3" Satin SPY27)</a>
    <span>$154.95</span>
  </li>
</ul>
<footer><a href="https://www.bladehq.com/item--Footer-Promo--2">Footer promo product link</a></footer>`

describe('Other stores: Blade HQ', () => {
  it('reads Blade HQ product links, skipping header, nav and footer', () => {
    const results = DISCOVERY_STORES.bladehq.parseResults(
      BLADEHQ_HTML,
      'https://www.bladehq.com/cat--Spyderco-Para-3--2475',
    )
    expect(results).toEqual([
      {
        id: 1,
        url: 'https://www.bladehq.com/item--Spyderco-Paramilitary-3--50648',
        title:
          'Spyderco Para 3 Compression Lock Knife Black G-10 (3" Stonewash) C223GP',
        price: '$187.50',
      },
      {
        id: 2,
        url: 'https://www.bladehq.com/item--Spyderco-Para-3-Lightweight--106189',
        title:
          'Spyderco Para 3 Lightweight Compression Lock Knife Blue (3" Satin SPY27)',
        price: '$154.95',
      },
    ])
    expect(DISCOVERY_STORES.bladehq.searchUrl('Spyderco Para 3')).toBe(
      'https://www.bladehq.com/?search=Spyderco+Para+3',
    )
  })

  it('reads a product page from JSON-LD', () => {
    const details = genericProductDetails(`
      <script type="application/ld+json">[{"@context":"https://schema.org","@type":"Product",
        "name":"Kizer Drop Bear (3&quot; Blue)","brand":{"@type":"Brand","name":"Kizer"},
        "mpn":"V3619C2","description":"Button lock folder."}]</script>
      <h1>Ignored heading</h1>`)
    expect(details).toEqual({
      title: 'Kizer Drop Bear (3" Blue)',
      details: 'Brand: Kizer\nMPN: V3619C2\nButton lock folder.',
    })
    expect(genericProductDetails('<p>nothing</p>')).toBeNull()
  })

  it('reads the live Blade HQ search page at the selling price, not the MSRP', () => {
    const html = fixture('bladehq-search-para-3.html')
    const results = DISCOVERY_STORES.bladehq.parseResults(
      html,
      'https://www.bladehq.com/cat--Spyderco-Para-3--2475',
    )
    expect(
      results.map(({ url, title, price }) => ({ url, title, price })),
    ).toEqual([
      {
        url: 'https://www.bladehq.com/item--Spyderco-Para-3-Knife-Brown-Canvas--191668',
        title:
          'Spyderco Para 3 Knife Brown Canvas Micarta (3" Satin CPM CRU-WEAR) C223MPCW',
        price: '$216.75',
      },
      {
        url: 'https://www.bladehq.com/item--Spyderco-Para-3-Compression-Lock--67321',
        title:
          'Spyderco Para 3 Compression Lock Knife Black G-10 (3" Black DLC) C223GPBK',
        price: '$212.25',
      },
      {
        url: 'https://www.bladehq.com/item--Spyderco-Para-3-Knife-Dark-Gray-G--71267',
        title:
          'Spyderco Para 3 Knife Dark Gray G-10 (3" Stonewash Maxamet) C223GPDGY',
        price: '$275.25',
      },
    ])
  })

  it('reads the live Blade HQ product page: title, SKU and price', () => {
    const html = fixture('bladehq-item-para-3-c223gpbk.html')
    const url =
      'https://www.bladehq.com/item--Spyderco-Para-3-Compression-Lock--67321'
    const details = DISCOVERY_STORES.bladehq.productDetails(html, url)
    expect(details?.title).toBe(
      'Spyderco Para 3 Compression Lock Knife Black G-10 (3" Black DLC) C223GPBK',
    )
    expect(details?.details).toContain('Brand: Spyderco')
    expect(details?.details).toContain('SKU: C223GPBK')
    expect(details?.details).toContain("that's easy to use")
    expect(
      pageShowsModelNumber(
        'C223GPBK',
        `${details?.title}\n${details?.details}`,
      ),
    ).toBe(true)
    expect(extractOfferFromHtml(html, url)).toMatchObject({
      amount: 212.25,
      currency: 'USD',
      availability: 'in_stock',
    })
  })

  it('takes a search that lands on a product page as its one result', () => {
    const url =
      'https://www.bladehq.com/item--Spyderco-Para-3-Compression-Lock--67321?search=C223GPBK'
    const results = DISCOVERY_STORES.bladehq.parseResults(
      fixture('bladehq-item-para-3-c223gpbk.html'),
      url,
    )
    expect(results).toEqual([
      {
        id: 1,
        url: 'https://www.bladehq.com/item--Spyderco-Para-3-Compression-Lock--67321',
        title:
          'Spyderco Para 3 Compression Lock Knife Black G-10 (3" Black DLC) C223GPBK',
        price: null,
      },
    ])
  })

  it('tells an IP-range block page apart from a bot check', () => {
    const html = fixture('ip-range-block.html')
    expect(isNetworkBlockPage(html)).toBe(true)
    // Nothing here a person could solve: it is not a challenge page.
    expect(isSecurityChallengePage(html)).toBe(false)
    expect(isNetworkBlockPage(fixture('bladehq-search-para-3.html'))).toBe(
      false,
    )
    const error = networkBlockError(200)
    expect(isNetworkBlockError(error)).toBe(true)
    expect(toScrapeError(error).code).toBe('http')
    // The 403 keeps pacing and the circuit breaker treating it as a block.
    expect(error.message).toContain('HTTP 403')
    expect(error.message).toContain('not a bot check')
    expect(isNetworkBlockError(new Error('HTTP 403'))).toBe(false)
  })

  it('no longer offers KnifeCenter or Amazon; old saved settings still load', () => {
    expect(Object.keys(DISCOVERY_STORES)).toEqual([
      'bladehq',
      'smkw',
      'dlttrading',
    ])
    expect(
      normalizePriceMonitoring({
        otherStores: {
          enabled: true,
          stores: { amazon: true, bladehq: true, knifecenter: true },
        },
      }).otherStores.stores,
    ).toEqual({ bladehq: true, smkw: false, dlttrading: false })
  })

  it('lanes and marketplaces follow the store', () => {
    expect(DISCOVERY_STORES.bladehq.laneKey).toBe('bladehq.com')
    expect(DISCOVERY_STORES.bladehq.marketplace).toBe('bladehq.com')
    expect(DISCOVERY_STORES.smkw.laneKey).toBe('smkw.com')
    expect(DISCOVERY_STORES.smkw.marketplace).toBe('smkw.com')
    expect(DISCOVERY_STORES.dlttrading.laneKey).toBe('dlttrading.com')
    expect(DISCOVERY_STORES.dlttrading.marketplace).toBe('dlttrading.com')
  })
})

describe('Other stores: SMKW', () => {
  const SEARCH_URL = 'https://smkw.com/shop/?search_query=spyderco%20para%203'
  const ITEM_URL = 'https://smkw.com/spyderco-para-3-folding-knife-black-g-10'

  it('is off by default and keeps a saved choice', () => {
    expect(DEFAULT_PRICE_MONITORING.otherStores.stores).toEqual({
      bladehq: true,
      smkw: false,
      dlttrading: false,
    })
    expect(
      normalizePriceMonitoring({
        otherStores: { enabled: true, stores: { smkw: true } },
      }).otherStores.stores,
    ).toEqual({ bladehq: true, smkw: true, dlttrading: false })
    expect(storeLabel('smkw.com')).toBe('SMKW')
  })

  it('searches the SMKW shop page', () => {
    expect(DISCOVERY_STORES.smkw.searchUrl('Spyderco Para 3')).toBe(
      'https://smkw.com/shop/?search_query=Spyderco+Para+3',
    )
  })

  it('reads the result cards at the selling price, skipping header, nav, footer and filters', () => {
    const results = DISCOVERY_STORES.smkw.parseResults(
      fixture('smkw-search-para-3.html'),
      SEARCH_URL,
    )
    expect(results).toEqual([
      {
        id: 1,
        url: ITEM_URL,
        title:
          'Spyderco Para 3 Folding Knife Black G-10 Handle CPM S45VN Drop Point Blade SPC223GP',
        price: '$197.25',
      },
      {
        id: 2,
        url: 'https://smkw.com/spyderco-para-3-lightweight-folding-knife-black-frn',
        title:
          'Spyderco Para 3 Lightweight Folding Knife Black 2.92in Plain Edge Blade SPC223PBBK',
        price: '$154.50',
      },
      {
        id: 3,
        url: 'https://smkw.com/spyderco-para-3-maxamet-folding-knife-dark-gray-g-10/',
        title:
          'Spyderco Para 3 Maxamet Dark Gray 2.93 Inch Plain Satin Clip Point SPC223GPDGY',
        // Not the $275.25 MSRP / Was price on the same card.
        price: '$219.99',
      },
    ])
  })

  it('takes a search that lands on a product page as its one result', () => {
    expect(
      DISCOVERY_STORES.smkw.parseResults(
        fixture('smkw-item-para-3-c223gbk.html'),
        `${ITEM_URL}?search_query=C223GP`,
      ),
    ).toEqual([
      {
        id: 1,
        url: ITEM_URL,
        title:
          'Spyderco Para 3 Folding Knife Black G-10 Handle CPM S45VN Drop Point Blade SPC223GP',
        price: null,
      },
    ])
  })

  it('reads the product page: decoded description, MPN, SKU without the brand prefix, price', () => {
    const html = fixture('smkw-item-para-3-c223gbk.html')
    const details = DISCOVERY_STORES.smkw.productDetails(html, ITEM_URL)
    expect(details?.details).toContain('Brand: Spyderco Knives')
    expect(details?.details).toContain('MPN: C223GBK')
    expect(details?.details).toContain('SKU: SPC223GP')
    expect(details?.details).toContain(
      "SKU without SMKW's brand prefix SP: C223GP",
    )
    expect(details?.details).toContain(
      'The Spyderco Para 3 Folding Knife with Black G‑10 Handle',
    )
    expect(details?.details).toContain('The blade’s compact size')
    expect(details?.details).not.toContain('%20')
    const text = `${details?.title}\n${details?.details}`
    expect(pageShowsModelNumber('C223GP', text)).toBe(true)
    expect(pageShowsModelNumber('C223GBK', text)).toBe(true)
    expect(pageShowsModelNumber('C223GPDGY', text)).toBe(false)
    expect(extractOfferFromHtml(html, ITEM_URL)).toMatchObject({
      amount: 197.25,
      currency: 'USD',
      availability: 'in_stock',
    })
  })

  it('leaves ordinary descriptions with a percent sign alone', () => {
    const details = genericProductDetails(
      `<script type="application/ld+json">{"@type":"Product","name":"Knife","description":"Save 20%25 today"}</script>`,
    )
    expect(details?.details).toBe('Save 20%25 today')
  })
})

describe('Other stores: DLT Trading', () => {
  const SEARCH_URL =
    'https://www.dlttrading.com/search.php?search_query=spyderco+para+3'
  const ITEM_URL = 'https://www.dlttrading.com/spyderco-para-3-lightweight'

  it('is off by default, keeps a saved choice and has a label', () => {
    expect(DEFAULT_PRICE_MONITORING.otherStores.stores.dlttrading).toBe(false)
    expect(
      normalizePriceMonitoring({
        otherStores: { enabled: true, stores: { dlttrading: true } },
      }).otherStores.stores,
    ).toEqual({ bladehq: true, smkw: false, dlttrading: true })
    expect(storeLabel('dlttrading.com')).toBe('DLT Trading')
  })

  it('searches the BigCommerce search page', () => {
    expect(DISCOVERY_STORES.dlttrading.searchUrl('Spyderco Para 3')).toBe(
      'https://www.dlttrading.com/search.php?search_query=Spyderco+Para+3',
    )
  })

  it('reads result cards at Our Price, not MSRP or Was, skipping nav links', () => {
    const results = DISCOVERY_STORES.dlttrading.parseResults(
      fixture('dlt-search-para-3.html'),
      SEARCH_URL,
    )
    expect(results).toEqual([
      {
        id: 1,
        url: 'https://www.dlttrading.com/spyderco-mountain-range-t-shirt',
        title: 'Spyderco Mountain Range T-Shirt',
        price: '$23.95',
      },
      {
        id: 2,
        url: 'https://www.dlttrading.com/spyderco-para-3-lightweight-fully-serrated',
        title: 'Spyderco Para 3 Lightweight - Fully Serrated',
        price: '$139.50',
      },
      {
        id: 3,
        url: ITEM_URL,
        title: 'Spyderco Para 3 Lightweight',
        price: '$139.50',
      },
    ])
  })

  it('takes a search that lands on a product page as its one result', () => {
    expect(
      DISCOVERY_STORES.dlttrading.parseResults(
        fixture('dlt-item-para-3-lightweight-c223pbk.html'),
        `${ITEM_URL}?search_query=C223PBK`,
      ),
    ).toEqual([
      {
        id: 1,
        url: ITEM_URL,
        title: 'Spyderco Para 3 Lightweight',
        price: null,
      },
    ])
  })

  it('reads the product page: model number from the SKU, price not MSRP', () => {
    // The page also carries a script that adds another product's structured
    // data, but only on /buck-muffins; it must never be read here.
    const html = fixture('dlt-item-para-3-lightweight-c223pbk.html')
    const details = DISCOVERY_STORES.dlttrading.productDetails(html, ITEM_URL)
    expect(details?.title).toBe('Spyderco Para 3 Lightweight')
    expect(details?.details).toContain('Brand: Spyderco')
    expect(details?.details).toContain('SKU: C223PBK')
    expect(details?.details).not.toContain('Buck Muffins')
    expect(
      pageShowsModelNumber('C223PBK', `${details?.title}\n${details?.details}`),
    ).toBe(true)
    expect(extractOfferFromHtml(html, ITEM_URL)).toMatchObject({
      amount: 139.5,
      currency: 'USD',
      availability: 'in_stock',
    })
  })

  it('sees the maker’s number behind DLT’s brand prefix (VOSA4501 is Vosteed A4501)', () => {
    const html = fixture('dlt-item-vosteed-raccoon-tislim-a4501.html')
    const details = DISCOVERY_STORES.dlttrading.productDetails(
      html,
      'https://www.dlttrading.com/vosteed-raccoon-tislim-gray-titanium-satin-154cm-blade-101',
    )
    expect(details?.details).toContain('SKU: VOSA4501')
    expect(details?.details).toContain(
      "SKU without the store's brand prefix VOS: A4501",
    )
    const page = `${details?.title}\n${details?.details}`
    expect(pageShowsModelNumber('A4501', page)).toBe(true)
    // Another variant of the same knife still fails the check.
    expect(pageShowsModelNumber('A4506', page)).toBe(false)
  })
})

describe('Brand prefix on store SKUs', () => {
  it('splits off the start of the brand name only', () => {
    expect(withoutBrandPrefix('VOSA4501', 'Vosteed')).toEqual({
      prefix: 'VOS',
      code: 'A4501',
    })
    expect(withoutBrandPrefix('CIVC190461', 'CIVIVI')).toEqual({
      prefix: 'CIV',
      code: 'C190461',
    })
    // The page title stands in when the page names no brand.
    expect(withoutBrandPrefix('KI1108A3', 'Kizer Whiskey Jack 154CM')).toEqual({
      prefix: 'KI',
      code: '1108A3',
    })
  })

  it('leaves SKUs alone that do not start with the brand', () => {
    expect(withoutBrandPrefix('C223PBK', 'Spyderco')).toBeNull()
    expect(withoutBrandPrefix('A4501', 'Vosteed')).toBeNull()
    expect(withoutBrandPrefix('VOSTEED', 'Vosteed')).toBeNull()
    expect(withoutBrandPrefix('', 'Vosteed')).toBeNull()
  })
})

describe('Ignore out of stock on the official site', () => {
  it('is off by default and normalizes', () => {
    expect(DEFAULT_PRICE_MONITORING.ignoreOfficialOutOfStock).toBe(false)
    expect(
      normalizePriceMonitoring({ ignoreOfficialOutOfStock: true })
        .ignoreOfficialOutOfStock,
    ).toBe(true)
    expect(
      normalizePriceMonitoring({ ignoreOfficialOutOfStock: 'yes' })
        .ignoreOfficialOutOfStock,
    ).toBe(false)
  })

  it('only ignores the knife’s own link while it is out of stock', () => {
    const on = { ignoreOfficialOutOfStock: true }
    expect(
      isIgnoredOfficialOutOfStock(
        { origin: 'auto', availability: 'out_of_stock' },
        on,
      ),
    ).toBe(true)
    expect(
      isIgnoredOfficialOutOfStock(
        { origin: 'manual', availability: 'out_of_stock' },
        on,
      ),
    ).toBe(false)
    expect(
      isIgnoredOfficialOutOfStock(
        { origin: 'auto', availability: 'in_stock' },
        on,
      ),
    ).toBe(false)
    expect(
      isIgnoredOfficialOutOfStock(
        { origin: 'auto', availability: 'out_of_stock' },
        { ignoreOfficialOutOfStock: false },
      ),
    ).toBe(false)
  })
})
