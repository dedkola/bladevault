import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'
import { getLocalDb } from '@/lib/local-db'
import { scrapedProductToKnifeDraft } from '@/lib/batch-scrape'
import * as scrapeRoute from '@/app/api/scrape/route'
import * as interactiveRoute from '@/app/api/scrape/interactive/[id]/scrape/route'
import * as knivesRoute from '@/app/api/knives/route'

const html = readFileSync(
  new URL(
    '../fixtures/scrape/vosteed-cheesepirates-a2932.html',
    import.meta.url,
  ),
  'utf8',
)
const url =
  'https://www.vosteed.com/collections/cheesepirates/products/cheesepirates-a2932'
const { rendered } = vi.hoisted(() => ({ rendered: vi.fn() }))
vi.mock('@/lib/scrape-playwright', () => ({ fetchRenderedHtml: rendered }))
vi.mock('@/lib/scrape-interactive', () => ({
  captureInteractiveSession: rendered,
}))
vi.mock('@/lib/url-validation', async (original) => ({
  ...(await original<typeof import('@/lib/url-validation')>()),
  validateExternalUrl: async (target: string) => ({
    ok: true,
    url: new URL(target),
  }),
}))
let vault: TempVault | null = null

afterEach(async () => {
  vi.unstubAllGlobals()
  await vault?.cleanup()
  vault = null
})

it.each(['automatic', 'interactive'])(
  'keeps source conflicts visible through the %s API and persistence',
  async (mode) => {
    vault = await createTempVault()
    rendered.mockResolvedValue({ html, finalUrl: url })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 404 })),
    )
    const request = new Request('http://localhost/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
    const response =
      mode === 'automatic'
        ? await scrapeRoute.POST(request)
        : await interactiveRoute.POST(request, {
            params: Promise.resolve({ id: 'test-session' }),
          })
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.warnings).toEqual([
      expect.stringContaining('conflicting handle length'),
    ])
    expect(payload.confidence.specs.handleLength).toBe(false)
    expect(payload.product.specs.modelNumber).toBe('A2932')
    expect(payload.product.bladeStyle).toBe('Drop Point')
    const draft = scrapedProductToKnifeDraft(payload.product, url)
    const saved = await knivesRoute.POST(
      new Request('http://localhost/api/knives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      }),
    )
    expect(saved.status).toBe(200)
    const { knife } = await saved.json()
    const row = getLocalDb()
      .prepare('SELECT specs, blade_style, source_url FROM knives WHERE id = ?')
      .get(knife.id) as {
      specs: string
      blade_style: string
      source_url: string
    }
    expect(JSON.parse(row.specs)).toMatchObject({
      handleLength: '',
      modelNumber: 'A2932',
      bladeMaterial: '14C28N',
      price: '69.00 USD',
    })
    expect(row.blade_style).toBe('Drop Point')
    expect(row.source_url).toBe(url)
  },
)
