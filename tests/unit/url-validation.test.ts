import { afterEach, describe, expect, it, vi } from 'vitest'

const lookup = vi.hoisted(() => vi.fn())

vi.mock('dns/promises', () => ({ lookup }))

import { fetchExternalUrl, validateExternalUrl } from '@/lib/url-validation'

describe('external URL validation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    lookup.mockReset()
  })

  it.each([
    'http://localhost/path',
    'http://127.0.0.1/path',
    'http://10.0.0.1/path',
    'http://169.254.1.1/path',
    'http://192.168.1.1/path',
    'http://[::1]/path',
    'http://[::ffff:127.0.0.1]/path',
    'file:///tmp/knife',
  ])('rejects unsafe destination %s', async (url) => {
    await expect(validateExternalUrl(url)).resolves.toMatchObject({ ok: false })
  })

  it('rejects a hostname when any DNS answer is private', async () => {
    lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.2', family: 4 },
    ])
    await expect(
      validateExternalUrl('https://mixed.example/knife'),
    ).resolves.toEqual({
      ok: false,
      reason: 'Private or internal URLs are not allowed',
    })
  })

  it('allows a public hostname and revalidates every redirect target', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    const validation = await validateExternalUrl('https://public.example/start')
    expect(validation.ok).toBe(true)
    if (!validation.ok) return

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'http://127.0.0.1/private' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchExternalUrl(validation.url, {})).rejects.toThrow(
      'Private or internal URLs are not allowed',
    )
    expect(fetchMock).toHaveBeenCalledWith(
      validation.url,
      expect.objectContaining({ redirect: 'manual' }),
    )
  })
})
