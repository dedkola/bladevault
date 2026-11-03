import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { lookup, requestExternalUrl } = vi.hoisted(() => ({
  lookup: vi.fn(),
  requestExternalUrl: vi.fn(),
}))
vi.mock('dns/promises', () => ({ lookup }))
vi.mock('@/lib/external-http', () => ({ requestExternalUrl }))

import { fetchExternalUrl, validateExternalUrl } from '@/lib/url-validation'

const publicAddress = { address: '93.184.216.34', family: 4 }

describe('external URL validation', () => {
  beforeEach(() => {
    lookup.mockResolvedValue([publicAddress])
  })

  afterEach(() => {
    lookup.mockReset()
    requestExternalUrl.mockReset()
  })

  it.each([
    'http://localhost/path',
    'http://127.0.0.1/path',
    'http://10.0.0.1/path',
    'http://100.64.0.1/path',
    'http://169.254.1.1/path',
    'http://192.168.1.1/path',
    'http://[::1]/path',
    'http://[0:0:0:0:0:0:0:1]/path',
    'http://[::127.0.0.1]/path',
    'http://[::7f00:1]/path',
    'http://[::c0a8:101]/path',
    'http://[::ffff:127.0.0.1]/path',
    'http://[::ffff:7f00:1]/path',
    'http://[0:0:0:0:0:ffff:7f00:1]/path',
    'http://[::ffff:a00:1]/path',
    'http://[::ffff:c0a8:101]/path',
    'http://[fe80::1]/path',
    'http://[fc00::1]/path',
    'http://[2001:db8::1]/path',
  ])('rejects unsafe destination %s before DNS or transport', async (url) => {
    await expect(validateExternalUrl(url)).resolves.toEqual({
      ok: false,
      reason: 'Private or internal URLs are not allowed',
    })
    expect(lookup).not.toHaveBeenCalled()
    expect(requestExternalUrl).not.toHaveBeenCalled()
  })

  it('rejects non-HTTP protocols', async () => {
    await expect(validateExternalUrl('file:///tmp/knife')).resolves.toEqual({
      ok: false,
      reason: 'Only HTTP and HTTPS URLs are allowed',
    })
    expect(lookup).not.toHaveBeenCalled()
  })

  it.each([
    { address: '192.168.1.2', family: 4 },
    { address: '100.127.255.254', family: 4 },
    { address: '::ffff:127.0.0.1', family: 6 },
    { address: '::ffff:7f00:1', family: 6 },
    { address: '0:0:0:0:0:ffff:c0a8:102', family: 6 },
  ])(
    'rejects mixed DNS answers containing $address',
    async (privateAddress) => {
      lookup.mockResolvedValue([publicAddress, privateAddress])

      await expect(
        fetchExternalUrl(new URL('https://mixed.example/knife'), {}),
      ).rejects.toMatchObject({ code: 'blocked_url' })

      expect(requestExternalUrl).not.toHaveBeenCalled()
    },
  )

  it('returns the existing public validation shape without connection details', async () => {
    const url = new URL('https://public.example/knife')

    await expect(validateExternalUrl(url.href)).resolves.toEqual({
      ok: true,
      url,
    })
  })

  it.each([{ answers: [] }, { answers: undefined }])(
    'reports missing DNS answers as a connection failure',
    async ({ answers }) => {
      lookup.mockResolvedValue(answers)

      await expect(
        validateExternalUrl('https://missing.example/product'),
      ).resolves.toMatchObject({
        ok: false,
        code: 'network',
        reason: expect.stringContaining('could not be resolved'),
      })
    },
  )

  it('pins the public address from one DNS lookup to prevent rebinding', async () => {
    lookup
      .mockResolvedValueOnce([publicAddress])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
    const response = Response.json({ product: 'Chief' })
    requestExternalUrl.mockResolvedValue(response)
    const url = new URL('https://public.example/knife')
    const signal = new AbortController().signal

    await expect(fetchExternalUrl(url, { signal })).resolves.toBe(response)

    expect(lookup).toHaveBeenCalledTimes(1)
    expect(requestExternalUrl).toHaveBeenCalledWith(url, publicAddress, {
      signal,
      redirect: 'manual',
    })
  })

  it('prefers a public IPv4 connection when DNS also returns public IPv6', async () => {
    lookup.mockResolvedValue([
      { address: '2606:4700:4700::1111', family: 6 },
      publicAddress,
    ])
    requestExternalUrl.mockResolvedValue(new Response('product'))
    const url = new URL('https://public.example/knife')

    await fetchExternalUrl(url, {})

    expect(lookup).toHaveBeenCalledTimes(1)
    expect(requestExternalUrl).toHaveBeenCalledWith(url, publicAddress, {
      redirect: 'manual',
    })
  })

  it.each([
    ['https://8.8.8.8/knife', { address: '8.8.8.8', family: 4 }],
    [
      'https://[2606:4700:4700::1111]/knife',
      { address: '2606:4700:4700::1111', family: 6 },
    ],
    [
      'https://[::ffff:8.8.8.8]/knife',
      { address: '::ffff:808:808', family: 6 },
    ],
  ] as const)(
    'pins the resolver result for the public literal %s',
    async (target, address) => {
      lookup.mockResolvedValue([address])
      requestExternalUrl.mockResolvedValue(new Response('product'))

      await fetchExternalUrl(new URL(target), {})

      expect(lookup).toHaveBeenCalledTimes(1)
      expect(lookup).toHaveBeenCalledWith(
        new URL(target).hostname.replace(/^\[|\]$/g, ''),
        { all: true, verbatim: true },
      )
      expect(requestExternalUrl).toHaveBeenCalledWith(
        new URL(target),
        address,
        {
          redirect: 'manual',
        },
      )
    },
  )

  it('resolves and pins each redirect hop once and releases redirect bodies', async () => {
    const nextAddress = { address: '1.1.1.1', family: 4 }
    lookup
      .mockResolvedValueOnce([publicAddress])
      .mockResolvedValueOnce([nextAddress])
    const cancel = vi.fn()
    requestExternalUrl
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel }), {
          status: 302,
          headers: { Location: 'https://next.example/final' },
        }),
      )
      .mockResolvedValueOnce(new Response('product'))

    await fetchExternalUrl(new URL('https://public.example/start'), {})

    expect(lookup).toHaveBeenCalledTimes(2)
    expect(lookup.mock.calls.map(([host]) => host)).toEqual([
      'public.example',
      'next.example',
    ])
    expect(requestExternalUrl).toHaveBeenNthCalledWith(
      1,
      new URL('https://public.example/start'),
      publicAddress,
      { redirect: 'manual' },
    )
    expect(requestExternalUrl).toHaveBeenNthCalledWith(
      2,
      new URL('https://next.example/final'),
      nextAddress,
      { redirect: 'manual' },
    )
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('blocks a private redirect before a second request', async () => {
    requestExternalUrl.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'http://[::ffff:127.0.0.1]/private' },
      }),
    )

    await expect(
      fetchExternalUrl(new URL('https://public.example/start'), {}),
    ).rejects.toMatchObject({
      code: 'blocked_url',
    })

    expect(requestExternalUrl).toHaveBeenCalledTimes(1)
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('revalidates the initial request instead of trusting an earlier check', async () => {
    const url = new URL('https://changing.example/knife')
    await expect(validateExternalUrl(url.href)).resolves.toMatchObject({
      ok: true,
    })
    lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])

    await expect(fetchExternalUrl(url, {})).rejects.toMatchObject({
      code: 'blocked_url',
    })

    expect(requestExternalUrl).not.toHaveBeenCalled()
  })

  it('stops a redirect loop after the existing five-redirect limit', async () => {
    requestExternalUrl.mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: '/again' },
        }),
    )

    await expect(
      fetchExternalUrl(new URL('https://public.example/start'), {}),
    ).rejects.toMatchObject({ code: 'redirect' })

    expect(requestExternalUrl).toHaveBeenCalledTimes(6)
    expect(lookup).toHaveBeenCalledTimes(6)
  })

  it('rejects a redirect with no destination', async () => {
    requestExternalUrl.mockResolvedValue(new Response(null, { status: 302 }))

    await expect(
      fetchExternalUrl(new URL('https://public.example/start'), {}),
    ).rejects.toMatchObject({ code: 'redirect' })

    expect(requestExternalUrl).toHaveBeenCalledTimes(1)
  })

  it('does not perform DNS lookup or a request after cancellation', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      fetchExternalUrl(new URL('https://public.example/start'), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(lookup).not.toHaveBeenCalled()
    expect(requestExternalUrl).not.toHaveBeenCalled()
  })

  it('cancels a stuck DNS lookup without beginning the request', async () => {
    lookup.mockImplementation(() => new Promise(() => {}))
    const controller = new AbortController()
    const result = fetchExternalUrl(new URL('https://public.example/start'), {
      signal: controller.signal,
    })
    const failed = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()

    controller.abort()

    await failed
    expect(requestExternalUrl).not.toHaveBeenCalled()
  })
})
