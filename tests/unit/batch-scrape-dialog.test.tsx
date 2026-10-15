// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BatchScrapeDialog } from '@/components/batch-scrape-dialog'
import { KnivesProvider } from '@/components/providers/knives-provider'

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

function installFetch({ failing = [] as string[] } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'

      if (url === '/api/settings') {
        return jsonResponse({ settings: { customFields: [] } })
      }
      if (url === '/api/knives' && method === 'GET') {
        return jsonResponse({ knives: [] })
      }
      if (url === '/api/compare' && method === 'GET') {
        return jsonResponse({ compareIds: [] })
      }
      if (url === '/api/scrape' && method === 'POST') {
        const { url: target } = JSON.parse(String(init?.body)) as {
          url: string
        }
        await track(`scrape:${target}`)
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

async function renderDialog() {
  render(
    <KnivesProvider>
      <BatchScrapeDialog open onOpenChange={() => {}} />
    </KnivesProvider>,
  )

  const textarea = await screen.findByRole('textbox', {
    name: 'Product links',
  })
  return textarea
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

  it('imports pasted links one at a time and never in parallel', async () => {
    installFetch()
    const user = userEvent.setup()
    const textarea = await renderDialog()

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
    const textarea = await renderDialog()

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
})
