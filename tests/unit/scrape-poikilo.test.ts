import * as cheerio from 'cheerio'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scrapeAndEnrichProduct } from '@/lib/scrape'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]),
}))

const url = 'https://poikiloblade.com/shop/product/228?cateId=35,81,96'
const image =
  'https://img.poikiloblade.cn/attach/2026/10/3bd30202610180740072102.png?region_country=US'
const secondImage =
  'https://img.poikiloblade.cn/attach/2026/10/99fb4202610180740172242.png?region_country=US'
const html = `<div class="product-detail">
  <div class="image-gallery">
    <img src="${image}" alt="Product thumbnail">
    <img src="${secondImage}" alt="Product thumbnail">
    <div class="main-image"><img src="${image}" alt="Product main image"></div>
  </div>
  <div class="product-info"><h1>TASK-DENZOKU STD DSW</h1></div>
</div>`

afterEach(() => vi.unstubAllGlobals())

describe('Poikilo protected gallery images', () => {
  it('fetches each photo with the manufacturer referrer and embeds it in the picker and preview', async () => {
    // The CDN serves WebP even when the source path ends in .png.
    const fetch = vi
      .fn()
      .mockImplementation(
        async () =>
          new Response('photo', { headers: { 'Content-Type': 'image/webp' } }),
      )
    vi.stubGlobal('fetch', fetch)

    const result = await scrapeAndEnrichProduct(html, url)
    const dataUrl = `data:image/webp;base64,${Buffer.from('photo').toString('base64')}`
    expect(result.product.images).toEqual([dataUrl, dataUrl])
    expect(result.confidence.images).toBe(true)
    expect(result.warnings).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(2)
    for (const [target, options] of fetch.mock.calls) {
      expect([image, secondImage]).toContain(target.href)
      expect(options.headers.Referer).toBe('https://poikiloblade.com/')
      expect(options.redirect).toBe('manual')
    }
    const $ = cheerio.load(result.html)
    expect(
      $('.image-gallery img')
        .toArray()
        .map((el) => $(el).attr('src')),
    ).toEqual([dataUrl, dataUrl, dataUrl])
    expect(result.finalUrl).toBe(url)
    expect(result.product.sourceUrl).toBe(url)
  })

  it.each([
    [
      'HTML returned by the referrer redirect',
      () =>
        new Response('<html>Shop</html>', {
          headers: { 'Content-Type': 'text/html' },
        }),
    ],
    ['an HTTP error', () => new Response('Denied', { status: 403 })],
    [
      'an empty image',
      () => new Response('', { headers: { 'Content-Type': 'image/png' } }),
    ],
    [
      'an oversized image',
      () =>
        new Response('photo', {
          headers: {
            'Content-Type': 'image/png',
            'Content-Length': String(11 * 1024 * 1024),
          },
        }),
    ],
    [
      'a network failure',
      () => {
        throw new Error('Connection failed')
      },
    ],
    [
      'an oversized stream without Content-Length',
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(11 * 1024 * 1024))
              controller.close()
            },
          }),
          { headers: { 'Content-Type': 'image/png' } },
        ),
    ],
  ])(
    'reports %s and excludes unusable images from the import',
    async (_, response) => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(response))
      const result = await scrapeAndEnrichProduct(html, url)
      expect(result.product.images).toEqual([])
      expect(result.confidence.images).toBe(false)
      expect(result.warnings).toHaveLength(2)
      expect(result.warnings?.[0]).toMatch(
        /Poikilo image 1 could not be imported/,
      )
    },
  )

  it('keeps successful photos when another photo fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response('photo', { headers: { 'Content-Type': 'image/png' } }),
        )
        .mockRejectedValueOnce(new Error('Connection failed')),
    )
    const result = await scrapeAndEnrichProduct(html, url)
    expect(result.product.images).toEqual(['data:image/png;base64,cGhvdG8='])
    expect(result.warnings).toHaveLength(1)
  })

  it.each([
    'https://shop.example/knife',
    'https://poikiloblade.com.example/shop/product/228',
    'https://poikiloblade.com/shop',
  ])('does not embed images for other pages: %s', async (source) => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const result = await scrapeAndEnrichProduct(html, source)
    expect(fetch).not.toHaveBeenCalled()
    expect(result.html).toBe(html)
  })

  it('only fetches the exact protected image host', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const external = 'https://img.poikiloblade.cn.example/photo.png'
    const result = await scrapeAndEnrichProduct(
      html.replaceAll(image, external).replaceAll(secondImage, external),
      url,
    )
    expect(fetch).not.toHaveBeenCalled()
    expect(result.product.images).toEqual([external])
  })

  it('ignores malformed unrelated image URLs when rewriting the preview', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(
          async () =>
            new Response('photo', { headers: { 'Content-Type': 'image/png' } }),
        ),
    )
    const result = await scrapeAndEnrichProduct(
      `${html}<img src="https://[invalid">`,
      url,
    )
    expect(result.product.images).toHaveLength(2)
    expect(result.warnings).toBeUndefined()
    expect(result.html).toContain('src="https://[invalid"')
  })
})
