import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'
import * as scrapeRoute from '@/app/api/scrape/route'
import { SCRAPE_TIMEOUT_MS, ScrapeError } from '@/lib/scrape-errors'

const { rendered, lookup, requestExternalUrl } = vi.hoisted(() => ({
  rendered: vi.fn(),
  lookup: vi.fn(),
  requestExternalUrl: vi.fn(),
}))
vi.mock('@/lib/external-http', () => ({ requestExternalUrl }))
vi.mock('@/lib/scrape-playwright', () => ({ fetchRenderedHtml: rendered }))
vi.mock('dns/promises', () => ({ lookup }))

const url = 'https://shop.example.com/knife/chief'
const productHtml =
  '<html><body><main><h1>Native Chief</h1><p>A folding knife.</p></main></body></html>'
const challengeHtml = `<html><body><h1>Just a moment...</h1>
  <p>Enable JavaScript and cookies to continue.</p>
  <p>Performing security verification before accessing the product page.</p>
  </body></html>`
let vault: TempVault | null = null

function request(target = url, signal?: AbortSignal) {
  return new Request('http://localhost/api/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: target }),
    signal,
  })
}

function htmlResponse(html: string, status = 200, finalUrl = url) {
  const response = new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  })
  Object.defineProperty(response, 'url', { value: finalUrl })
  return response
}

