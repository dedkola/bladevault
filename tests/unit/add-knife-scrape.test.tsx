// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddKnifeForm } from '@/components/add-knife-form'

const { addKnife } = vi.hoisted(() => ({ addKnife: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}))
vi.mock('@/components/providers/knives-provider', () => ({
  useKnives: () => ({ addKnife, knives: [], isLoading: false }),
}))

const html = `<html><body><main><h1>Native Chief</h1><p>Blade: CTS BD1N</p></main>
  <div role="dialog" aria-modal="true">Unfamiliar promotion</div></body></html>`
const product = {
  name: 'Native Chief',
  brand: 'Spyderco',
  images: ['https://cdn.example.com/knife.jpg'],
  specs: { bladeMaterial: 'CTS BD1N' },
  sourceUrl: 'https://shop.example.com/native-chief',
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  })
}

class TestResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

describe('Add knife scrape controls', () => {
  beforeEach(() => {
    addKnife.mockReset()
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/settings')
          return json({ settings: { customFields: [] } })
        if (url.endsWith('/start')) return json({ sessionId: 'session-1' })
        if (url.endsWith('/status'))
          return json({ status: 'waiting', isSecurityChallenge: false })
        if (url.endsWith('/cancel')) return json({ ok: true })
        if (url === '/api/scrape' || url.endsWith('/scrape')) {
          return json({ product, html, finalUrl: product.sourceUrl })
        }
        throw new Error(`Unexpected fetch: ${url}`)
      }),
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  async function scrape() {
    const user = userEvent.setup()
    render(<AddKnifeForm />)
    await user.type(
      screen.getByRole('textbox', { name: 'Product URL' }),
      product.sourceUrl,
    )
    await user.click(screen.getByRole('button', { name: 'Scrape' }))
    await screen.findByDisplayValue('Native Chief')
    return user
  }

  it('hides and restores preview overlays without changing edits or enabling scripts', async () => {
    const user = await scrape()
    const divider = screen.getByRole('separator', { name: 'Knife form width' })
    expect(divider).toHaveAttribute('aria-valuenow', '25')
    divider.focus()
    await user.keyboard('{ArrowRight}')
    expect(divider).toHaveAttribute('aria-valuenow', '27')
    const name = screen.getByRole('textbox', { name: 'Model Name' })
    await user.clear(name)
    await user.type(name, 'My edited Chief')
    const frame = screen.getByTitle('Scraped page preview')
    expect(frame).toHaveAttribute(
      'srcdoc',
      expect.stringContaining('Unfamiliar promotion'),
    )
    await user.click(screen.getByRole('button', { name: 'Hide popups' }))
    expect(frame).not.toHaveAttribute(
      'srcdoc',
      expect.stringContaining('Unfamiliar promotion'),
    )
    expect(frame).toHaveAttribute('srcdoc', expect.stringContaining('CTS BD1N'))
    expect(frame).toHaveAttribute('sandbox', '')
    expect(name).toHaveValue('My edited Chief')
    await user.click(screen.getByRole('button', { name: 'Restore original' }))
    expect(frame).toHaveAttribute(
      'srcdoc',
      expect.stringContaining('Unfamiliar promotion'),
    )
    expect(name).toHaveValue('My edited Chief')
    expect(divider).toHaveAttribute('aria-valuenow', '27')
  })

  it('opens interactive mode after a successful scrape and preserves manual edits and image selection', async () => {
    const user = await scrape()
    const name = screen.getByRole('textbox', { name: 'Model Name' })
    await user.clear(name)
    await user.type(name, 'My edited Chief')
    await user.click(screen.getByRole('button', { name: 'Deselect all' }))
    await user.click(screen.getByRole('button', { name: 'Interact with page' }))
    await screen.findByText(/Close popups or complete verification/)
    expect(screen.getByRole('textbox', { name: 'Product URL' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Scrape' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Interact with page' }),
      ).toBeEnabled(),
    )
    expect(name).toHaveValue('My edited Chief')
    await user.click(screen.getByRole('button', { name: 'Save Item' }))
    expect(addKnife).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'My edited Chief', images: [] }),
    )
  })

  it('offers interactive browsing before any scrape or bot-protection error', async () => {
    const user = userEvent.setup()
    render(<AddKnifeForm />)
    const button = screen.getByRole('button', { name: 'Interact with page' })
    expect(button).toBeDisabled()
    await user.type(
      screen.getByRole('textbox', { name: 'Product URL' }),
      product.sourceUrl,
    )
    await user.click(button)
    await screen.findByRole('button', { name: 'Continue' })
    expect(fetch).toHaveBeenCalledWith(
      '/api/scrape/interactive/start',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
