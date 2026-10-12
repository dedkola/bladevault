// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveUnlockedDestination } from '@/components/app-unlock-form'

afterEach(() => {
  vi.useRealTimers()
})

describe('unlocked collection destination', () => {
  it('returns to Collection when the restored record no longer exists', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }))
    await expect(
      resolveUnlockedDestination(
        '/collection/deleted?edit=1#maintenance',
        fetcher,
      ),
    ).resolves.toBe('/collection')
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/knives/deleted', {
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    })
  })

  it('preserves the route, query, and fragment for an existing restored record', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }))
    const destination = '/collection/retained?edit=1#maintenance'
    await expect(
      resolveUnlockedDestination(destination, fetcher),
    ).resolves.toBe(destination)
  })

  it.each([401, 503])(
    'preserves the destination when the record check returns %s',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status }))
      await expect(
        resolveUnlockedDestination('/collection/retained', fetcher),
      ).resolves.toBe('/collection/retained')
    },
  )

  it('preserves the destination after a network failure', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(
      resolveUnlockedDestination('/collection/retained', fetcher),
    ).resolves.toBe('/collection/retained')
  })

  it('aborts a stalled record check after three seconds and preserves its route', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          )
        }),
    )
    const pending = resolveUnlockedDestination('/collection/retained', fetcher)
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(pending).resolves.toBe('/collection/retained')
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not inspect unrelated routes and still rejects external destinations', async () => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(
      resolveUnlockedDestination('/collection?sort=brand#results', fetcher),
    ).resolves.toBe('/collection?sort=brand#results')
    await expect(
      resolveUnlockedDestination('/settings?tab=cloud-backup', fetcher),
    ).resolves.toBe('/settings?tab=cloud-backup')
    await expect(
      resolveUnlockedDestination(
        'https://example.com/collection/record',
        fetcher,
      ),
    ).resolves.toBe('/')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
