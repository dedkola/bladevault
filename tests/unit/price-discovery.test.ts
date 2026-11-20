import { describe, expect, it } from 'vitest'
import {
  amazonSearchUrl,
  buildSearchQueries,
  buildSearchQuery,
  modelNumberCodes,
  pageShowsModelNumber,
  parseAmazonSearchResults,
  parseMatchAnswer,
  parseVerifyAnswer,
} from '@/lib/price-monitor/discovery-ai'
import { amazonDeliversTo } from '@/lib/price-monitor/amazon-location'
import { nextDiscoveryAttempt } from '@/lib/price-monitor/discovery-store'
import {
  amazonDeliveryPostcode,
  DEFAULT_PRICE_MONITORING,
  normalizeAmazonPostcode,
  normalizePriceMonitoring,
} from '@/lib/settings-shared'

const SEARCH_HTML = `
<div class="s-main-slot">
  <div data-component-type="s-search-result" data-asin="B0SPONSOR1">
    <span class="puis-label-popover">Sponsored</span>
    <h2><span>Knife Sharpener for Pocket Knives</span></h2>
    <span class="a-price"><span class="a-offscreen">$19.99</span></span>
  </div>
  <div data-component-type="s-search-result" data-asin="B07PARA003">
    <h2><a href="/dp/B07PARA003"><span>Spyderco Para 3 Lightweight Folding Knife, CTS BD1N, Black FRN</span></a></h2>
    <span class="a-price a-text-price"><span class="a-offscreen">$149.95</span></span>
    <span class="a-price"><span class="a-offscreen">$124.95</span></span>
  </div>
  <div data-component-type="s-search-result" data-asin="">
    <h2>Empty ASIN block</h2>
  </div>
  <div data-component-type="s-search-result" data-asin="B07PARA003">
    <h2>Duplicate</h2>
  </div>
</div>`

describe('Other stores search parsing', () => {
  it('reads ASIN, title, current price and ads from Amazon results', () => {
    expect(parseAmazonSearchResults(SEARCH_HTML)).toEqual([
      {
        id: 1,
        asin: 'B0SPONSOR1',
        title: 'Knife Sharpener for Pocket Knives',
        price: '$19.99',
        sponsored: true,
      },
      {
        id: 2,
        asin: 'B07PARA003',
        title: 'Spyderco Para 3 Lightweight Folding Knife, CTS BD1N, Black FRN',
        price: '$124.95',
        sponsored: false,
      },
    ])
  })

  it('reads the product title when Amazon shows the brand in its own heading', () => {
    const html = `
      <div data-component-type="s-search-result" data-asin="B0KIZERDB1">
        <div data-cy="title-recipe">
          <div class="a-row"><h2 class="a-size-mini"><span>KIZER</span></h2></div>
          <a href="/dp/B0KIZERDB1"><h2 aria-label="Drop Bear Pocket Knife, 154CM Blade, Micarta Handle"><span>Drop Bear Pocket Knife, 154CM Blade, Micarta Handle</span></h2></a>
        </div>
      </div>
      <div data-component-type="s-search-result" data-asin="B0CIVIVIJ1">
        <h2><span>CIVIVI</span></h2>
        <h2><span>CIVIVI Jencks Folding Knife, Nitro-V Blade</span></h2>
      </div>`
    expect(
      parseAmazonSearchResults(html).map((result) => result.title),
    ).toEqual([
      'KIZER Drop Bear Pocket Knife, 154CM Blade, Micarta Handle',
      'CIVIVI Jencks Folding Knife, Nitro-V Blade',
    ])
  })

  it('takes the ad label out of the title and marks the result as an ad', () => {
    const [result] = parseAmazonSearchResults(`
      <div data-component-type="s-search-result" data-asin="B0GVSLQJD2">
        <h2 aria-label="Vosteed">Vosteed</h2>
        <h2 aria-label="Sponsored Ad - Porcupine ModSwap - 154CM Blade, G10 Handle - A3103"></h2>
      </div>`)
    expect(result).toMatchObject({
      title: 'Vosteed Porcupine ModSwap - 154CM Blade, G10 Handle - A3103',
      sponsored: true,
    })
  })

  it('falls back to product links for other layouts', () => {
    const html = `<a href="/Spyderco-Para/dp/B07PARA003/ref=sr_1_1">Spyderco Para 3 Folding Knife</a>
      <a href="/dp/B07PARA003">Spyderco Para 3 again</a><a href="/dp/B0SHORT001">Buy</a>`
    expect(parseAmazonSearchResults(html)).toEqual([
      {
        id: 1,
        asin: 'B07PARA003',
        title: 'Spyderco Para 3 Folding Knife',
        price: null,
        sponsored: false,
      },
    ])
  })

  it('tries the search with and then without the model number', () => {
    expect(
      buildSearchQueries({
        brand: 'Kizer',
        name: 'Drop Bear',
        modelNumber: 'V3619.2PR3',
      }),
    ).toEqual(['Kizer Drop Bear V3619.2PR3', 'Kizer Drop Bear'])
    expect(buildSearchQueries({ brand: 'Kizer', name: 'Drop Bear' })).toEqual([
      'Kizer Drop Bear',
    ])
  })

  it('builds a search without repeated words', () => {
    expect(
      buildSearchQuery({
        brand: 'Spyderco',
        name: 'Spyderco Para 3',
        modelNumber: 'C223GP',
      }),
    ).toBe('Spyderco Para 3 C223GP')
    expect(amazonSearchUrl('amazon.de', 'Para 3 & Co')).toBe(
      'https://www.amazon.de/s?k=Para+3+%26+Co',
    )
  })
})

