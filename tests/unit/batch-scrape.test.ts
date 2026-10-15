import { describe, expect, it, vi } from 'vitest'
import {
  batchImageUrls,
  createBatchItems,
  isBotProtectionMessage,
  parseBatchLinks,
  runBatchScrape,
  scrapedProductToKnifeDraft,
  type BatchScrapeItem,
} from '@/lib/batch-scrape'
import type { ScrapedProduct } from '@/lib/scrape'

function product(overrides: Partial<ScrapedProduct> = {}): ScrapedProduct {
  return {
    name: 'Bugout',
    brand: 'Benchmade',
    description: 'Lightweight EDC.',
    images: ['https://cdn.example.com/bugout.jpg'],
    bladeStyle: 'Drop Point',
    handleMaterial: 'Grivory',
    specs: {
      weight: '1.85 oz',
      overallLength: '7.46 in',
      bladeLength: '3.24 in',
      bladeThickness: '0.09 in',
      bladeCoating: '',
      bladeMaterial: 'CPM-S30V',
      lockingMechanism: 'AXIS Lock',
      designer: '',
      modelNumber: '535',
      handleLength: '4.22 in',
      hardness: '58-60 HRC',
      price: '$180',
      country: 'USA',
    },
    sourceUrl: 'https://retailer.com/bugout',
    ...overrides,
  }
}

describe('parseBatchLinks', () => {
  it('splits links on whitespace and commas, keeping the pasted order', () => {
    const parsed = parseBatchLinks(
      'https://a.com/one\nhttps://b.com/two, https://c.com/three',
    )

    expect(parsed.urls).toEqual([
      'https://a.com/one',
      'https://b.com/two',
      'https://c.com/three',
    ])
    expect(parsed.invalid).toEqual([])
    expect(parsed.duplicates).toBe(0)
  })

  it('strips wrapping punctuation from pasted links', () => {
    const parsed = parseBatchLinks(
      '<https://a.com/one>,\n"https://b.com/two".\n(https://c.com/three);',
    )

    expect(parsed.urls).toEqual([
      'https://a.com/one',
      'https://b.com/two',
      'https://c.com/three',
    ])
    expect(parsed.invalid).toEqual([])
  })

  it('drops repeats and reports what it could not read', () => {
    const parsed = parseBatchLinks(
      'https://a.com/one\nhttps://a.com/one\nnot-a-url\nftp://a.com/file\nexample.com/bare',
    )

    expect(parsed.urls).toEqual(['https://a.com/one'])
    expect(parsed.duplicates).toBe(1)
    expect(parsed.invalid).toEqual([
      'not-a-url',
      'ftp://a.com/file',
      'example.com/bare',
    ])
  })

  it('returns nothing for empty input', () => {
    expect(parseBatchLinks('   \n  ')).toEqual({
      urls: [],
      duplicates: 0,
      invalid: [],
    })
  })
})

describe('scrapedProductToKnifeDraft', () => {
  it('maps the scraped product onto a knife draft', () => {
    const draft = scrapedProductToKnifeDraft(product(), 'https://fallback.com')

    expect(draft.name).toBe('Bugout')
    expect(draft.brand).toBe('Benchmade')
    expect(draft.specs.bladeMaterial).toBe('CPM-S30V')
    expect(draft.specs.country).toBe('USA')
    expect(draft.sourceUrl).toBe('https://retailer.com/bugout')
    expect(draft.images).toEqual(['https://cdn.example.com/bugout.jpg'])
    expect(draft.pinned).toBe(false)
  })

  it('falls back to the scraped URL and keeps screenshot drafts', () => {
    const draft = scrapedProductToKnifeDraft(
      product({
        sourceUrl: '',
        images: [
          '__webpage_drafts/webpage-0f1e2d3c-4b5a-6978-8c9d-0e1f2a3b4c5d.png',
          'data:image/png;base64,AAAA',
          'javascript:alert(1)',
        ],
      }),
      'https://fallback.com',
    )

    expect(draft.sourceUrl).toBe('https://fallback.com')
    expect(draft.images).toEqual([
      '__webpage_drafts/webpage-0f1e2d3c-4b5a-6978-8c9d-0e1f2a3b4c5d.png',
      'data:image/png;base64,AAAA',
    ])
  })
})

