import { describe, expect, it } from 'vitest'
import type { Knife } from '@/lib/data'
import {
  digestDue,
  digestHasNews,
  parseDigestAnswer,
  type DigestData,
} from '@/lib/price-monitor/digest'
import {
  buildVerifyPrompt,
  confirmChangesActive,
  describeRejection,
  parseVerifyAnswer,
  spotCheckActive,
  verifyProduct,
} from '@/lib/price-monitor/verify'
import { DEFAULT_PRICE_MONITORING } from '@/lib/settings-shared'

const FRAGMENT =
  'Title: Raccoon\n<span class="price-now">$90.00</span> <span class="price">$118.50</span>'
const READING = {
  priceMinor: 9000,
  currency: 'USD',
  availability: 'in_stock' as const,
}

describe('parseVerifyAnswer', () => {
  it('accepts only confident verdicts', () => {
    expect(
      parseVerifyAnswer(
        { verdict: 'confirmed', confidence: 0.9 },
        FRAGMENT,
        READING,
      ),
    ).toEqual({ status: 'confirmed', confidence: 0.9 })
    expect(
      parseVerifyAnswer(
        { verdict: 'rejected', issue: 'bundle', confidence: 0.6 },
        FRAGMENT,
        READING,
      ),
    ).toEqual({ status: 'unsure' })
    expect(
      parseVerifyAnswer(
        { verdict: 'unsure', confidence: 1 },
        FRAGMENT,
        READING,
      ),
    ).toEqual({ status: 'unsure' })
    expect(parseVerifyAnswer('nonsense', FRAGMENT, READING)).toEqual({
      status: 'unsure',
    })
  })

  it('keeps a quoted price only when it is on the page', () => {
    expect(
      parseVerifyAnswer(
        {
          verdict: 'rejected',
          issue: 'bundle',
          pagePrice: '$75.00',
          confidence: 0.95,
          reason: ' Price of a\n set. ',
        },
        FRAGMENT,
        READING,
      ),
    ).toEqual({
      status: 'rejected',
      issue: 'bundle',
      confidence: 0.95,
      reason: 'Price of a set.',
      pagePrice: null,
      title: null,
      page: {},
    })
  })

  it('needs a real, different page price for a "different price" claim', () => {
    const answer = {
      verdict: 'rejected',
      issue: 'different_price',
      confidence: 0.95,
      reason: 'x',
    }
    expect(
      parseVerifyAnswer({ ...answer, pagePrice: '$99.00' }, FRAGMENT, READING),
    ).toEqual({ status: 'unsure' })
    expect(
      parseVerifyAnswer({ ...answer, pagePrice: '$90.00' }, FRAGMENT, READING),
    ).toEqual({ status: 'unsure' })
    expect(
      parseVerifyAnswer({ ...answer, pagePrice: '$118.50' }, FRAGMENT, READING),
    ).toMatchObject({ status: 'rejected', pagePrice: '$118.50' })
  })

  it('maps unknown issues to other and describes the rejection', () => {
    const verdict = parseVerifyAnswer(
      {
        verdict: 'rejected',
        issue: 'mystery',
        pagePrice: '$118.50',
        confidence: 0.85,
        reason: 'Looks off.',
      },
      FRAGMENT,
      READING,
    )
    expect(verdict).toMatchObject({ status: 'rejected', issue: 'other' })
    if (verdict.status !== 'rejected') throw new Error('expected a rejection')
    expect(describeRejection(verdict)).toBe(
      'the reading looks wrong; the page shows $118.50 (Looks off.)',
    )
  })
})