describe('Other stores model number check', () => {
  it('reads one or more maker codes and ignores names', () => {
    expect(modelNumberCodes('C223GP / C223GPBK')).toEqual([
      'C223GP',
      'C223GPBK',
    ])
    expect(modelNumberCodes('A3105')).toEqual(['A3105'])
    expect(modelNumberCodes('Para')).toEqual([])
    expect(modelNumberCodes('3V')).toEqual([])
    expect(modelNumberCodes(undefined)).toEqual([])
  })

  it('needs the exact code on the page, not another variant', () => {
    const title =
      'Vosteed Porcupine ModSwap - 3.08" 154CM Blade, Micarta Handle - A3105'
    expect(pageShowsModelNumber('A3105', title)).toBe(true)
    expect(pageShowsModelNumber('A3103', title)).toBe(false)
    expect(pageShowsModelNumber('A310', title)).toBe(false)
    expect(pageShowsModelNumber('a-3105', title)).toBe(true)
    expect(pageShowsModelNumber('C223GP', 'Item model number: SP223GP')).toBe(
      false,
    )
    expect(pageShowsModelNumber('C223GP', 'Para 3 C223GPBK black')).toBe(false)
    expect(pageShowsModelNumber('V3619.2PR3', 'Drop Bear V3619.2PR3')).toBe(
      true,
    )
    // No code in the collection: nothing to compare.
    expect(pageShowsModelNumber(undefined, title)).toBe(true)
  })

  it('sets the postcode unless Amazon already delivers there', () => {
    expect(amazonDeliversTo('Ukraine', '10001')).toBe(false)
    expect(amazonDeliversTo('New York 10001\u200c', '10001')).toBe(true)
    // The user's own ZIP replaces an earlier one.
    expect(amazonDeliversTo('New York 10001', '94105')).toBe(false)
    // Amazon shortens UK postcodes.
    expect(amazonDeliversTo('London SW1A 1', 'SW1A 1AA')).toBe(true)
    // No location on the page: another layout, left alone.
    expect(amazonDeliversTo(null, '10001')).toBe(true)
  })

  it('uses the user’s postcode or the marketplace default', () => {
    expect(
      amazonDeliveryPostcode({
        amazonMarketplace: 'amazon.com',
        amazonPostcode: '',
      }),
    ).toBe('10001')
    expect(
      amazonDeliveryPostcode({
        amazonMarketplace: 'amazon.de',
        amazonPostcode: '',
      }),
    ).toBe('10115')
    expect(
      amazonDeliveryPostcode({
        amazonMarketplace: 'amazon.com',
        amazonPostcode: '94105',
      }),
    ).toBe('94105')
    expect(normalizeAmazonPostcode(' sw1a   1aa ')).toBe('SW1A 1AA')
    expect(normalizeAmazonPostcode('<script>')).toBeNull()
    expect(normalizeAmazonPostcode('1')).toBeNull()
    expect(
      normalizePriceMonitoring({
        otherStores: { amazonPostcode: '94105' },
      }).otherStores.amazonPostcode,
    ).toBe('94105')
    expect(
      normalizePriceMonitoring({
        otherStores: { amazonPostcode: 'not a zip!!' },
      }).otherStores.amazonPostcode,
    ).toBe('')
  })
})

