import type { KnifeDraft } from '@/lib/data'
import type { ScrapedProduct } from '@/lib/scrape'
import { isScreenshotDraft } from '@/lib/webpage-screenshot-shared'

export type BatchScrapeItemStatus =
  'pending' | 'scraping' | 'saving' | 'saved' | 'failed'

export type BatchScrapeItem = {
  id: string
  url: string
  status: BatchScrapeItemStatus
  /** Product name once the scrape succeeded. */
  name?: string
  /** Why the link could not be imported. */
  error?: string
}

export type ParsedBatchLinks = {
  /** Unique, valid links in the order they were pasted. */
  urls: string[]
  /** How many repeated links were dropped. */
  duplicates: number
  /** Pasted tokens that are not http(s) links. */
  invalid: string[]
}

const EDGE_PUNCTUATION = new Set([
  '<',
  '>',
  '(',
  ')',
  '"',
  "'",
  '[',
  ']',
  '{',
  '}',
  ',',
  ';',
  '.',
])

function stripEdgePunctuation(token: string): string {
  let start = 0
  let end = token.length

  while (start < end && EDGE_PUNCTUATION.has(token[start])) start += 1
  while (end > start && EDGE_PUNCTUATION.has(token[end - 1])) end -= 1

  return token.slice(start, end)
}

/**
 * Turns a pasted blob of links into an ordered, de-duplicated list. Anything
 * that is not an http(s) URL is reported back so the caller can show it rather
 * than silently drop it.
 */
export function parseBatchLinks(input: string): ParsedBatchLinks {
  const urls: string[] = []
  const seen = new Set<string>()
  const invalid: string[] = []
  let duplicates = 0

  for (const rawToken of input.split(/\s+/)) {
    const token = stripEdgePunctuation(rawToken.trim())
    if (!token) continue

    let parsed: URL
    try {
      parsed = new URL(token)
    } catch {
      invalid.push(token)
      continue
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      invalid.push(token)
      continue
    }

    if (seen.has(parsed.href)) {
      duplicates += 1
      continue
    }

    seen.add(parsed.href)
    urls.push(parsed.href)
  }

  return { urls, duplicates, invalid }
}

export function createBatchItems(urls: string[]): BatchScrapeItem[] {
  return urls.map((url, index) => ({
    id: `${index}-${url}`,
    url,
    status: 'pending',
  }))
}

export function batchImageUrls(images: string[] | undefined): string[] {
  if (!Array.isArray(images)) return []

  return images.filter(
    (src): src is string =>
      typeof src === 'string' &&
      (src.startsWith('http') ||
        src.startsWith('data:image') ||
        isScreenshotDraft(src)),
  )
}

export function scrapedProductToKnifeDraft(
  product: ScrapedProduct,
  fallbackUrl: string,
): KnifeDraft {
  const specs = product.specs ?? ({} as Partial<ScrapedProduct['specs']>)

  return {
    name: (product.name ?? '').trim(),
    brand: product.brand ?? '',
    bladeStyle: product.bladeStyle ?? '',
    handleMaterial: product.handleMaterial ?? '',
    description: product.description ?? '',
    specs: {
      weight: specs.weight ?? '',
      overallLength: specs.overallLength ?? '',
      bladeLength: specs.bladeLength ?? '',
      bladeThickness: specs.bladeThickness ?? '',
      bladeCoating: specs.bladeCoating ?? '',
      bladeMaterial: specs.bladeMaterial ?? '',
      lockingMechanism: specs.lockingMechanism ?? '',
      designer: specs.designer ?? '',
      modelNumber: specs.modelNumber ?? '',
      handleLength: specs.handleLength ?? '',
      hardness: specs.hardness ?? '',
      price: specs.price ?? '',
      country: specs.country ?? '',
    },
    customFields: {},
    images: batchImageUrls(product.images),
    sourceUrl: product.sourceUrl?.trim() || fallbackUrl,
    pinned: false,
  }
}

export function isBotProtectionMessage(message: string | null | undefined) {
  if (!message) return false

  const lower = message.toLowerCase()
  return (
    lower.includes('bot protection') ||
    lower.includes('security verification') ||
    lower.includes('cloudflare')
  )
}

export type BatchScrapeResult = {
  product: ScrapedProduct
  finalUrl?: string
}

export type BatchScrapeDeps = {
  scrape: (url: string) => Promise<BatchScrapeResult>
  save: (draft: KnifeDraft) => Promise<unknown>
  onUpdate: (item: BatchScrapeItem) => void
  /** Checked before each link so a run can be stopped without cutting one off. */
  shouldStop?: () => boolean
}

/**
 * Imports links strictly one at a time: every scrape finishes and is saved
 * before the next link is touched, so a batch never fires parallel requests at
 * a retailer. A link that fails is recorded and the run continues with the
 * next one.
 */
export async function runBatchScrape(
  items: BatchScrapeItem[],
  deps: BatchScrapeDeps,
): Promise<BatchScrapeItem[]> {
  const results: BatchScrapeItem[] = []

  for (const item of items) {
    if (deps.shouldStop?.()) {
      results.push(item)
      continue
    }

    const scraping: BatchScrapeItem = {
      ...item,
      status: 'scraping',
      error: undefined,
    }
    deps.onUpdate(scraping)

    try {
      const { product, finalUrl } = await deps.scrape(item.url)
      const draft = scrapedProductToKnifeDraft(product, finalUrl ?? item.url)

      if (!draft.name) {
        throw new Error('No product name was found on the page')
      }

      const saving: BatchScrapeItem = {
        ...scraping,
        status: 'saving',
        name: draft.name,
      }
      deps.onUpdate(saving)

      await deps.save(draft)

      const saved: BatchScrapeItem = { ...saving, status: 'saved' }
      deps.onUpdate(saved)
      results.push(saved)
    } catch (error) {
      const failed: BatchScrapeItem = {
        ...scraping,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Import failed',
      }
      deps.onUpdate(failed)
      results.push(failed)
    }
  }

  return results
}
