import { describe, expect, it } from 'vitest'
import { getEligibility, planAutoSource } from '@/lib/price-monitor/eligibility'
import {
  laneKeyForUrl,
  MAX_PRICE_SOURCES_PER_KNIFE,
  normalizeSourceUrl,
  parsePriceCheckRequest,
  parsePriceWatchUpdate,
  providerForUrl,
  registrableDomain,
  storeNameForUrl,
} from '@/lib/price-monitor/shared'

const knife = (price: string, sold = false) => ({ sold, specs: { price } })

describe('getEligibility', () => {
  it('monitors a wanted knife in Auto without a purchase price', () => {
    const wanted = { sold: false, wanted: true, specs: { price: '' } }
    expect(getEligibility(wanted, 'auto', 1)).toEqual({
      monitored: true,
      reason: 'monitored_auto',
    })
    expect(getEligibility(wanted, 'auto', 0)).toEqual({
      monitored: false,
      reason: 'no_source',
    })
    expect(getEligibility(wanted, 'off', 1)).toEqual({
      monitored: false,
      reason: 'off',
    })
  })

  it('monitors Auto knives with a stored price above zero', () => {
    expect(getEligibility(knife('129.00 USD'), 'auto', 1)).toEqual({
      monitored: true,
      reason: 'monitored_auto',
    })
  })

  it.each(['', '0', '0.00 USD', 'n/a'])(
    'ignores Auto knives with price %j',
    (price) => {
      expect(getEligibility(knife(price), 'auto', 1)).toEqual({
        monitored: false,
        reason: 'no_price',
      })
    },
  )

  it('skips sold knives in Auto unless the setting allows them', () => {
    expect(getEligibility(knife('50', true), 'auto', 1).reason).toBe('sold')
    expect(
      getEligibility(knife('50', true), 'auto', 1, { skipSoldKnives: false })
        .monitored,
    ).toBe(true)
  })

  it('lets Always monitor cover knives without a price or sold', () => {
    expect(getEligibility(knife('', true), 'on', 2)).toEqual({
      monitored: true,
      reason: 'monitored_forced',
    })
  })

  it('needs an enabled source and respects Never', () => {
    expect(getEligibility(knife('50'), 'auto', 0).reason).toBe('no_source')
    expect(getEligibility(knife('50'), 'on', 0).reason).toBe('no_source')
    expect(getEligibility(knife('50'), 'off', 3).reason).toBe('off')
  })
})

describe('planAutoSource', () => {
  const auto = (id: number, url: string) => ({
    id,
    origin: 'auto' as const,
    normalizedUrl: normalizeSourceUrl(url)!,
  })
  const manual = (id: number, url: string) => ({
    ...auto(id, url),
    origin: 'manual' as const,
  })

  it('adds the product link once', () => {
    expect(planAutoSource('https://shop.example/p', [])).toEqual({
      add: 'https://shop.example/p',
      removeIds: [],
    })
    expect(
      planAutoSource('https://shop.example/p?utm_source=x', [
        auto(1, 'https://shop.example/p'),
      ]),
    ).toEqual({ add: null, removeIds: [] })
  })

  it('replaces the auto source when the product link changes', () => {
    expect(
      planAutoSource('https://shop.example/new', [
        auto(1, 'https://shop.example/old'),
        manual(2, 'https://other.example/p'),
      ]),
    ).toEqual({ add: 'https://shop.example/new', removeIds: [1] })
  })

  it('removes the auto source when the link is cleared or invalid', () => {
    expect(planAutoSource('', [auto(4, 'https://shop.example/p')])).toEqual({
      add: null,
      removeIds: [4],
    })
    expect(planAutoSource('ftp://x', [])).toEqual({ add: null, removeIds: [] })
  })

  it('does not duplicate a URL already added by hand', () => {
    expect(
      planAutoSource('https://shop.example/p', [
        manual(3, 'https://shop.example/p/'),
      ]),
    ).toEqual({ add: null, removeIds: [] })
  })
})

describe('source URLs', () => {
  it('normalizes for de-duplication', () => {
    expect(
      normalizeSourceUrl(
        'https://Shop.Example/products/knife/?utm_source=x&variant=2#reviews',
      ),
    ).toBe('https://shop.example/products/knife?variant=2')
    expect(
      normalizeSourceUrl(
        'https://www.amazon.de/Vosteed-Raccoon/dp/b0frrwk52d/ref=sr_1_1?th=1',
      ),
    ).toBe('https://www.amazon.de/dp/B0FRRWK52D')
    expect(normalizeSourceUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeSourceUrl('not a url')).toBeNull()
  })

  it('groups stores into lanes', () => {
    expect(laneKeyForUrl('https://www.amazon.co.uk/dp/X')).toBe('amazon')
    expect(laneKeyForUrl('https://amazon.com/dp/X')).toBe('amazon')
    expect(laneKeyForUrl('https://shop.vosteed.com/p')).toBe('vosteed.com')
    expect(laneKeyForUrl('https://www.knifecenter.co.uk/p')).toBe(
      'knifecenter.co.uk',
    )
    expect(registrableDomain('192.168.1.10')).toBe('192.168.1.10')
    expect(storeNameForUrl('https://www.bladehq.com/item')).toBe('bladehq.com')
    expect(providerForUrl('https://www.amazon.com/dp/X')).toBe('amazon')
    expect(providerForUrl('https://kizer.example/p')).toBe('generic')
  })
})

describe('request parsing', () => {
  it('accepts a full price-watch update', () => {
    expect(
      parsePriceWatchUpdate({
        mode: 'on',
        add: [{ url: ' https://shop.example/p ', storeName: '  Shop ' }],
        update: [{ id: 3, enabled: false, fetchOverride: 'http' }],
        remove: [4],
      }),
    ).toEqual({
      mode: 'on',
      add: [{ url: 'https://shop.example/p', storeName: 'Shop' }],
      update: [{ id: 3, enabled: false, fetchOverride: 'http' }],
      remove: [4],
    })
  })

  it.each([
    [null, 'object'],
    [{ mode: 'maybe' }, 'mode'],
    [{ add: [{ url: 'nope' }] }, 'valid product URL'],
    [
      {
        add: Array.from(
          { length: MAX_PRICE_SOURCES_PER_KNIFE + 1 },
          (_, i) => ({ url: `https://s.example/${i}` }),
        ),
      },
      'list of sources',
    ],
    [{ update: [{ id: 'x' }] }, 'needs an id'],
    [{ update: [{ id: 1, fetchOverride: 'ftp' }] }, 'fetchOverride'],
    [{ remove: ['1'] }, 'source ids'],
  ])('rejects %j', (body, message) => {
    expect(() => parsePriceWatchUpdate(body)).toThrow(message)
  })

  it('parses check requests', () => {
    expect(parsePriceCheckRequest({ scope: 'source', id: 12 })).toEqual({
      scope: 'source',
      id: '12',
    })
    expect(parsePriceCheckRequest({ scope: 'knife', id: 'abc' })).toEqual({
      scope: 'knife',
      id: 'abc',
    })
    expect(parsePriceCheckRequest({ scope: 'all' })).toEqual({ scope: 'all' })
    expect(() => parsePriceCheckRequest({ scope: 'every' })).toThrow('scope')
    expect(() => parsePriceCheckRequest({ scope: 'source', id: 'x' })).toThrow(
      'numbers',
    )
  })
})
