import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkViaBrowser,
  checkViaHttp,
  headedRetryAvailable,
  offersMatch,
  upstreamStatus,
} from '@/lib/price-monitor/fetch'
import { createScrapeOperation } from '@/lib/scrape-operation'
import { ScrapeError } from '@/lib/scrape-errors'

const mocks = vi.hoisted(() => ({
  fetchExternalUrl: vi.fn(),
  fetchRenderedHtml: vi.fn(),
}))
vi.mock('@/lib/url-validation', () => ({
  fetchExternalUrl: mocks.fetchExternalUrl,
}))
vi.mock('@/lib/scrape-playwright', () => ({
  fetchRenderedHtml: mocks.fetchRenderedHtml,
}))

const productHtml = (price: string, availability = 'InStock') =>
  `<html><head><script type="application/ld+json">${JSON.stringify({
    '@type': 'Product',
    offers: {
      price,
      priceCurrency: 'USD',
      availability: `https://schema.org/${availability}`,
    },
  })}</script></head><body><h1>Knife</h1></body></html>`

function response(body: string, status = 200, url = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    text: async () => body,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('offersMatch', () => {
  const offer = {
    amount: 99,
    currency: 'USD',
    availability: 'in_stock' as const,
    method: 'jsonld' as const,
  }
  it('needs the same price, currency and stock status', () => {
    expect(offersMatch(offer, { ...offer, method: 'meta' })).toBe(true)
    expect(offersMatch(offer, { ...offer, amount: 98 })).toBe(false)
    expect(offersMatch(offer, { ...offer, availability: 'unknown' })).toBe(
      false,
    )
    expect(offersMatch(offer, null)).toBe(false)
    expect(
      offersMatch({ ...offer, amount: null }, { ...offer, amount: null }),
    ).toBe(false)
  })
})

describe('upstreamStatus', () => {
  it('reads the store status from fetch errors', () => {
    expect(
      upstreamStatus(
        new ScrapeError('http', 'The website returned HTTP 403. Open the URL'),
      ),
    ).toBe(403)
    expect(upstreamStatus(new ScrapeError('network'))).toBeNull()
  })
})

describe('checkViaHttp', () => {
  it('reads the product page and detects Shopify', async () => {
    mocks.fetchExternalUrl.mockResolvedValue(
      response(
        productHtml('120.00').replace(
          '<h1>',
          '<script src="https://cdn.shopify.com/x.js"></script><h1>',
        ),
        200,
        'https://shop.example/products/knife',
      ),
    )
    const operation = createScrapeOperation()
    const check = await checkViaHttp(
      'https://shop.example/products/knife',
      operation,
      { shopify: false, currencyHint: '' },
    )
    operation.dispose()
    expect(check).toEqual({
      offer: {
        amount: 120,
        currency: 'USD',
        availability: 'in_stock',
        method: 'jsonld',
      },
      finalUrl: 'https://shop.example/products/knife',
      isShopify: true,
    })
  })

  it('uses Shopify’s .js endpoint once a source is known as Shopify', async () => {
    mocks.fetchExternalUrl.mockResolvedValue(
      response(
        JSON.stringify({
          variants: [{ id: 1, price: 9900, available: false }],
        }),
      ),
    )
    const operation = createScrapeOperation()
    const check = await checkViaHttp(
      'https://shop.example/products/knife?variant=1',
      operation,
      { shopify: true, currencyHint: 'EUR' },
    )
    operation.dispose()
    expect(mocks.fetchExternalUrl.mock.calls[0][0].href).toBe(
      'https://shop.example/products/knife.js',
    )
    expect(check.offer).toEqual({
      amount: 99,
      currency: 'EUR',
      availability: 'out_of_stock',
      method: 'shopify',
    })
  })

  it('reports challenges and HTTP errors', async () => {
    const operation = createScrapeOperation()
    mocks.fetchExternalUrl.mockResolvedValueOnce(
      response(
        '<html>Just a moment... challenges.cloudflare.com</html>' +
          'x'.repeat(100),
        403,
      ),
    )
    await expect(
      checkViaHttp('https://shop.example/p', operation, {
        shopify: false,
        currencyHint: '',
      }),
    ).rejects.toMatchObject({ code: 'challenge' })
    mocks.fetchExternalUrl.mockResolvedValueOnce(response('gone', 404))
    await expect(
      checkViaHttp('https://shop.example/p', operation, {
        shopify: false,
        currencyHint: '',
      }),
    ).rejects.toMatchObject({
      code: 'http',
      message: expect.stringContaining('HTTP 404'),
    })
    operation.dispose()
  })
})

describe('checkViaBrowser', () => {
  it('renders in light mode and reads the raw server HTML too', async () => {
    mocks.fetchRenderedHtml.mockResolvedValue({
      html: productHtml('80.00', 'OutOfStock'),
      serverHtml: productHtml('80.00', 'OutOfStock'),
      finalUrl: 'https://shop.example/p',
      storageState: { cookies: [], origins: [] },
    })
    const operation = createScrapeOperation()
    const check = await checkViaBrowser('https://shop.example/p', operation, {
      storageState: { cookies: [], origins: [] },
    })
    operation.dispose()
    expect(mocks.fetchRenderedHtml).toHaveBeenCalledWith(
      'https://shop.example/p',
      operation,
      {
        screenshot: false,
        light: true,
        captureServerHtml: true,
        captureStorageState: true,
        storageState: { cookies: [], origins: [] },
        headless: undefined,
      },
    )
    expect(check.offer).toMatchObject({
      amount: 80,
      availability: 'out_of_stock',
    })
    expect(offersMatch(check.offer, check.serverOffer)).toBe(true)
    expect(check.storageState).toEqual({ cookies: [], origins: [] })
  })
})

describe('headedRetryAvailable', () => {
  it('needs the Docker runtime and a display', () => {
    vi.stubEnv('BLADEVAULT_DOCKER_RUNTIME', '1')
    vi.stubEnv('DISPLAY', ':99')
    expect(headedRetryAvailable()).toBe(true)
    vi.stubEnv('DISPLAY', '')
    expect(headedRetryAvailable()).toBe(false)
    vi.unstubAllEnvs()
  })
})
