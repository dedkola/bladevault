// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddKnifeForm } from '@/components/add-knife-form'
import { EMPTY_KNIFE_FORM, KnifeScrapeEditor } from '@/components/knife-form'

const { addKnife } = vi.hoisted(() => ({ addKnife: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}))
vi.mock('@/components/providers/knives-provider', () => ({
  useKnives: () => ({
    addKnife,
    knives: [],
    isLoading: false,
    dimensionUnit: 'both',
  }),
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
let sourceWarnings: string[] = []

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
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
    sourceWarnings = []
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
          return json({
            product,
            html,
            finalUrl: product.sourceUrl,
            warnings: sourceWarnings,
          })
        }
        throw new Error(`Unexpected fetch: ${url}`)
      }),
    )
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
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

  it('separates imported units in the form and saves the original measurement', async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation((input, init) =>
      String(input) === '/api/scrape'
        ? Promise.resolve(
            json({
              product: {
                ...product,
                specs: {
                  ...product.specs,
                  bladeLength: "3.52''/89.4mm",
                  overallLength: '203.2 mm',
                  weight: '5.04oz / 142.8g',
                },
              },
              html,
            }),
          )
        : originalFetch(input, init),
    )
    const user = await scrape()
    expect(
      screen.getByRole('textbox', { name: 'Blade Length (in)' }),
    ).toHaveValue('3.52')
    expect(
      screen.getByRole('textbox', { name: 'Blade Length (mm)' }),
    ).toHaveValue('89.4')
    expect(
      screen.getByRole('textbox', { name: 'Overall Length (in)' }),
    ).toHaveValue('8')
    expect(screen.getByRole('textbox', { name: 'Weight (g)' })).toHaveValue(
      '142.8',
    )
    expect(screen.getByRole('textbox', { name: 'Weight (oz)' })).toHaveValue(
      '5.04',
    )
    await user.click(screen.getByRole('button', { name: 'Save Item' }))
    await waitFor(() =>
      expect(addKnife).toHaveBeenCalledWith(
        expect.objectContaining({
          specs: expect.objectContaining({
            bladeLength: "3.52''/89.4mm",
            overallLength: '203.2 mm',
            weight: '5.04oz / 142.8g',
          }),
        }),
      ),
    )
  })

  it('preserves a saved dimension during scrape enrichment and saves edits from mm', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <KnifeScrapeEditor
        initialData={{
          ...EMPTY_KNIFE_FORM,
          name: 'My knife',
          bladeLength: '3.5 in',
          weight: '2.53 oz / 71.8 g',
          sourceUrl: product.sourceUrl,
        }}
        mode="edit"
        title="Edit knife"
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Scrape' }))
    await screen.findByTitle('Scraped page preview')
    expect(screen.getByRole('textbox', { name: 'Weight (g)' })).toHaveValue(
      '71.8',
    )
    expect(
      screen.getByRole('textbox', { name: 'Blade Length (mm)' }),
    ).toHaveValue('88.9')
    const mm = screen.getByRole('textbox', { name: 'Blade Length (mm)' })
    await user.clear(mm)
    await user.type(mm, '101.6')
    expect(
      screen.getByRole('textbox', { name: 'Blade Length (in)' }),
    ).toHaveValue('4')
    const grams = screen.getByRole('textbox', { name: 'Weight (g)' })
    await user.clear(grams)
    await user.type(grams, '100.000')
    expect(screen.getByRole('textbox', { name: 'Weight (oz)' })).toHaveValue(
      '3.5274',
    )
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          bladeLength: '101.6 mm',
          weight: '100.000 g',
        }),
        expect.any(Set),
      ),
    )
  })

  it.each(['request', 'response body'])(
    'times out a stuck %s, ignores a late result, and allows another scrape',
    async (stage) => {
      vi.useFakeTimers()
      const originalFetch = vi.mocked(fetch).getMockImplementation()!
      let finish!: (value: Response) => void
      const pending = new Promise<Response>((resolve) => {
        finish = resolve
      })
      vi.mocked(fetch).mockImplementation((input, init) => {
        if (String(input) === '/api/scrape') {
          return stage === 'request'
            ? pending
            : Promise.resolve({
                ok: true,
                status: 200,
                text: () => new Promise<string>(() => {}),
              } as Response)
        }
        return originalFetch(input, init)
      })
      render(<AddKnifeForm />)
      fireEvent.change(screen.getByRole('textbox', { name: 'Product URL' }), {
        target: { value: product.sourceUrl },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Scrape' }))
      expect(
        screen.getByRole('textbox', { name: 'Product URL' }),
      ).toBeDisabled()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60001)
      })
      expect(screen.getByRole('alert')).toHaveTextContent(
        /took longer than 60 seconds/i,
      )
      expect(screen.getByRole('button', { name: 'Scrape' })).toBeEnabled()

      await act(async () => {
        finish(json({ product: { ...product, name: 'Late result' } }))
      })
      expect(screen.queryByDisplayValue('Late result')).not.toBeInTheDocument()
      vi.mocked(fetch).mockImplementation(originalFetch)
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Scrape' }))
      })
      expect(screen.getByRole('textbox', { name: 'Model Name' })).toHaveValue(
        'Native Chief',
      )
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    },
  )

  it('shows a network error and resets the automatic scrape controls', async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation((input, init) =>
      String(input) === '/api/scrape'
        ? Promise.reject(new TypeError('Failed to fetch'))
        : originalFetch(input, init),
    )
    const user = userEvent.setup()
    render(<AddKnifeForm />)
    await user.type(
      screen.getByRole('textbox', { name: 'Product URL' }),
      product.sourceUrl,
    )
    await user.click(screen.getByRole('button', { name: 'Scrape' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /network|connection|connect/i,
    )
    expect(screen.getByRole('button', { name: 'Scrape' })).toBeEnabled()
    expect(
      screen.getByRole('button', { name: 'Interact with page' }),
    ).toBeEnabled()
  })

  it('reports malformed successful responses without exposing a technical exception', async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation((input, init) =>
      String(input) === '/api/scrape'
        ? Promise.resolve(json({ product: null }))
        : originalFetch(input, init),
    )
    const user = userEvent.setup()
    render(<AddKnifeForm />)
    await user.type(
      screen.getByRole('textbox', { name: 'Product URL' }),
      product.sourceUrl,
    )
    await user.click(screen.getByRole('button', { name: 'Scrape' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /invalid server response/i,
    )
    expect(screen.getByRole('button', { name: 'Scrape' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Save Item' })).toBeDisabled()
    expect(screen.queryByTitle('Scraped page preview')).not.toBeInTheDocument()
  })

  it.each(['start', 'scrape'])(
    'unlocks the form when interactive %s times out',
    async (stage) => {
      vi.useFakeTimers()
      const originalFetch = vi.mocked(fetch).getMockImplementation()!
      vi.mocked(fetch).mockImplementation((input, init) =>
        String(input) ===
        `/api/scrape/interactive/${stage === 'start' ? 'start' : 'session-1/scrape'}`
          ? new Promise<Response>(() => {})
          : originalFetch(input, init),
      )
      render(<AddKnifeForm />)
      fireEvent.change(screen.getByRole('textbox', { name: 'Product URL' }), {
        target: { value: product.sourceUrl },
      })
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: 'Interact with page' }),
        )
      })
      if (stage === 'scrape') {
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60001)
      })
      expect(screen.getByRole('alert')).toHaveTextContent(
        /took longer than 60 seconds/i,
      )
      expect(
        screen.queryByRole('button', { name: 'Continue' }),
      ).not.toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'Interact with page' }),
      ).toBeEnabled()
      expect(screen.getByRole('textbox', { name: 'Product URL' })).toBeEnabled()
    },
  )

  it('keeps an unsolved CAPTCHA session available for Continue', async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    let challenge = true
    vi.mocked(fetch).mockImplementation((input, init) =>
      String(input).endsWith('/session-1/scrape') && challenge
        ? Promise.resolve(
            json(
              {
                code: 'challenge',
                error:
                  'Complete verification in the browser, then click Continue.',
              },
              409,
            ),
          )
        : originalFetch(input, init),
    )
    const user = userEvent.setup()
    render(<AddKnifeForm />)
    await user.type(
      screen.getByRole('textbox', { name: 'Product URL' }),
      product.sourceUrl,
    )
    await user.click(screen.getByRole('button', { name: 'Interact with page' }))
    await user.click(await screen.findByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Complete verification/,
    )
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
    expect(screen.getByRole('textbox', { name: 'Product URL' })).toBeDisabled()
    challenge = false
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByDisplayValue('Native Chief')
    expect(
      screen.queryByRole('button', { name: 'Continue' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reports expired browser sessions and unlocks the form', async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation((input, init) =>
      String(input).endsWith('/status')
        ? Promise.resolve(
            json({
              status: 'expired',
              error:
                'Verification session expired. Open the interactive browser again.',
            }),
          )
        : originalFetch(input, init),
    )
    const user = userEvent.setup()
    render(<AddKnifeForm />)
    await user.type(
      screen.getByRole('textbox', { name: 'Product URL' }),
      product.sourceUrl,
    )
    await user.click(screen.getByRole('button', { name: 'Interact with page' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /session expired/i,
    )
    expect(
      screen.getByRole('button', { name: 'Interact with page' }),
    ).toBeEnabled()
    expect(
      screen.queryByRole('button', { name: 'Continue' }),
    ).not.toBeInTheDocument()
  })

  it('bounds status checks without overlap and unlocks after a stalled check', async () => {
    vi.useFakeTimers()
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation((input, init) =>
      String(input).endsWith('/status')
        ? new Promise<Response>(() => {})
        : originalFetch(input, init),
    )
    render(<AddKnifeForm />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Product URL' }), {
      target: { value: product.sourceUrl },
    })
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Interact with page' }),
      )
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7500)
    })
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([input]) => String(input).endsWith('/status')),
    ).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2501)
    })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Interact with page' }),
    ).toBeEnabled()
    expect(
      screen.queryByRole('button', { name: 'Continue' }),
    ).not.toBeInTheDocument()
  })

  it('cancels an in-flight Continue immediately even when cleanup does not respond', async () => {
    vi.useFakeTimers()
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    let captureSignal: AbortSignal | null | undefined
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input).endsWith('/session-1/scrape')) {
        captureSignal = init?.signal
        return new Promise<Response>(() => {})
      }
      if (String(input).endsWith('/cancel'))
        return new Promise<Response>(() => {})
      return originalFetch(input, init)
    })
    render(<AddKnifeForm />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Product URL' }), {
      target: { value: product.sourceUrl },
    })
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Interact with page' }),
      )
    })
    const controls = screen.getByRole('button', {
      name: 'Continue',
    }).parentElement!
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    })
    fireEvent.click(within(controls).getByRole('button', { name: 'Cancel' }))
    expect(captureSignal?.aborted).toBe(true)
    expect(
      screen.getByRole('button', { name: 'Interact with page' }),
    ).toBeEnabled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10001)
    })
    expect(screen.getByRole('alert')).toHaveTextContent(
      /browser could not be closed/i,
    )
  })

  it.each(['automatic', 'interactive'])(
    'aborts a pending %s request when the form unmounts',
    async (mode) => {
      const originalFetch = vi.mocked(fetch).getMockImplementation()!
      let requestSignal: AbortSignal | null | undefined
      vi.mocked(fetch).mockImplementation((input, init) => {
        if (
          String(input) === '/api/scrape' ||
          String(input).endsWith('/start')
        ) {
          requestSignal = init?.signal
          return new Promise<Response>(() => {})
        }
        return originalFetch(input, init)
      })
      const user = userEvent.setup()
      const { unmount } = render(<AddKnifeForm />)
      await user.type(
        screen.getByRole('textbox', { name: 'Product URL' }),
        product.sourceUrl,
      )
      await user.click(
        screen.getByRole('button', {
          name: mode === 'automatic' ? 'Scrape' : 'Interact with page',
        }),
      )
      unmount()
      expect(requestSignal?.aborted).toBe(true)
    },
  )

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

  it('shows source warnings after automatic and interactive import and clears them on the next scrape', async () => {
    sourceWarnings = [
      'Vosteed lists conflicting handle length values. This field was left empty.',
    ]
    const user = await scrape()
    expect(screen.getByText(sourceWarnings[0])).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Interact with page' }))
    await screen.findByRole('button', { name: 'Continue' })
    sourceWarnings = [
      'Vosteed lists conflicting weight values. This field was left empty.',
    ]
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByText(sourceWarnings[0])
    expect(
      screen.queryByText(/conflicting handle length/),
    ).not.toBeInTheDocument()
    sourceWarnings = []
    await user.click(screen.getByRole('button', { name: 'Scrape' }))
    await waitFor(() =>
      expect(screen.queryByText(/conflicting weight/)).not.toBeInTheDocument(),
    )
  })

  it('resizes the edit preview and preserves the split, edits, and selected images when reopened', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(
      <KnifeScrapeEditor
        initialData={{
          ...EMPTY_KNIFE_FORM,
          name: 'My knife',
          images: product.images,
          sourceUrl: product.sourceUrl,
        }}
        mode="edit"
        title="Edit knife"
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Scrape' }))
    const divider = await screen.findByRole('separator', {
      name: 'Knife form width',
    })
    expect(divider).toHaveAttribute('aria-valuenow', '25')
    divider.focus()
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}')
    expect(divider).toHaveAttribute('aria-valuenow', '35')

    const name = screen.getByRole('textbox', { name: 'Model Name' })
    await user.clear(name)
    await user.type(name, 'My edited knife')
    await user.click(screen.getByRole('button', { name: 'Deselect all' }))
    expect(screen.getByTitle('Scraped page preview')).toHaveAttribute(
      'sandbox',
      '',
    )
    await user.click(screen.getByRole('button', { name: 'Hide preview' }))
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Scraped page preview')).not.toBeInTheDocument()
    expect(name).toHaveValue('My edited knife')
    await user.click(screen.getByRole('button', { name: 'Show preview' }))
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '35')
    expect(screen.getByRole('textbox', { name: 'Model Name' })).toBe(name)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Hide preview' }),
      ).toHaveFocus(),
    )

    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'My edited knife' }),
      new Set(),
    )
  })

  it('shows source warnings when refreshing an existing knife', async () => {
    sourceWarnings = [
      'Vosteed lists conflicting handle length values. This field was left empty.',
    ]
    const user = userEvent.setup()
    render(
      <KnifeScrapeEditor
        initialData={{
          ...EMPTY_KNIFE_FORM,
          name: 'My knife',
          sourceUrl: product.sourceUrl,
        }}
        mode="edit"
        title="Edit knife"
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Scrape' }))
    await screen.findByText(sourceWarnings[0])
    expect(screen.getByRole('textbox', { name: 'Model Name' })).toHaveValue(
      'My knife',
    )
  })

  it('times out an edit scrape without changing the record and permits retry', async () => {
    vi.useFakeTimers()
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation((input, init) =>
      String(input) === '/api/scrape'
        ? new Promise<Response>(() => {})
        : originalFetch(input, init),
    )
    render(
      <KnifeScrapeEditor
        initialData={{
          ...EMPTY_KNIFE_FORM,
          name: 'My knife',
          sourceUrl: product.sourceUrl,
        }}
        mode="edit"
        title="Edit knife"
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Scrape' }))
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Product URL' }), {
        key: 'Enter',
      })
    })
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([input]) => String(input) === '/api/scrape'),
    ).toHaveLength(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60001)
    })
    expect(screen.getByRole('alert')).toHaveTextContent(
      /took longer than 60 seconds/i,
    )
    expect(screen.getByRole('textbox', { name: 'Model Name' })).toHaveValue(
      'My knife',
    )
    expect(screen.getByRole('button', { name: 'Scrape' })).toBeEnabled()
    vi.mocked(fetch).mockImplementation(originalFetch)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Scrape' }))
    })
    expect(screen.getByTitle('Scraped page preview')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Model Name' })).toHaveValue(
      'My knife',
    )
  })

  it('imports a saved page file and fills the product URL from it', async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    let body: Record<string, unknown> | undefined
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input) !== '/api/scrape/saved-page')
        return originalFetch(input, init)
      body = JSON.parse(String(init?.body))
      return Promise.resolve(
        json({ product, html, finalUrl: product.sourceUrl }),
      )
    })
    const user = userEvent.setup()
    render(<AddKnifeForm />)
    const savedHtml = `<!-- saved from url=(0038)${product.sourceUrl} -->\n${html}`
    await user.click(screen.getByRole('button', { name: 'Import saved page' }))
    await user.upload(
      screen.getByLabelText('Saved product page file'),
      new File([savedHtml], 'native-chief.html', { type: 'text/html' }),
    )
    await screen.findByDisplayValue('Native Chief')
    expect(body).toEqual({ html: savedHtml, url: '', savedUrl: '' })
    expect(screen.getByRole('textbox', { name: 'Product URL' })).toHaveValue(
      product.sourceUrl,
    )
    expect(screen.getByTitle('Scraped page preview')).toBeInTheDocument()
  })

  it('shows an error for a Safari web archive without calling the server', async () => {
    // File pickers can still return files outside the accept list.
    const user = userEvent.setup({ applyAccept: false })
    render(<AddKnifeForm />)
    await user.upload(
      screen.getByLabelText('Saved product page file'),
      new File(['bplist00'], 'knife.webarchive'),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Safari web archives are not supported/,
    )
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([input]) => String(input).includes('saved-page')),
    ).toBe(false)
  })

  it('hides the BladeVault browser outside the desktop app', () => {
    render(<AddKnifeForm />)
    expect(
      screen.queryByRole('button', { name: 'Open in BladeVault browser' }),
    ).not.toBeInTheDocument()
  })

  it('imports the page captured in the BladeVault browser with its images', async () => {
    const dataUrl = 'data:image/jpeg;base64,AAAA'
    const capturedUrl = 'https://shop.example.com/native-chief?variant=1'
    const scrapeBrowser = {
      open: vi.fn().mockResolvedValue({
        status: 'captured',
        html,
        url: capturedUrl,
      }),
      capture: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined),
      fetchImages: vi.fn().mockResolvedValue([dataUrl]),
    }
    vi.stubGlobal('bladevaultDesktop', { scrapeBrowser })
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    let body: Record<string, unknown> | undefined
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input) !== '/api/scrape/saved-page')
        return originalFetch(input, init)
      body = JSON.parse(String(init?.body))
      return Promise.resolve(json({ product: { ...product }, html }))
    })
    const user = userEvent.setup()
    render(<AddKnifeForm />)
    await user.type(
      screen.getByRole('textbox', { name: 'Product URL' }),
      product.sourceUrl,
    )
    await user.click(
      screen.getByRole('button', { name: 'Open in BladeVault browser' }),
    )
    await screen.findByDisplayValue('Native Chief')
    expect(scrapeBrowser.open).toHaveBeenCalledWith(product.sourceUrl)
    expect(body).toEqual({
      html,
      url: capturedUrl,
      savedUrl: '',
      source: 'browser',
    })
    expect(scrapeBrowser.fetchImages).toHaveBeenCalledWith(product.images)
    expect(document.querySelector(`img[src="${dataUrl}"]`)).toBeInTheDocument()
  })
})
