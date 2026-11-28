import type { BrowserContext, Page } from 'playwright'
import {
  createScrapeOperation,
  type ScrapeOperation,
} from '@/lib/scrape-operation'
import { validateExternalUrl } from '@/lib/url-validation'

// The same limits as the desktop BladeVault browser (electron/scrape-browser.cjs).
const MAX_IMAGES = 40
const MAX_IMAGE_BYTES = 15 * 1024 * 1024
const IMAGE_TIMEOUT_MS = 20_000
const IMAGE_CONCURRENCY = 4
const IMAGE_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])
/** The whole image step's cap, and the time it leaves the request for its reply. */
const IMAGE_STEP_MS = 25_000
const RESPONSE_MARGIN_MS = 3_000
const MIN_IMAGE_STEP_MS = 2_000

/**
 * Downloads product images in a browser that already loaded the product page,
 * so they pass the same bot protection as the page did. Server downloads can
 * be refused for photos the page showed (e.g. Cloudflare on a store's
 * `/cdn/shop/` paths). Returns a data URL per image, or null when it failed.
 */
export type BrowserImageFetcher = (
  urls: readonly string[],
  operation: ScrapeOperation,
) => Promise<(string | null)[]>

/** A browser kept open after a scrape for image downloads; close it after use. */
export type BrowserImageSession = {
  fetchImages: BrowserImageFetcher
  close: () => Promise<void>
}

function toImageDataUrl(contentType: string, body: Buffer): string | null {
  const type = contentType.split(';')[0].trim().toLowerCase()
  if (!IMAGE_TYPES.has(type) || body.length === 0) return null
  return `data:${type};base64,${body.toString('base64')}`
}

async function openImagePage(
  context: BrowserContext,
  operation: ScrapeOperation,
): Promise<Page> {
  const page = await context.newPage()
  await page.route('**/*', async (route) => {
    const request = route.request()
    // Only the image itself; an image document has no other resources.
    if (!request.isNavigationRequest()) {
      await route.abort().catch(() => {})
      return
    }
    try {
      const allowed = await validateExternalUrl(request.url(), {
        signal: operation.signal,
      })
      if (allowed.ok) await route.continue()
      else await route.abort()
    } catch {
      await route.abort().catch(() => {})
    }
  })
  return page
}

async function fetchImage(
  page: Page,
  url: string,
  referer: string,
  operation: ScrapeOperation,
): Promise<string | null> {
  const validation = await validateExternalUrl(url, {
    signal: operation.signal,
  })
  if (!validation.ok) return null
  const response = await page.goto(validation.url.href, {
    referer,
    waitUntil: 'commit',
    timeout: Math.min(IMAGE_TIMEOUT_MS, operation.remainingMs()),
  })
  if (!response?.ok()) return null
  const headers = response.headers()
  if (Number(headers['content-length']) > MAX_IMAGE_BYTES) return null
  const body = await operation.run(() => response.body())
  if (body.length > MAX_IMAGE_BYTES) return null
  return toImageDataUrl(headers['content-type'] ?? '', body)
}

export function createBrowserImageFetcher(
  context: BrowserContext,
  referer: string,
): BrowserImageFetcher {
  return async (urls, operation) => {
    const list = urls.slice(0, MAX_IMAGES)
    const results: (string | null)[] = urls.map(() => null)
    let next = 0
    const worker = async () => {
      let page: Page | undefined
      try {
        page = await operation.run(() => openImagePage(context, operation))
        while (next < list.length && !operation.signal.aborted) {
          const index = next++
          results[index] = await fetchImage(
            page,
            list[index],
            referer,
            operation,
          ).catch(() => null)
        }
      } catch {
        // Images this worker did not reach keep their original address.
      } finally {
        await page?.close().catch(() => {})
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(IMAGE_CONCURRENCY, list.length) }, worker),
    )
    return results
  }
}

/**
 * Replace the http(s) entries of `images` with browser-downloaded data URLs,
 * within part of the request's remaining time. Best effort: an image that
 * fails keeps its address (the server tries it again on save), and nothing
 * here throws, so a slow or refused photo never fails the whole import.
 */
export async function inlineBrowserImages(
  images: string[],
  fetchImages: BrowserImageFetcher,
  parent: ScrapeOperation,
): Promise<string[]> {
  const positions = images.flatMap((src, index) =>
    /^https?:\/\//i.test(src) ? [index] : [],
  )
  if (positions.length === 0) return images
  let budget: number
  try {
    budget = Math.min(IMAGE_STEP_MS, parent.remainingMs() - RESPONSE_MARGIN_MS)
  } catch {
    return images
  }
  if (budget < MIN_IMAGE_STEP_MS) return images

  const operation = createScrapeOperation({
    signal: parent.signal,
    timeoutMs: budget,
  })
  try {
    const downloaded = await fetchImages(
      positions.map((index) => images[index]),
      operation,
    ).catch(() => [])
    const result = [...images]
    positions.forEach((imageIndex, position) => {
      const dataUrl = downloaded[position]
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/'))
        result[imageIndex] = dataUrl
    })
    return result
  } finally {
    operation.dispose()
  }
}
