import { readFileSync } from 'node:fs'
import * as cheerio from 'cheerio'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  absorbSetCookies,
  addressChangeAccepted,
  amazonLocationModalUrl,
  amazonModalCsrfToken,
  amazonPageCsrfToken,
  jarFromState,
  readAmazonPageViaHttp,
  stateWithJar,
  type CookieJar,
} from '@/lib/price-monitor/amazon-session'
import { extractAmazonOffer } from '@/lib/scrape-amazon'
import {
  amazonDeliveryBlocked,
  amazonDeliveryLine,
} from '@/lib/scrape-amazon-location'
import { createScrapeOperation } from '@/lib/scrape-operation'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
}))
vi.mock('@/lib/url-validation', () => ({ fetchExternalUrl: mocks.fetch }))
vi.mock('@/lib/price-monitor/browser-state', () => ({
  loadBrowserState: mocks.load,
  saveBrowserState: mocks.save,
}))

const fixture = (name: string) =>
  readFileSync(
    new URL(`../fixtures/scrape/${name}.html`, import.meta.url),
    'utf8',
  )
const UKRAINE = fixture('amazon-delivery-ukraine')
const US = fixture('amazon-delivery-90210')
const URL_US = 'https://www.amazon.com/dp/B07CSBPN9F'
const MODAL =
  '<script>P.when("GLUXWidget").execute(function(){ var X = { CSRF_TOKEN : "FORM-TOKEN-0123456789", IDs:{} } })</script>'
const ACCEPTED = JSON.stringify({
  isValidAddress: 1,
  isAddressUpdated: 1,
  successful: 1,
  address: { countryCode: 'US', zipCode: '90210', city: 'BEVERLY HILLS' },
})

function reply(body: string, cookies: string[] = [], status = 200) {
  return new Response(body, {
    status,
    headers: cookies.map((cookie): [string, string] => ['set-cookie', cookie]),
  })
}