describe('verify inputs', () => {
  const knife = {
    id: 'k1',
    name: 'Raccoon',
    brand: 'Vosteed',
    bladeStyle: 'Drop point',
    handleMaterial: 'G10',
    images: ['a.jpg'],
    specs: {
      weight: '3 oz',
      overallLength: '7.5 in',
      bladeLength: '3.3 in',
      bladeMaterial: 'Nitro-V',
      price: '129.00 USD',
      country: 'China',
    },
    customFields: { secret: 'x' },
    addedAt: '',
    updatedAt: '',
    description: 'private notes',
    sourceUrl: 'https://shop.example/p',
    pinned: false,
    sold: false,
  } satisfies Knife

  it('sends brand, name and key specs, never the price or notes', () => {
    const product = verifyProduct(knife)
    expect(product).toEqual({
      brand: 'Vosteed',
      name: 'Raccoon',
      specs: {
        bladeStyle: 'Drop point',
        handleMaterial: 'G10',
        bladeLength: '3.3 in',
        overallLength: '7.5 in',
        bladeMaterial: 'Nitro-V',
        weight: '3 oz',
      },
    })
    const prompt = buildVerifyPrompt(
      {
        product,
        host: 'shop.example',
        reading: READING,
        previous: { priceMinor: 11850, currency: 'USD' },
        reason: 'notify',
      },
      FRAGMENT,
    )
    expect(prompt).toContain('"price":"$90.00"')
    expect(prompt).toContain('"price":"$118.50"')
    expect(prompt).not.toContain('129')
    expect(prompt).not.toContain('private notes')
    expect(prompt).not.toContain('China')
  })

  it('switches on only with AI configured, spot checks only in Unlimited', () => {
    const ai = DEFAULT_PRICE_MONITORING.ai
    expect(confirmChangesActive(ai)).toBe(false)
    const on = { ...ai, enabled: true, baseUrl: 'http://x/v1', model: 'm' }
    expect(confirmChangesActive(on)).toBe(true)
    expect(confirmChangesActive({ ...on, confirmChanges: false })).toBe(false)
    expect(spotCheckActive(on)).toBe(false)
    expect(
      spotCheckActive({ ...on, usage: { ...on.usage, mode: 'unlimited' } }),
    ).toBe(true)
  })
})

describe('digest', () => {
  const DATA = JSON.stringify({ price: '$100.00', regularPrice: '$1,299.00' })

  it('accepts a summary that only quotes prices from the data', () => {
    expect(
      parseDigestAnswer(
        { title: '**Deal**', summary: 'Now $100.00, regular price $1,299.' },
        DATA,
      ),
    ).toEqual({ title: 'Deal', summary: 'Now $100.00, regular price $1,299.' })
    expect(
      parseDigestAnswer({ title: 'Deal', summary: 'Now $99.00.' }, DATA),
    ).toBeNull()
    expect(parseDigestAnswer({ title: '', summary: 'x' }, DATA)).toBeNull()
  })

  it('is due once per local day from the morning on', () => {
    const at = (day: number, hour: number) =>
      new Date(2026, 10, day, hour, 0, 0).getTime()
    expect(digestDue(null, at(19, 5))).toBe(false)
    expect(digestDue(null, at(19, 6))).toBe(true)
    expect(digestDue(new Date(at(19, 7)).toISOString(), at(19, 23))).toBe(false)
    expect(digestDue(new Date(at(19, 7)).toISOString(), at(20, 6))).toBe(true)
  })

  it('has news only when something happened', () => {
    const empty: DigestData = {
      monitoredSources: 3,
      checks: { total: 3, failed: 0, blocked: 0, noPrice: 0 },
      deals: [],
      drops: [],
      increases: 0,
      restocks: [],
      wentOutOfStock: 0,
      needAttention: [],
      needAttentionCount: 0,
      ai: {
        pricesRead: 0,
        storesHelped: [],
        errorsWorked: 0,
        readingsUnconfirmed: 0,
        readingsDoubted: 0,
        requests: 0,
        failedRequests: 0,
      },
    }
    expect(digestHasNews(empty)).toBe(false)
    expect(digestHasNews({ ...empty, increases: 1 })).toBe(true)
  })
})
