import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'
import { scrapedProductToKnifeDraft } from '@/lib/batch-scrape'
import * as scrapeRoute from '@/app/api/scrape/route'
import * as interactiveRoute from '@/app/api/scrape/interactive/[id]/scrape/route'
import * as knivesRoute from '@/app/api/knives/route'

const url = 'https://poikiloblade.com/shop/product/228?cateId=35,81,96'
const image =
  'https://img.poikiloblade.cn/attach/2026/10/3bd30202610180740072102.png?region_country=US'
const html = `<div class="product-detail">
  <div class="image-gallery"><img src="${image}"><img src="${image}"></div>
  <div class="product-info"><h1>TASK-DENZOKU STD DSW</h1></div>
</div>`
const bytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1kAAAAASUVORK5CYII=',
  'base64',
)
const { rendered } = vi.hoisted(() => ({ rendered: vi.fn() }))
vi.mock('@/lib/scrape-playwright', () => ({ fetchRenderedHtml: rendered }))
vi.mock('@/lib/scrape-interactive', () => ({
  captureInteractiveSession: rendered,
}))
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]),
}))
let vault: TempVault | null = null

afterEach(async () => {
  vi.unstubAllGlobals()
  await vault?.cleanup()
  vault = null
})

it.each(['automatic', 'interactive'])(
  'saves Poikilo photos from the %s scrape without downloading the protected URLs again',
  async (mode) => {
    vault = await createTempVault()
    rendered.mockResolvedValue({ html, finalUrl: url })
    const fetch = vi
      .fn()
      .mockImplementation(
        async () =>
          new Response(bytes, { headers: { 'Content-Type': 'image/png' } }),
      )
    vi.stubGlobal('fetch', fetch)
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
    expect(payload.product.images).toEqual([
      `data:image/png;base64,${bytes.toString('base64')}`,
    ])
    expect(payload.html).toContain('src="data:image/png;base64,')
    expect(payload.warnings).toBeUndefined()

    const draft = scrapedProductToKnifeDraft(payload.product, url)
    const saved = await knivesRoute.POST(
      new Request('http://localhost/api/knives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, imageUrls: draft.images }),
      }),
    )
    expect(saved.status).toBe(200)
    const { knife } = await saved.json()
    expect(knife.images).toEqual(['task-denzoku-std-dsw/image-01.png'])
    expect(
      await readFile(path.join(vault.dataDir, 'images', knife.images[0])),
    ).toEqual(bytes)
    expect(fetch).toHaveBeenCalledTimes(1)
  },
)
