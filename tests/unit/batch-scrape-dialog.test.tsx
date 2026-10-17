// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BatchScrapeDialog } from '@/components/batch-scrape-dialog'
import { KnivesProvider } from '@/components/providers/knives-provider'
import { toKnifeListItem, type Knife } from '@/lib/data'
import { createKnife } from '@/tests/fixtures/knife'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function scrapedProduct(name: string) {
  return {
    name,
    brand: 'Benchmade',
    description: 'Lightweight EDC.',
    images: ['https://cdn.example.com/knife.jpg'],
    bladeStyle: 'Drop Point',
    handleMaterial: 'Grivory',
    specs: {
      weight: '',
      overallLength: '',
      bladeLength: '',
      bladeThickness: '',
      bladeCoating: '',
      bladeMaterial: '',
      lockingMechanism: '',
      designer: '',
      modelNumber: '',
      handleLength: '',
      hardness: '',
      price: '',
      country: '',
    },
    sourceUrl: '',
  }
}

const PRODUCT_NAMES: Record<string, string> = {
  'https://a.com/one': 'Knife One',
  'https://b.com/two': 'Knife Two',
}

let calls: string[] = []
let inFlight = 0
let maxInFlight = 0
const writeText = vi.fn(async () => {})

async function track(label: string) {
  inFlight += 1
  maxInFlight = Math.max(maxInFlight, inFlight)
  calls.push(label)
  await new Promise((resolve) => setTimeout(resolve, 5))
  inFlight -= 1
}

