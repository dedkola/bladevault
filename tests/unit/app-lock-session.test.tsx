// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AppLockSession } from '@/components/app-lock-session'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('rechecks an old locked status against the cookie issued while the request was pending', async () => {
  let finishOldRequest!: (response: Response) => void
  const oldRequest = new Promise<Response>((resolve) => {
    finishOldRequest = resolve
  })
  const fetch = vi
    .fn()
    .mockReturnValueOnce(oldRequest)
    .mockResolvedValue(
      new Response(JSON.stringify({ enabled: true, unlocked: true })),
    )
  vi.stubGlobal('fetch', fetch)
  const view = render(<AppLockSession />)
  expect(fetch).toHaveBeenCalledTimes(1)
  await act(async () => {
    finishOldRequest(
      new Response(JSON.stringify({ enabled: true, unlocked: false })),
    )
  })
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  expect(fetch).toHaveBeenLastCalledWith('/api/app-lock', { cache: 'no-store' })
  view.unmount()
  expect(window.fetch).toBe(fetch)
})