describe('Other stores AI answers', () => {
  const candidates = parseAmazonSearchResults(SEARCH_HTML)

  it('accepts a listed result only when AI is sure', () => {
    expect(
      parseMatchAnswer(
        { match: 2, confidence: 0.9, reason: 'Same' },
        candidates,
      ).candidate?.asin,
    ).toBe('B07PARA003')
    expect(
      parseMatchAnswer({ match: '2', confidence: 0.6 }, candidates).candidate,
    ).toBeNull()
    expect(
      parseMatchAnswer({ match: 7, confidence: 1 }, candidates).candidate,
    ).toBeNull()
    expect(
      parseMatchAnswer({ match: null, confidence: 0.95 }, candidates).accepted,
    ).toBe(false)
    expect(parseMatchAnswer('nonsense', candidates).accepted).toBe(false)
  })

  it('needs an explicit, confident yes on the product page', () => {
    expect(
      parseVerifyAnswer({ same_product: true, confidence: 0.8 }).accepted,
    ).toBe(true)
    expect(
      parseVerifyAnswer({ same_product: 'true', confidence: 0.99 }).accepted,
    ).toBe(false)
    expect(
      parseVerifyAnswer({ same_product: true, confidence: 0.5 }).accepted,
    ).toBe(false)
  })
})

describe('Other stores scheduling and settings', () => {
  const now = Date.parse('2026-11-18T12:00:00Z')
  const hoursLater = (iso: string | null) =>
    iso === null ? null : (Date.parse(iso) - now) / 3_600_000

  it('never searches again for found knives and backs off failures', () => {
    expect(nextDiscoveryAttempt('found', 1, now)).toBeNull()
    expect(hoursLater(nextDiscoveryAttempt('not_found', 1, now))).toBe(720)
    expect(hoursLater(nextDiscoveryAttempt('blocked', 1, now))).toBe(12)
    expect(hoursLater(nextDiscoveryAttempt('failed', 1, now))).toBe(6)
    expect(hoursLater(nextDiscoveryAttempt('failed', 3, now))).toBe(24)
    expect(hoursLater(nextDiscoveryAttempt('failed', 9, now))).toBe(168)
  })

  it('is off by default and keeps only known marketplaces', () => {
    expect(DEFAULT_PRICE_MONITORING.otherStores).toEqual({
      enabled: false,
      stores: { amazon: true, bladehq: false },
      amazonMarketplace: 'amazon.com',
      // Empty: the marketplace's default postcode (10001 on amazon.com).
      amazonPostcode: '',
    })
    const next = normalizePriceMonitoring({
      otherStores: {
        enabled: true,
        stores: { amazon: false, ebay: true },
        amazonMarketplace: 'amazon.evil',
      },
    })
    expect(next.otherStores).toEqual({
      enabled: true,
      stores: { amazon: false, bladehq: false },
      amazonMarketplace: 'amazon.com',
      amazonPostcode: '',
    })
    expect(
      normalizePriceMonitoring({
        otherStores: { amazonMarketplace: 'amazon.co.uk' },
      }).otherStores.amazonMarketplace,
    ).toBe('amazon.co.uk')
  })
})
