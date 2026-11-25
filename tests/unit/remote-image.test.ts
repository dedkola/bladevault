import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { lookup, requestExternalUrl } = vi.hoisted(() => ({
  lookup: vi.fn(),
  requestExternalUrl: vi.fn(),
}))
vi.mock('dns/promises', () => ({ lookup }))
vi.mock('@/lib/external-http', () => ({ requestExternalUrl }))

import {
  fetchRemoteImage,
  isHostAllowed,
  mapWithConcurrency,
  sniffImageType,
} from '@/lib/remote-image'

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
])
const AVIF = Buffer.concat([
  Buffer.from([0, 0, 0, 0x1c]),
  Buffer.from('ftypavif'),
])

function imageResponse(
  bytes: Buffer | string,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return new Response(
    typeof bytes === 'string' ? bytes : new Uint8Array(bytes),
    {
      status: init.status ?? 200,
      headers: { 'content-type': 'image/png', ...init.headers },
    },
  )
}

describe('sniffImageType', () => {
  it.each([
    [PNG, 'image/png'],
    [JPEG, 'image/jpeg'],
    [WEBP, 'image/webp'],
    [AVIF, 'image/avif'],
    [Buffer.from('GIF89a......'), 'image/gif'],
  ])('recognizes raster images', (bytes, mime) => {
    expect(sniffImageType(bytes)?.mime).toBe(mime)
  })

  it.each([
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    Buffer.from('<!doctype html><html></html>'),
    Buffer.from(''),
  ])('rejects SVG, HTML and empty bodies', (bytes) => {
    expect(sniffImageType(bytes)).toBeNull()
  })
})

describe('isHostAllowed', () => {
  it('allows every host without a list, and subdomains with one', () => {
    expect(isHostAllowed('anything.example', undefined)).toBe(true)
    expect(isHostAllowed('cdn.shopify.com', ['shopify.com'])).toBe(true)
    expect(isHostAllowed('shopify.com', ['shopify.com'])).toBe(true)
    expect(isHostAllowed('evilshopify.com', ['shopify.com'])).toBe(false)
    expect(isHostAllowed('example.org', [])).toBe(false)
  })
})

describe('fetchRemoteImage', () => {
  beforeEach(() => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  })
  afterEach(() => {
    lookup.mockReset()
    requestExternalUrl.mockReset()
  })

  it('downloads a public https image and hashes it', async () => {
    requestExternalUrl.mockResolvedValue(imageResponse(PNG))
    const result = await fetchRemoteImage('https://example.com/a.png')
    expect(result).toMatchObject({
      ok: true,
      mime: 'image/png',
      ext: 'png',
      finalUrl: 'https://example.com/a.png',
    })
    expect(result.ok && result.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses plain http before any network access', async () => {
    const result = await fetchRemoteImage('http://example.com/a.png')
    expect(result).toMatchObject({ ok: false, code: 'not_https' })
    expect(lookup).not.toHaveBeenCalled()
    expect(requestExternalUrl).not.toHaveBeenCalled()
  })

  it.each([
    'https://127.0.0.1/a.png',
    'https://10.0.0.5/a.png',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/a.png',
    'https://localhost/a.png',
  ])('refuses private destination %s', async (url) => {
    const result = await fetchRemoteImage(url)
    expect(result).toMatchObject({ ok: false, code: 'blocked_url' })
    expect(requestExternalUrl).not.toHaveBeenCalled()
  })

  it('refuses hosts that resolve to private addresses', async () => {
    lookup.mockResolvedValue([{ address: '192.168.0.10', family: 4 }])
    const result = await fetchRemoteImage('https://intranet.example.com/a.png')
    expect(result).toMatchObject({ ok: false, code: 'blocked_url' })
    expect(requestExternalUrl).not.toHaveBeenCalled()
  })

  it('refuses redirects to private addresses and to http', async () => {
    requestExternalUrl.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://10.1.1.1/a.png' },
      }),
    )
    await expect(
      fetchRemoteImage('https://example.com/a.png'),
    ).resolves.toMatchObject({ ok: false, code: 'blocked_url' })

    requestExternalUrl.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://example.com/a.png' },
      }),
    )
    await expect(
      fetchRemoteImage('https://example.com/a.png'),
    ).resolves.toMatchObject({ ok: false, code: 'not_https' })
    expect(requestExternalUrl).toHaveBeenCalledTimes(2)
  })

  it('applies the allowlist to the first URL and to redirects', async () => {
    const policy = { allowedHosts: ['example.com'] }
    await expect(
      fetchRemoteImage('https://other.org/a.png', { policy }),
    ).resolves.toMatchObject({ ok: false, code: 'host_not_allowed' })
    expect(requestExternalUrl).not.toHaveBeenCalled()

    requestExternalUrl.mockResolvedValueOnce(
      new Response(null, {
        status: 301,
        headers: { location: 'https://other.org/a.png' },
      }),
    )
    await expect(
      fetchRemoteImage('https://cdn.example.com/a.png', { policy }),
    ).resolves.toMatchObject({ ok: false, code: 'host_not_allowed' })

    requestExternalUrl.mockResolvedValueOnce(imageResponse(PNG))
    await expect(
      fetchRemoteImage('https://cdn.example.com/a.png', { policy }),
    ).resolves.toMatchObject({ ok: true })
  })

  it('rejects SVG and HTML whatever the Content-Type says', async () => {
    requestExternalUrl.mockResolvedValueOnce(
      imageResponse('<svg xmlns="http://www.w3.org/2000/svg"/>', {
        headers: { 'content-type': 'image/svg+xml' },
      }),
    )
    await expect(
      fetchRemoteImage('https://example.com/a.svg'),
    ).resolves.toMatchObject({ ok: false, code: 'not_image' })

    requestExternalUrl.mockResolvedValueOnce(
      imageResponse('<html>Not found</html>', {
        headers: { 'content-type': 'image/jpeg' },
      }),
    )
    await expect(
      fetchRemoteImage('https://example.com/a.jpg'),
    ).resolves.toMatchObject({ ok: false, code: 'not_image' })
  })

  it('rejects HTTP errors and oversized bodies', async () => {
    requestExternalUrl.mockResolvedValueOnce(
      imageResponse(PNG, { status: 404 }),
    )
    await expect(
      fetchRemoteImage('https://example.com/a.png'),
    ).resolves.toMatchObject({ ok: false, code: 'http' })

    requestExternalUrl.mockResolvedValueOnce(
      imageResponse(PNG, { headers: { 'content-length': '999999999' } }),
    )
    await expect(
      fetchRemoteImage('https://example.com/a.png'),
    ).resolves.toMatchObject({ ok: false, code: 'too_large' })

    // No Content-Length: the streamed body is capped.
    requestExternalUrl.mockResolvedValueOnce(
      imageResponse(Buffer.concat([PNG, Buffer.alloc(64)])),
    )
    await expect(
      fetchRemoteImage('https://example.com/a.png', { maxBytes: 32 }),
    ).resolves.toMatchObject({ ok: false, code: 'too_large' })
  })

  it('times out slow downloads', async () => {
    requestExternalUrl.mockImplementation(
      (_url: URL, _address: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          )
        }),
    )
    await expect(
      fetchRemoteImage('https://example.com/a.png', { timeoutMs: 20 }),
    ).resolves.toMatchObject({ ok: false, code: 'timeout' })
  })
})

describe('mapWithConcurrency', () => {
  it('keeps order and limits calls in flight', async () => {
    let active = 0
    let peak = 0
    const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return n * 2
    })
    expect(result).toEqual([2, 4, 6, 8, 10])
    expect(peak).toBe(2)
  })
})
