import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { scrapeProduct } from '@/lib/scrape'

const beskar = readFileSync(
  new URL('../fixtures/scrape/kershaw-beskar-1439.html', import.meta.url),
  'utf8',
)

describe('Kershaw product scraping', () => {
  it('keeps the Beskar gallery free of recommended knives and the video poster', () => {
    const { product } = scrapeProduct(
      beskar,
      'https://kershaw.kaiusa.com/beskar.html',
    )

    expect(product.name).toBe('Beskar')
    expect(product.brand).toBe('Kershaw')
    expect(product.images).toEqual([
      'https://kershaw.kaiusa.com/media/catalog/product/1/4/1439_profile_web.png',
      'https://kershaw.kaiusa.com/media/catalog/product/1/4/1439_back-open_web.png',
      'https://kershaw.kaiusa.com/media/catalog/product/1/4/1439_back-closed_web.png',
    ])
    expect(product.description).toMatch(
      /^The Beskar brings something different/,
    )
    expect(product.specs).toMatchObject({
      modelNumber: '1439',
      bladeMaterial: 'D2',
      bladeLength: '3.35 in. (8.5 cm)',
      overallLength: '8.07 in. (20.5 cm)',
      lockingMechanism: 'DuraLock',
      designer: 'Kershaw Originals',
    })
    expect(product.bladeStyle).toBe('Trailing Point')
  })
})