function installFetch({
  failing = [],
  onScrape = async () => {},
  knives = [],
  warnings = [],
}: {
  failing?: string[]
  onScrape?: (target: string) => Promise<void>
  knives?: Knife[]
  warnings?: string[]
} = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'

      if (url === '/api/settings') {
        return jsonResponse({ settings: { customFields: [] } })
      }
      if (url === '/api/knives' && method === 'GET') {
        return jsonResponse({ knives: knives.map(toKnifeListItem) })
      }
      if (url === '/api/compare' && method === 'GET') {
        return jsonResponse({ compareIds: [] })
      }
      if (url === '/api/scrape' && method === 'POST') {
        const { url: target } = JSON.parse(String(init?.body)) as {
          url: string
        }
        await track(`scrape:${target}`)
        await onScrape(target)
        if (failing.includes(target)) {
          return jsonResponse(
            {
              error:
                'This retailer is showing a security verification page (bot protection).',
            },
            500,
          )
        }
        return jsonResponse({
          product: scrapedProduct(PRODUCT_NAMES[target] ?? target),
          finalUrl: target,
          warnings,
        })
      }
      if (url === '/api/knives' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { name: string }
        await track(`save:${body.name}`)
        return jsonResponse({
          knife: {
            ...body,
            id: body.name,
            addedAt: '2026-10-15T00:00:00.000Z',
            updatedAt: '2026-10-15T00:00:00.000Z',
          },
        })
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`)
    }),
  )
}

async function renderDialog(onOpenChange: (open: boolean) => void = () => {}) {
  const view = render(
    <KnivesProvider>
      <BatchScrapeDialog open onOpenChange={onOpenChange} />
    </KnivesProvider>,
  )

  const textarea = await screen.findByRole('textbox', {
    name: 'Product links',
  })
  return { textarea, unmount: view.unmount }
}

describe('BatchScrapeDialog', () => {
  beforeEach(() => {
    calls = []
    inFlight = 0
    maxInFlight = 0
    writeText.mockClear()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    delete (navigator as { clipboard?: unknown }).clipboard
  })

  it('displays source warnings beside the saved item', async () => {
    const warning =
      'Vosteed lists conflicting handle length values. This field was left empty.'
    installFetch({ warnings: [warning] })
    const user = userEvent.setup()
    const { textarea } = await renderDialog()
    await user.type(textarea, 'https://a.com/one')
    await user.click(screen.getByRole('button', { name: 'Start batch' }))
    await screen.findByText(/1 of 1 handled · 1 added/)
    expect(screen.getByText(warning)).toBeInTheDocument()
  })

  it('shows existing links as skipped without scraping or saving them, including on repeat runs', async () => {
    const existing = createKnife({
      sourceUrl: ' HTTPS://A.COM:443/one/#details ',
      name: 'My edited knife',
      description: 'Keep my notes',
    })
    const before = structuredClone(existing)
    installFetch({ knives: [existing] })
    const user = userEvent.setup()
    const { textarea } = await renderDialog()

    await user.type(textarea, 'https://a.com/one\nhttps://b.com/two')
    await user.click(screen.getByRole('button', { name: 'Start batch' }))
    await screen.findByText(/2 of 2 handled · 1 added · 1 skipped/)
    expect(screen.getByText('Skipped')).toBeInTheDocument()
    expect(
      screen.getByText('Already saved in the collection'),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Retry failed' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '2')
    expect(calls).toEqual(['scrape:https://b.com/two', 'save:Knife Two'])

    await user.click(screen.getByRole('button', { name: 'Import again' }))
    await screen.findByText(/2 of 2 handled · 0 added · 2 skipped/)
    expect(calls).toEqual(['scrape:https://b.com/two', 'save:Knife Two'])
    expect(existing).toEqual(before)
  })

  it('imports pasted links one at a time and never in parallel', async () => {
    installFetch()
    const user = userEvent.setup()
    const { textarea } = await renderDialog()

    await user.type(textarea, 'https://a.com/one\nhttps://b.com/two')
    expect(screen.getByText(/2 links ready/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Start batch' }))

    await waitFor(() =>
      expect(screen.getByText(/2 of 2 handled/)).toBeInTheDocument(),
    )

    expect(calls).toEqual([
      'scrape:https://a.com/one',
      'save:Knife One',
      'scrape:https://b.com/two',
      'save:Knife Two',
    ])
    expect(maxInFlight).toBe(1)
    expect(screen.getByText(/2 added/)).toBeInTheDocument()
  })

  it('lists failed links and keeps importing the rest', async () => {
    installFetch({ failing: ['https://a.com/one'] })
    const user = userEvent.setup()
    const clipboardWrite = vi.spyOn(navigator.clipboard, 'writeText')
    const { textarea } = await renderDialog()

    await user.type(textarea, 'https://a.com/one https://b.com/two')
    await user.click(screen.getByRole('button', { name: 'Start batch' }))

    await waitFor(() =>
      expect(screen.getByText(/2 of 2 handled/)).toBeInTheDocument(),
    )

    expect(calls).toEqual([
      'scrape:https://a.com/one',
      'scrape:https://b.com/two',
      'save:Knife Two',
    ])
    expect(screen.getByText('1 link was not added.')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Retry failed' }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Copy failed links' }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Copied' }),
      ).toBeInTheDocument(),
    )
    expect(clipboardWrite).toHaveBeenCalledWith('https://a.com/one')
  })

  it('resumes only waiting links after stopping, without duplicating saved knives', async () => {
    let finishScrape!: () => void
    const firstScrape = new Promise<void>((resolve) => {
      finishScrape = resolve
    })
    installFetch({
      onScrape: async (url) => {
        if (url === 'https://a.com/one') await firstScrape
      },
    })
    const user = userEvent.setup()
    const { textarea } = await renderDialog()
    await user.type(textarea, 'https://a.com/one\nhttps://b.com/two')
    await user.click(screen.getByRole('button', { name: 'Start batch' }))
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    finishScrape()

    await waitFor(() =>
      expect(screen.getByText(/1 of 2 handled/)).toBeInTheDocument(),
    )
    expect(calls).toEqual(['scrape:https://a.com/one', 'save:Knife One'])
    await user.click(screen.getByRole('button', { name: 'Resume batch' }))
    await waitFor(() =>
      expect(screen.getByText(/2 of 2 handled/)).toBeInTheDocument(),
    )
    expect(calls).toEqual([
      'scrape:https://a.com/one',
      'save:Knife One',
      'scrape:https://b.com/two',
      'save:Knife Two',
    ])
  })

  it('retries only failed links and keeps previously saved results', async () => {
    const failing = ['https://a.com/one']
    installFetch({ failing })
    const user = userEvent.setup()
    const { textarea } = await renderDialog()
    await user.type(textarea, 'https://a.com/one\nhttps://b.com/two')
    await user.click(screen.getByRole('button', { name: 'Start batch' }))
    await screen.findByText('1 link was not added.')
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Retry failed' }),
      ).toBeEnabled(),
    )
    failing.length = 0

    await user.click(screen.getByRole('button', { name: 'Retry failed' }))
    await waitFor(() => expect(screen.getByText(/2 added/)).toBeInTheDocument())
    expect(calls).toEqual([
      'scrape:https://a.com/one',
      'scrape:https://b.com/two',
      'save:Knife Two',
      'scrape:https://a.com/one',
      'save:Knife One',
    ])
  })

  it('prevents dismissal during a run and allows closing when it completes', async () => {
    let finishScrape!: () => void
    installFetch({
      onScrape: () =>
        new Promise<void>((resolve) => {
          finishScrape = resolve
        }),
    })
    const onOpenChange = vi.fn()
    const user = userEvent.setup()
    const { textarea } = await renderDialog(onOpenChange)
    await user.type(textarea, 'https://a.com/one')
    await user.click(screen.getByRole('button', { name: 'Start batch' }))
    await waitFor(() => expect(finishScrape).toBeDefined())
    await user.keyboard('{Escape}')
    expect(onOpenChange).not.toHaveBeenCalled()
    finishScrape()
    await screen.findByText(/1 of 1 handled/)
    await user.click(screen.getAllByRole('button', { name: 'Close' })[0])
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('does not start another link after the Add page unmounts', async () => {
    let finishScrape!: () => void
    installFetch({
      onScrape: () =>
        new Promise<void>((resolve) => {
          finishScrape = resolve
        }),
    })
    const user = userEvent.setup()
    const { textarea, unmount } = await renderDialog()
    await user.type(textarea, 'https://a.com/one\nhttps://b.com/two')
    await user.click(screen.getByRole('button', { name: 'Start batch' }))
    await waitFor(() => expect(finishScrape).toBeDefined())
    unmount()
    finishScrape()
    await waitFor(() => expect(calls).toContain('save:Knife One'))
    expect(calls).toEqual(['scrape:https://a.com/one', 'save:Knife One'])
  })
})