describe('Amazon page helpers', () => {
  it('reads the delivery line and tells a US delivery from a gate', () => {
    expect(amazonDeliveryLine(UKRAINE)).toBe('Ukraine')
    expect(amazonDeliveryLine(US)).toBe('Beverly H... 90210')
    expect(amazonDeliveryBlocked(UKRAINE)).toBe(true)
    expect(amazonDeliveryBlocked(US)).toBe(false)
    // No location line: the shipping notice decides.
    expect(
      amazonDeliveryBlocked(
        '<div>This item cannot be shipped to your selected delivery location.</div>',
      ),
    ).toBe(true)
    expect(amazonDeliveryBlocked('<div>In Stock</div>')).toBe(false)
  })

  it('does not read a delivery gate as out of stock', () => {
    expect(extractAmazonOffer(cheerio.load(UKRAINE), URL_US)).toBeNull()
    expect(extractAmazonOffer(cheerio.load(US), URL_US)).toEqual({
      amount: 200,
      currency: 'USD',
      availability: 'in_stock',
      method: 'amazon',
    })
    // A real sold-out box still reads as out of stock.
    const soldOut = cheerio.load(US)
    soldOut('#corePrice_feature_div, #availability').remove()
    soldOut('body').append(
      '<div id="outOfStock"><span>Currently unavailable.</span></div>',
    )
    expect(extractAmazonOffer(soldOut, URL_US)?.availability).toBe(
      'out_of_stock',
    )
  })

  it('finds the page token, the modal URL and the form token', () => {
    expect(amazonPageCsrfToken(UKRAINE)).toBe('PAGE-TOKEN-0123456789abcdef')
    expect(amazonLocationModalUrl(UKRAINE, URL_US)).toBe(
      'https://www.amazon.com/portal-migration/hz/glow/get-rendered-address-selections?deviceType=desktop&pageType=Detail&storeContext=sporting-goods&actionSource=desktop-modal',
    )
    expect(amazonModalCsrfToken(MODAL)).toBe('FORM-TOKEN-0123456789')
    expect(amazonPageCsrfToken('<html></html>')).toBeNull()
  })

  it('accepts only a saved US postcode', () => {
    expect(addressChangeAccepted(ACCEPTED)).toBe(true)
    expect(
      addressChangeAccepted(
        JSON.stringify({
          successful: 1,
          address: { countryCode: 'UA', zipCode: '' },
        }),
      ),
    ).toBe(false)
    expect(addressChangeAccepted('<html>')).toBe(false)
  })

  it('keeps a cookie jar and round-trips it through browser state', () => {
    const now = Date.UTC(2026, 10, 24)
    const jar: CookieJar = jarFromState({
      cookies: [
        {
          name: 'session-id',
          value: 'old',
          domain: '.amazon.com',
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: 'Lax',
        },
        {
          name: 'other',
          value: 'x',
          domain: '.shop.example',
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    })
    expect([...jar.keys()].sort()).toEqual([
      'i18n-prefs',
      'lc-main',
      'session-id',
    ])
    absorbSetCookies(
      jar,
      [
        'session-id=new; Domain=.amazon.com; Expires=Fri, 01 Jan 2036 00:00:00 GMT; Path=/',
        'lc-main=; Max-Age=0',
      ],
      now,
    )
    expect(jar.get('session-id')?.value).toBe('new')
    expect(jar.has('lc-main')).toBe(false)
    const state = stateWithJar(
      {
        cookies: [
          {
            name: 'other',
            value: 'x',
            domain: '.shop.example',
            path: '/',
            expires: -1,
            httpOnly: false,
            secure: false,
            sameSite: 'Lax',
          },
        ],
        origins: [],
      },
      jar,
    )
    expect(state.cookies.map((cookie) => cookie.name).sort()).toEqual([
      'i18n-prefs',
      'other',
      'session-id',
    ])
  })
})

describe('readAmazonPageViaHttp', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
    mocks.load.mockResolvedValue(undefined)
    mocks.save.mockResolvedValue(undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function run(url: string) {
    const operation = createScrapeOperation({ timeoutMs: 60_000 })
    const promise = readAmazonPageViaHttp(url, operation, 'amazon')
    for (let step = 0; step < 8; step += 1)
      await vi.advanceTimersByTimeAsync(1_000)
    try {
      return await promise
    } finally {
      operation.dispose()
    }
  }

  it('chooses the US postcode in the session and reads the page again', async () => {
    mocks.fetch
      .mockResolvedValueOnce(
        reply(UKRAINE, ['session-id=137-1; Path=/; Domain=.amazon.com']),
      )
      .mockResolvedValueOnce(reply(MODAL))
      .mockResolvedValueOnce(reply(ACCEPTED, ['sp-cdn="L5Z9:US"; Path=/']))
      .mockResolvedValueOnce(reply(US))

    const page = await run(URL_US)

    expect(page.deliveryBlocked).toBe(false)
    expect(page.html).toBe(US)
    const calls = mocks.fetch.mock.calls as Array<
      [URL, RequestInit & { headers: Record<string, string> }, unknown]
    >
    expect(calls.map(([url, init]) => [init.method, url.pathname])).toEqual([
      ['GET', '/dp/B07CSBPN9F'],
      ['GET', '/portal-migration/hz/glow/get-rendered-address-selections'],
      ['POST', '/portal-migration/hz/glow/address-change'],
      ['GET', '/dp/B07CSBPN9F'],
    ])
    expect(calls[0][1].headers['Accept-Language']).toBe('en-US,en;q=0.9')
    expect(calls[1][1].headers['anti-csrftoken-a2z']).toBe(
      'PAGE-TOKEN-0123456789abcdef',
    )
    expect(calls[1][1].headers.Cookie).toContain('session-id=137-1')
    expect(calls[2][1].headers['anti-csrftoken-a2z']).toBe(
      'FORM-TOKEN-0123456789',
    )
    expect(calls[2][2]).toEqual({ allowBody: true })
    expect(JSON.parse(String(calls[2][1].body))).toMatchObject({
      zipCode: '90210',
      locationType: 'LOCATION_INPUT',
    })
    expect(calls[3][1].headers.Cookie).toContain('sp-cdn="L5Z9:US"')
    const saved = mocks.save.mock.calls.at(-1)
    expect(saved?.[0]).toBe('amazon')
    expect(
      (saved?.[1] as { cookies: Array<{ name: string }> }).cookies.map(
        (cookie) => cookie.name,
      ),
    ).toEqual(expect.arrayContaining(['session-id', 'sp-cdn']))
  })

  it('uses a saved US session without touching the location', async () => {
    mocks.fetch.mockResolvedValueOnce(reply(US))
    const page = await run(URL_US)
    expect(page.deliveryBlocked).toBe(false)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it('reports the page as gated when Amazon refuses the postcode', async () => {
    mocks.fetch
      .mockResolvedValueOnce(reply(UKRAINE))
      .mockResolvedValueOnce(reply(MODAL))
      .mockResolvedValueOnce(reply(JSON.stringify({ successful: 0 })))
    const page = await run(URL_US)
    expect(page.deliveryBlocked).toBe(true)
    expect(mocks.fetch).toHaveBeenCalledTimes(3)
  })

  it('fails closed on a bot check', async () => {
    mocks.fetch.mockResolvedValueOnce(
      reply(
        '<html><form action="/errors/validateCaptcha"><p>Enter the characters you see below</p></form></html>',
      ),
    )
    const operation = createScrapeOperation({ timeoutMs: 60_000 })
    await expect(
      readAmazonPageViaHttp(URL_US, operation, 'amazon'),
    ).rejects.toMatchObject({ code: 'challenge' })
    operation.dispose()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('reads other marketplaces as they are, without the US session', async () => {
    mocks.fetch.mockResolvedValueOnce(reply('<html>Deliver to Ukraine</html>'))
    const page = await run('https://www.amazon.co.uk/dp/B0FRRWK52D')
    expect(page.deliveryBlocked).toBe(false)
    expect(mocks.load).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
    const init = mocks.fetch.mock.calls[0][1] as {
      headers: Record<string, string>
    }
    expect(init.headers.Cookie).toBeUndefined()
  })
})
