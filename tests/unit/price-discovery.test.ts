import { describe, expect, it } from 'vitest'
import {
  amazonSearchUrl,
  buildSearchQuery,
  parseAmazonSearchResults,
  parseMatchAnswer,
  parseVerifyAnswer,
} from '@/lib/price-monitor/discovery-ai'
import { nextDiscoveryAttempt } from '@/lib/price-monitor/discovery-store'
import {
  DEFAULT_PRICE_MONITORING,
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
      stores: { amazon: true },
      amazonMarketplace: 'amazon.com',
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
      stores: { amazon: false },
      amazonMarketplace: 'amazon.com',
    })
    expect(
      normalizePriceMonitoring({
        otherStores: { amazonMarketplace: 'amazon.co.uk' },
      }).otherStores.amazonMarketplace,
    ).toBe('amazon.co.uk')
  })
})
