import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isIgnoredOfficialOutOfStock } from '@/lib/price-monitor/eligibility'
import {
  DISCOVERY_STORES,
  genericProductDetails,
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
    const settings = DEFAULT_PRICE_MONITORING.otherStores
    const results = DISCOVERY_STORES.bladehq.parseResults(
      BLADEHQ_HTML,
      'https://www.bladehq.com/cat--Spyderco-Para-3--2475',
      settings,
    )
    expect(results).toEqual([
      {
        id: 1,
        url: 'https://www.bladehq.com/item--Spyderco-Paramilitary-3--50648',
        title:
          'Spyderco Para 3 Compression Lock Knife Black G-10 (3" Stonewash) C223GP',
        price: '$187.50',
        sponsored: false,
      },
      {
        id: 2,
        url: 'https://www.bladehq.com/item--Spyderco-Para-3-Lightweight--106189',
        title:
          'Spyderco Para 3 Lightweight Compression Lock Knife Blue (3" Satin SPY27)',
        price: '$154.95',
        sponsored: false,
      },
    ])
    expect(
      DISCOVERY_STORES.bladehq.searchUrl(settings, 'Spyderco Para 3'),
    ).toBe('https://www.bladehq.com/?search=Spyderco+Para+3')
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
      DEFAULT_PRICE_MONITORING.otherStores,
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
      DEFAULT_PRICE_MONITORING.otherStores,
    )
    expect(results).toEqual([
      {
        id: 1,
        url: 'https://www.bladehq.com/item--Spyderco-Para-3-Compression-Lock--67321',
        title:
          'Spyderco Para 3 Compression Lock Knife Black G-10 (3" Black DLC) C223GPBK',
        price: null,
        sponsored: false,
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

  it('no longer offers KnifeCenter; old saved settings still load', () => {
    expect(Object.keys(DISCOVERY_STORES)).toEqual(['amazon', 'bladehq'])
    expect(
      normalizePriceMonitoring({
        otherStores: {
          enabled: true,
          stores: { amazon: false, bladehq: true, knifecenter: true },
        },
      }).otherStores.stores,
    ).toEqual({ amazon: false, bladehq: true })
  })

  it('lanes and marketplaces follow the store', () => {
    expect(DISCOVERY_STORES.bladehq.laneKey).toBe('bladehq.com')
    expect(
      DISCOVERY_STORES.amazon.marketplace({
        ...DEFAULT_PRICE_MONITORING.otherStores,
        amazonMarketplace: 'amazon.de',
      }),
    ).toBe('amazon.de')
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
