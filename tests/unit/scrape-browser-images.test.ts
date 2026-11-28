import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserContext } from 'playwright'
import {
  createBrowserImageFetcher,
  inlineBrowserImages,
} from '@/lib/scrape-browser-images'
import { createScrapeOperation } from '@/lib/scrape-operation'

const mocks = vi.hoisted(() => ({ validate: vi.fn() }))
vi.mock('@/lib/url-validation', () => ({ validateExternalUrl: mocks.validate }))

const referer = 'https://store.example/products/knife'

type FakeResponse = {
  status: number
  type?: string
  length?: string
  body?: Buffer
}

function browserContext(responses: Record<string, FakeResponse | Error>) {
  const pages: Array<{ close: ReturnType<typeof vi.fn> }> = []
  const context = {
    newPage: vi.fn(async () => {
      const page = {
        route: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        goto: vi.fn(async (url: string) => {
          const response = responses[url]
          if (response instanceof Error) throw response
          if (!response) return null
          return {
            ok: () => response.status >= 200 && response.status < 300,
            headers: () => ({
              ...(response.type ? { 'content-type': response.type } : {}),
              ...(response.length ? { 'content-length': response.length } : {}),
            }),
            body: async () => response.body ?? Buffer.from('image-bytes'),
          }
        }),
      }
      pages.push(page)
      return page
    }),
  }
  return { context: context as unknown as BrowserContext, pages }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.validate.mockImplementation(async (value: string) => ({
    ok: true,
    url: new URL(value),
  }))
})

describe('browser image downloads', () => {
  it('returns data URLs for images and null for everything that fails', async () => {
    const { context, pages } = browserContext({
      'https://store.example/a.jpg': { status: 200, type: 'image/webp' },
      'https://store.example/challenge.jpg': {
        status: 403,
        type: 'text/html',
      },
      'https://store.example/page.jpg': { status: 200, type: 'text/html' },
      'https://store.example/huge.jpg': {
        status: 200,
        type: 'image/jpeg',
        length: String(16 * 1024 * 1024),
      },
      'https://store.example/broken.jpg': new Error('net::ERR_FAILED'),
    })
    const operation = createScrapeOperation({ timeoutMs: 10_000 })
    const results = await createBrowserImageFetcher(context, referer)(
      [
        'https://store.example/a.jpg',
        'https://store.example/challenge.jpg',
        'https://store.example/page.jpg',
        'https://store.example/huge.jpg',
        'https://store.example/broken.jpg',
      ],
      operation,
    )
    operation.dispose()
    expect(results).toEqual([
      `data:image/webp;base64,${Buffer.from('image-bytes').toString('base64')}`,
      null,
      null,
      null,
      null,
    ])
    expect(pages.length).toBeGreaterThan(0)
    for (const page of pages) expect(page.close).toHaveBeenCalledOnce()
  })

  it('skips addresses that fail URL validation', async () => {
    const { context, pages } = browserContext({})
    mocks.validate.mockResolvedValue({ ok: false, reason: 'Private address' })
    const operation = createScrapeOperation({ timeoutMs: 10_000 })
    const results = await createBrowserImageFetcher(context, referer)(
      ['http://127.0.0.1/a.jpg'],
      operation,
    )
    operation.dispose()
    expect(results).toEqual([null])
    expect(pages[0]).toBeDefined()
  })
})

describe('inlining browser images into a scrape result', () => {
  it('replaces only downloaded web images and keeps the rest in place', async () => {
    const fetcher = vi.fn(async (urls: readonly string[]) =>
      urls.map((url) =>
        url.endsWith('a.jpg') ? 'data:image/jpeg;base64,QQ==' : null,
      ),
    )
    const operation = createScrapeOperation({ timeoutMs: 60_000 })
    const images = await inlineBrowserImages(
      [
        'https://store.example/a.jpg',
        'data:image/png;base64,Qg==',
        'https://store.example/b.jpg',
      ],
      fetcher,
      operation,
    )
    operation.dispose()
    expect(fetcher).toHaveBeenCalledWith(
      ['https://store.example/a.jpg', 'https://store.example/b.jpg'],
      expect.anything(),
    )
    expect(images).toEqual([
      'data:image/jpeg;base64,QQ==',
      'data:image/png;base64,Qg==',
      'https://store.example/b.jpg',
    ])
  })

  it('keeps the addresses when the download step fails', async () => {
    const operation = createScrapeOperation({ timeoutMs: 60_000 })
    const images = ['https://store.example/a.jpg']
    await expect(
      inlineBrowserImages(
        images,
        vi.fn().mockRejectedValue(new Error('browser closed')),
        operation,
      ),
    ).resolves.toEqual(images)
    operation.dispose()
  })

  it('does not start when too little request time is left', async () => {
    const fetcher = vi.fn()
    const operation = createScrapeOperation({ timeoutMs: 3_500 })
    const images = ['https://store.example/a.jpg']
    await expect(
      inlineBrowserImages(images, fetcher, operation),
    ).resolves.toEqual(images)
    operation.dispose()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
