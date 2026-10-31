import { readFileSync } from 'node:fs'
import * as cheerio from 'cheerio'
import { describe, expect, it } from 'vitest'
import { scrapeAndEnrichProduct, scrapeProduct } from '@/lib/scrape'

const url = 'https://www.bokerusa.com/superlight-tanto-02bo099'
const html = readFileSync(
  new URL(
    '../fixtures/scrape/boker-superlight-tanto-02bo099.html',
    import.meta.url,
  ),
  'utf8',
)
const expectedImages = [
  'https://www.bokerusa.com/media/image/af/4a/4e/boker-plus-superlight-tanto-02bo099.jpg',
  'https://www.bokerusa.com/media/image/99/18/fb/boker-plus-superlight-tanto-02bo099_2.jpg',
  'https://www.bokerusa.com/media/image/7d/7c/5a/boker-plus-superlight-tanto-02bo099_3.jpg',
  'https://www.bokerusa.com/media/image/ca/94/14/boker-plus-superlight-tanto-02bo099_4.jpg',
  'https://www.bokerusa.com/media/image/04/5c/03/boker-plus-superlight-tanto-02bo099_5.jpg',
  'https://www.bokerusa.com/media/image/05/66/f0/boker-plus-superlight-tanto-02bo099_6.jpg',
  'https://www.bokerusa.com/media/image/6a/17/1b/boker-plus-superlight-tanto-02bo099_7.jpg',
]

describe('Boker product gallery scraping', () => {
  it('extracts all seven original photos from the lazy gallery without logos or placeholders', () => {
    const { product, confidence } = scrapeProduct(html, url)

    expect(product.images).toEqual(expectedImages)
    expect(confidence.images).toBe(true)
  })

  it('keeps originals after lazy images load and excludes images outside the product gallery', async () => {
    const $ = cheerio.load(html)
    $('[data-srcset]').each((_, el) => {
      const image = $(el)
      image.attr('src', image.attr('data-srcset')!.split(',')[0].trim())
      image.removeAttr('data-srcset')
    })
    $('body').append(`
      <div class="product--box"><img src="/media/image/recommended-product.jpg"></div>
      <div data-img-original="/media/image/unrelated-product.jpg"></div>
    `)

    const { product } = await scrapeAndEnrichProduct($.html(), url)

    expect(product.images).toEqual(expectedImages)
  })

  it('resolves relative original URLs and deduplicates repeated gallery entries', () => {
    const { product } = scrapeProduct(
      `<div class="product--image-container">
        <span data-img-original="/media/image/knife.jpg"><img src="/media/image/knife_600x600.jpg"></span>
        <span data-img-original="//www.bokerusa.com/media/image/knife.jpg"></span>
        <span data-img-original="/media/image/sheath.jpg"><img src="data:image/gif;base64,placeholder"></span>
      </div>`,
      url,
    )

    expect(product.images).toEqual([
      'https://www.bokerusa.com/media/image/knife.jpg',
      'https://www.bokerusa.com/media/image/sheath.jpg',
    ])
  })
})
