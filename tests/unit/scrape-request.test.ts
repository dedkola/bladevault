import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestScrape } from '@/lib/scrape-request'
import { ScrapeError } from '@/lib/scrape-errors'

describe('scrape requests', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('bounds a request even when fetch ignores cancellation', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>(() => {}),
    )
    vi.stubGlobal('fetch', fetch)
    const result = requestScrape('/api/scrape', {}, { timeoutMs: 100 })
    const failed = expect(result).rejects.toMatchObject({ code: 'timeout' })

    await vi.advanceTimersByTimeAsync(100)

    await failed
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      signal: expect.objectContaining({ aborted: true }),
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the timeout active while reading a stalled response body', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new ReadableStream({ start() {} }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const result = requestScrape('/api/scrape', {}, { timeoutMs: 100 })
    const failed = expect(result).rejects.toMatchObject({ code: 'timeout' })

    await vi.advanceTimersByTimeAsync(100)

    await failed
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves the server challenge code and actionable message', async () => {
    const message =
      'This retailer requires security verification. Use Interact with page, then Continue.'
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: message, code: 'challenge' }, { status: 403 }),
        ),
    )

    await expect(requestScrape('/api/scrape')).rejects.toMatchObject({
      code: 'challenge',
      message,
      status: 403,
    })
  })

  it('explains a connection failure without exposing a raw exception', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('fetch failed: internal detail')),
    )

    const error = await requestScrape('/api/scrape').catch((error) => error)
    if (!(error instanceof ScrapeError)) {
      throw new Error('Expected a scrape error', { cause: error })
    }

    expect(error).toMatchObject({ code: 'network' })
    expect(error.message).toMatch(/connect|network|reach/i)
    expect(error.message).not.toContain('internal detail')
  })

  it('reports a network failure while reading the body rather than malformed JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(
                new TypeError('terminated', {
                  cause: { code: 'UND_ERR_SOCKET' },
                }),
              )
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    await expect(requestScrape('/api/scrape')).rejects.toMatchObject({
      code: 'network',
      message: expect.stringMatching(/connect|network|reach/i),
    })
  })

  it.each([
    [
      new TypeError('fetch failed', {
        cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
      }),
      'timeout',
    ],
    [new Error('net::ERR_CONNECTION_TIMED_OUT'), 'timeout'],
    [new Error('net::ERR_INVALID_REDIRECT'), 'redirect'],
    [new Error('net::ERR_UNSAFE_REDIRECT'), 'redirect'],
  ])('identifies a low-level failure: %s', async (error, code) => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error))
    await expect(requestScrape('/api/scrape')).rejects.toMatchObject({ code })
  })

  it('distinguishes caller cancellation from a timeout', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    )
    const controller = new AbortController()
    const result = requestScrape('/api/scrape', {
      signal: controller.signal,
    })
    const failed = expect(result).rejects.toMatchObject({ code: 'cancelled' })

    controller.abort()

    await failed
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns successful data and clears the request timer', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ product: { name: 'Chief' } })),
    )

    await expect(requestScrape('/api/scrape')).resolves.toEqual({
      product: { name: 'Chief' },
    })
    expect(vi.getTimerCount()).toBe(0)
  })
})
