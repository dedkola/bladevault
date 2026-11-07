// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

const start = vi.hoisted(() => vi.fn())
vi.mock('@/lib/sentry/client', () => ({
  startBrowserErrorReporting: start,
  stopBrowserErrorReporting: vi.fn(),
}))

import { ErrorReportingPrompt } from '@/components/error-reporting-prompt'

const CONFIG = {
  dsn: 'https://default@o1.ingest.de.sentry.io/9',
  environment: 'production',
  runtime: 'docker',
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  start.mockClear()
})

function stubFetch(response: Response) {
  const fetch = vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetch)
  return fetch
}

it('starts reporting and closes after Send Reports', async () => {
  const fetch = stubFetch(
    Response.json({ mode: 'consent', consent: 'granted', config: CONFIG }),
  )
  render(<ErrorReportingPrompt />)

  expect(
    screen.getByRole('region', { name: 'Help improve BladeVault?' }),
  ).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Send Reports' }))

  expect(fetch).toHaveBeenCalledWith(
    '/api/settings/error-reporting',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ consent: 'granted' }),
    }),
  )
  expect(start).toHaveBeenCalledWith(CONFIG)
  await waitFor(() =>
    expect(screen.queryByRole('region')).not.toBeInTheDocument(),
  )
})

it('closes without starting reporting after Don’t Send', async () => {
  stubFetch(
    Response.json({ mode: 'consent', consent: 'declined', config: null }),
  )
  render(<ErrorReportingPrompt />)

  await userEvent.click(screen.getByRole('button', { name: 'Don’t Send' }))

  expect(start).not.toHaveBeenCalled()
  await waitFor(() =>
    expect(screen.queryByRole('region')).not.toBeInTheDocument(),
  )
})

it('stays open and explains when saving fails', async () => {
  stubFetch(Response.json({ error: 'busy' }, { status: 503 }))
  render(<ErrorReportingPrompt />)

  await userEvent.click(screen.getByRole('button', { name: 'Send Reports' }))

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Could not save your answer',
  )
  expect(screen.getByRole('button', { name: 'Send Reports' })).toBeEnabled()
})