describe('scrape API deadlines and errors', () => {
  beforeEach(async () => {
    vault = await createTempVault()
    rendered.mockReset()
    lookup.mockReset()
    requestExternalUrl.mockReset()
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    await vault?.cleanup()
    vault = null
  })

  it('returns a timeout for a stuck renderer without starting a fresh fallback', async () => {
    vi.useFakeTimers()
    rendered.mockImplementation(() => new Promise(() => {}))
    const fetch = requestExternalUrl
    const response = scrapeRoute.POST(request())

    await vi.advanceTimersByTimeAsync(SCRAPE_TIMEOUT_MS)

    const result = await response
    expect(result.status).toBe(504)
    expect(await result.json()).toMatchObject({
      code: 'timeout',
      error: expect.stringMatching(/60 seconds/),
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('shares the overall deadline with an HTTP fallback', async () => {
    vi.useFakeTimers()
    rendered.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40_000))
      throw new Error('The browser could not load this page')
    })
    const fetch = requestExternalUrl.mockImplementation(
      () => new Promise<Response>(() => {}),
    )
    const response = scrapeRoute.POST(request())

    await vi.advanceTimersByTimeAsync(40_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(SCRAPE_TIMEOUT_MS - 40_000)

    const result = await response
    expect(result.status).toBe(504)
    expect(await result.json()).toMatchObject({ code: 'timeout' })
  })

  it('bounds a fallback response whose headers arrive but body never finishes', async () => {
    vi.useFakeTimers()
    rendered.mockRejectedValue(new Error('Renderer unavailable'))
    requestExternalUrl.mockResolvedValue(
      new Response(new ReadableStream({ start() {} }), {
        headers: { 'Content-Type': 'text/html' },
      }),
    )
    const response = scrapeRoute.POST(request())

    await vi.advanceTimersByTimeAsync(SCRAPE_TIMEOUT_MS)

    const result = await response
    expect(result.status).toBe(504)
    expect(await result.json()).toMatchObject({ code: 'timeout' })
  })

  it('bounds DNS lookup before launching the browser', async () => {
    vi.useFakeTimers()
    lookup.mockImplementation(() => new Promise(() => {}))
    const response = scrapeRoute.POST(request())

    await vi.advanceTimersByTimeAsync(SCRAPE_TIMEOUT_MS)

    const result = await response
    expect(result.status).toBe(504)
    expect(await result.json()).toMatchObject({ code: 'timeout' })
    expect(rendered).not.toHaveBeenCalled()
  })

  it('distinguishes an unresolvable hostname from a private address', async () => {
    lookup.mockRejectedValue(
      Object.assign(new Error('lookup failed'), {
        code: 'ENOTFOUND',
      }),
    )

    const response = await scrapeRoute.POST(request())

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      code: 'network',
      error: expect.stringMatching(/URL|connect|website/i),
    })
    expect(rendered).not.toHaveBeenCalled()
  })

  it('reports a fallback redirect loop instead of an earlier browser error', async () => {
    rendered.mockRejectedValue(new Error('Renderer unavailable'))
    const fetch = requestExternalUrl.mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: '/again' },
        }),
    )

    const response = await scrapeRoute.POST(request())

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      code: 'redirect',
      error: expect.stringMatching(/redirect|final URL/i),
    })
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(6)
  })

  it('recognizes a CAPTCHA page returned with HTTP 403', async () => {
    rendered.mockRejectedValue(new Error('Website returned HTTP 403'))
    requestExternalUrl.mockResolvedValue(htmlResponse(challengeHtml, 403))

    const response = await scrapeRoute.POST(request())

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      code: 'challenge',
      error: expect.stringMatching(/Interact with page.*Continue/i),
    })
  })

  it('keeps a confirmed challenge from being replaced by a generic fallback error', async () => {
    rendered.mockRejectedValue(new ScrapeError('challenge'))
    const fetch = requestExternalUrl

    const response = await scrapeRoute.POST(request())

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'challenge' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects malformed URLs before launching a browser', async () => {
    const response = await scrapeRoute.POST(request('not a URL'))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'invalid_url' })
    expect(rendered).not.toHaveBeenCalled()
  })

  it.each(['{', 'null'])(
    'rejects malformed or null request body %s with an actionable validation error',
    async (body) => {
      const response = await scrapeRoute.POST(
        new Request('http://localhost/api/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }),
      )

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'invalid_url' })
      expect(rendered).not.toHaveBeenCalled()
    },
  )

  it('continues to block private redirect destinations', async () => {
    rendered.mockRejectedValue(new Error('Renderer unavailable'))
    const fetch = requestExternalUrl.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: 'http://127.0.0.1/private' },
      }),
    )

    const response = await scrapeRoute.POST(request())

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'blocked_url' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(
      new URL(url),
      { address: '93.184.216.34', family: 4 },
      expect.objectContaining({ redirect: 'manual' }),
    )
  })

  it('returns usable product details after a successful HTML fallback', async () => {
    rendered.mockRejectedValue(new Error('Renderer unavailable'))
    requestExternalUrl.mockResolvedValue(htmlResponse(productHtml))

    const response = await scrapeRoute.POST(request())

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      product: { name: 'Native Chief', sourceUrl: url },
      screenshotWarning: expect.any(String),
    })
  })

  it('keeps usable product details when optional Shopify enrichment stalls', async () => {
    vi.useFakeTimers()
    const shopifyUrl = 'https://shop.example.com/products/chief'
    rendered.mockResolvedValue({
      html: `${productHtml}<script>Shopify.shop = 'shop.example.com'</script>`,
      finalUrl: shopifyUrl,
    })
    const fetch = requestExternalUrl.mockImplementation(
      () => new Promise<Response>(() => {}),
    )
    const response = scrapeRoute.POST(request(shopifyUrl))

    await vi.advanceTimersByTimeAsync(10_000)

    const result = await response
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({
      product: { name: 'Native Chief' },
      warnings: expect.arrayContaining([expect.any(String)]),
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('cancels the current operation when the client disconnects', async () => {
    vi.useFakeTimers()
    rendered.mockImplementation(() => new Promise(() => {}))
    const controller = new AbortController()
    const response = scrapeRoute.POST(request(url, controller.signal))
    await vi.advanceTimersByTimeAsync(0)

    controller.abort()

    const result = await response
    expect(result.status).toBe(499)
    expect(await result.json()).toMatchObject({ code: 'cancelled' })
  })

  it('does not launch the browser or fallback when cancelled while reading the request body', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const incoming = request(url, controller.signal)
    const readBody = vi
      .spyOn(incoming, 'json')
      .mockImplementation(() => new Promise(() => {}))
    const fetch = requestExternalUrl
    const response = scrapeRoute.POST(incoming)
    await vi.advanceTimersByTimeAsync(0)
    expect(readBody).toHaveBeenCalledTimes(1)

    controller.abort()

    const result = await response
    expect(result.status).toBe(499)
    expect(await result.json()).toMatchObject({ code: 'cancelled' })
    expect(rendered).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})
