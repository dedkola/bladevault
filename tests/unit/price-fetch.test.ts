import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkViaBrowser,
  checkViaHttp,
  headedRetryAvailable,
  offersMatch,
  visibleBrowserWindowAvailable,
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
      html: expect.stringContaining('<h1>'),
    })
  })

  it('uses Shopify’s .js endpoint once a source is known as Shopify', async () => {
    mocks.fetchExternalUrl
      .mockResolvedValueOnce(
        response(
          JSON.stringify({
            variants: [{ id: 1, price: 9900, available: false }],
          }),
        ),
      )
      .mockResolvedValueOnce(response(JSON.stringify({ currency: 'USD' })))
    const operation = createScrapeOperation()
    const check = await checkViaHttp(
      'https://shop.example/products/knife?variant=1',
      operation,
      { shopify: true, currencyHint: 'UAH' },
    )
    operation.dispose()
    expect(mocks.fetchExternalUrl.mock.calls[0][0].href).toBe(
      'https://shop.example/products/knife.js',
    )
    // The cart names the currency the amounts are in, not the last reading.
    expect(mocks.fetchExternalUrl.mock.calls[1][0].href).toBe(
      'https://shop.example/cart.js',
    )
    expect(check.offer).toEqual({
      amount: 99,
      currency: 'USD',
      availability: 'out_of_stock',
      method: 'shopify',
    })
  })

  it('asks every store for the US edition in USD', async () => {
    mocks.fetchExternalUrl.mockResolvedValue(
      response(productHtml('120.00'), 200, 'https://shop.example/p'),
    )
    const operation = createScrapeOperation()
    await checkViaHttp('https://shop.example/p', operation, {
      shopify: false,
      currencyHint: '',
    })
    operation.dispose()
    expect(mocks.fetchExternalUrl.mock.calls[0][1].headers.Cookie).toContain(
      'localization=US; cart_currency=USD',
    )
  })

  it('falls back to the currency hint when the cart cannot be read', async () => {
    mocks.fetchExternalUrl
      .mockResolvedValueOnce(
        response(JSON.stringify({ variants: [{ id: 1, price: 9900 }] })),
      )
      .mockResolvedValueOnce(response('busy', 429))
    const operation = createScrapeOperation()
    const check = await checkViaHttp(
      'https://shop.example/products/knife',
      operation,
      { shopify: true, currencyHint: 'EUR' },
    )
    operation.dispose()
    expect(check.offer?.currency).toBe('EUR')
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
    const saved = {
      name: 'localization',
      value: 'UA',
      domain: 'shop.example',
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: 'Lax' as const,
    }
    const session = { ...saved, name: 'session', value: 'abc' }
    // A saved cart keeps its currency, so it goes too.
    const cart = { ...saved, name: 'cart', value: 'uah-cart' }
    const shopifySession = { ...saved, name: '_shopify_essential', value: 'x' }
    const check = await checkViaBrowser('https://shop.example/p', operation, {
      storageState: {
        cookies: [saved, session, cart, shopifySession],
        origins: [],
      },
    })
    operation.dispose()
    const options = mocks.fetchRenderedHtml.mock.calls[0][2]
    expect(options).toMatchObject({
      screenshot: false,
      light: true,
      captureServerHtml: true,
      captureStorageState: true,
      headless: undefined,
    })
    // The country the store set from the IP is replaced by the US edition.
    const cookies = Object.fromEntries(
      options.storageState.cookies.map(
        (cookie: { name: string; value: string; domain: string }) => [
          cookie.name,
          `${cookie.value}@${cookie.domain}`,
        ],
      ),
    )
    expect(cookies).toMatchObject({
      session: 'abc@shop.example',
      localization: 'US@.shop.example',
      cart_currency: 'USD@.shop.example',
    })
    expect(cookies).not.toHaveProperty('cart')
    expect(cookies).not.toHaveProperty('_shopify_essential')
    expect(
      options.storageState.cookies.filter(
        (cookie: { name: string }) => cookie.name === 'localization',
      ),
    ).toHaveLength(1)
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

describe('visibleBrowserWindowAvailable', () => {
  it('is off in Docker and Helm, where the window opens on a virtual display', () => {
    expect(
      visibleBrowserWindowAvailable(
        { BLADEVAULT_DOCKER_RUNTIME: '1', DISPLAY: ':99' },
        'linux',
      ),
    ).toBe(false)
  })

  it('works in the desktop app and a local checkout with a display', () => {
    expect(
      visibleBrowserWindowAvailable(
        { BLADEVAULT_DESKTOP_RUNTIME: '1' },
        'darwin',
      ),
    ).toBe(true)
    expect(visibleBrowserWindowAvailable({}, 'win32')).toBe(true)
    expect(visibleBrowserWindowAvailable({ DISPLAY: ':0' }, 'linux')).toBe(true)
    expect(
      visibleBrowserWindowAvailable({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux'),
    ).toBe(true)
    expect(visibleBrowserWindowAvailable({}, 'linux')).toBe(false)
  })
})