describe('batchImageUrls', () => {
  it('ignores anything that is not an importable image', () => {
    expect(batchImageUrls(undefined)).toEqual([])
    expect(batchImageUrls(['https://a.com/a.jpg', 'blob:oops'])).toEqual([
      'https://a.com/a.jpg',
    ])
  })
})

describe('isBotProtectionMessage', () => {
  it('recognises verification pages', () => {
    expect(isBotProtectionMessage(null)).toBe(false)
    expect(
      isBotProtectionMessage(
        'This retailer is showing a security verification page (bot protection).',
      ),
    ).toBe(true)
    expect(isBotProtectionMessage('Cloudflare challenge detected')).toBe(true)
  })
})

describe('runBatchScrape', () => {
  it('imports links one at a time and never in parallel', async () => {
    const urls = [
      'https://a.com/one',
      'https://b.com/two',
      'https://c.com/three',
    ]
    const items = createBatchItems(urls)
    const events: string[] = []
    let inFlight = 0
    let maxInFlight = 0

    const track = async (label: string) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      events.push(`start:${label}`)
      await new Promise((resolve) => setTimeout(resolve, 1))
      events.push(`end:${label}`)
      inFlight -= 1
    }

    const saved: string[] = []
    const results = await runBatchScrape(items, {
      scrape: async (url) => {
        await track(`scrape:${url}`)
        return { product: product({ name: `Knife ${url}` }) }
      },
      save: async (draft) => {
        await track(`save:${draft.name}`)
        saved.push(draft.name)
      },
      onUpdate: vi.fn(),
    })

    expect(maxInFlight).toBe(1)
    expect(events).toEqual([
      'start:scrape:https://a.com/one',
      'end:scrape:https://a.com/one',
      'start:save:Knife https://a.com/one',
      'end:save:Knife https://a.com/one',
      'start:scrape:https://b.com/two',
      'end:scrape:https://b.com/two',
      'start:save:Knife https://b.com/two',
      'end:save:Knife https://b.com/two',
      'start:scrape:https://c.com/three',
      'end:scrape:https://c.com/three',
      'start:save:Knife https://c.com/three',
      'end:save:Knife https://c.com/three',
    ])
    expect(saved).toEqual([
      'Knife https://a.com/one',
      'Knife https://b.com/two',
      'Knife https://c.com/three',
    ])
    expect(results.map((item) => item.status)).toEqual([
      'saved',
      'saved',
      'saved',
    ])
  })

  it('keeps going after a failed link and reports why it failed', async () => {
    const items = createBatchItems([
      'https://a.com/one',
      'https://b.com/two',
      'https://c.com/three',
    ])
    const updates: BatchScrapeItem[] = []
    const saved: string[] = []

    const results = await runBatchScrape(items, {
      scrape: async (url) => {
        if (url === 'https://b.com/two') {
          throw new Error(
            'This retailer is showing a security verification page (bot protection).',
          )
        }
        return { product: product({ name: `Knife ${url}` }) }
      },
      save: async (draft) => {
        saved.push(draft.name)
      },
      onUpdate: (item) => updates.push(item),
    })

    expect(saved).toEqual([
      'Knife https://a.com/one',
      'Knife https://c.com/three',
    ])
    expect(results.map((item) => item.status)).toEqual([
      'saved',
      'failed',
      'saved',
    ])
    expect(results[1].error).toContain('bot protection')
    expect(updates.map((item) => item.status)).toEqual([
      'scraping',
      'saving',
      'saved',
      'scraping',
      'failed',
      'scraping',
      'saving',
      'saved',
    ])
  })

  it('fails a link whose page had no product name instead of saving a blank knife', async () => {
    const items = createBatchItems(['https://a.com/one'])
    const save = vi.fn()

    const results = await runBatchScrape(items, {
      scrape: async () => ({ product: product({ name: '  ' }) }),
      save,
      onUpdate: vi.fn(),
    })

    expect(save).not.toHaveBeenCalled()
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toBe('No product name was found on the page')
  })

  it('stops before the next link when asked, leaving it pending', async () => {
    const items = createBatchItems(['https://a.com/one', 'https://b.com/two'])
    const scrape = vi.fn(async () => ({ product: product() }))
    let stop = false

    const results = await runBatchScrape(items, {
      scrape,
      save: async () => {
        stop = true
      },
      onUpdate: vi.fn(),
      shouldStop: () => stop,
    })

    expect(scrape).toHaveBeenCalledTimes(1)
    expect(results[0].status).toBe('saved')
    expect(results[1].status).toBe('pending')
  })
})
