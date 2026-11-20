import { describe, expect, it } from 'vitest'
import { isIgnoredOfficialOutOfStock } from '@/lib/price-monitor/eligibility'
import {
  DISCOVERY_STORES,
  genericProductDetails,
} from '@/lib/price-monitor/discovery-stores'
import {
  DEFAULT_PRICE_MONITORING,
  normalizePriceMonitoring,
} from '@/lib/settings-shared'

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

const KNIFECENTER_HTML = `
<div class="results">
  <div class="card">
    <a href="/item/SP223GP/spyderco-para-3-folding-knife-s45vn-satin-plain-blade-black-g10-handles-paramilitary-3">Spyderco Para 3 Folding Knife 3" S45VN Satin Plain Blade, Black G10 Handles</a>
    <div class="price">$197.25</div>
  </div>
  <a href="/brand/314/HTM-Knives">HTM Knives brand page</a>
</div>`

describe('Other stores: Blade HQ and KnifeCenter', () => {
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

  it('reads KnifeCenter /item/ links only', () => {
    const results = DISCOVERY_STORES.knifecenter.parseResults(
      KNIFECENTER_HTML,
      'https://www.knifecenter.com/search?q=para+3',
      DEFAULT_PRICE_MONITORING.otherStores,
    )
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      url: 'https://www.knifecenter.com/item/SP223GP/spyderco-para-3-folding-knife-s45vn-satin-plain-blade-black-g10-handles-paramilitary-3',
      price: '$197.25',
    })
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

  it('lanes and marketplaces follow the store', () => {
    expect(DISCOVERY_STORES.bladehq.laneKey).toBe('bladehq.com')
    expect(DISCOVERY_STORES.knifecenter.laneKey).toBe('knifecenter.com')
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
