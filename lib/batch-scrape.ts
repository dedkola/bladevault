import type { KnifeDraft } from '@/lib/data'
import type { ScrapedProduct } from '@/lib/scrape'
import { isScreenshotDraft } from '@/lib/webpage-screenshot-shared'
import { normalizeSourceUrl } from '@/lib/external-url'

export type BatchScrapeItemStatus =
  'pending' | 'scraping' | 'saving' | 'saved' | 'skipped' | 'failed'

export type BatchScrapeItem = {
  id: string
  url: string
  status: BatchScrapeItemStatus
  /** Product name once the scrape succeeded. */
  name?: string
  /** Why the link could not be imported. */
  error?: string
  /** Why the link was skipped without changing the collection. */
  reason?: string
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

const CLOSING_BRACKETS: Record<string, string> = {
  ')': '(',
  ']': '[',
  '}': '{',
}

function stripEdgePunctuation(token: string): string {
  let start = 0
  let end = token.length

  while (start < end && EDGE_PUNCTUATION.has(token[start])) start += 1
  while (end > start && EDGE_PUNCTUATION.has(token[end - 1])) {
    const closing = token[end - 1]
    const opening = CLOSING_BRACKETS[closing]
    if (opening) {
      let balance = 0
      for (const character of token.slice(start, end)) {
        if (character === opening) balance += 1
        if (character === closing) balance -= 1
      }
      // A balanced bracket belongs to the URL, such as an IPv6 host or SKU.
      if (balance >= 0) break
    }
    end -= 1
  }

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

    const key = normalizeSourceUrl(parsed.href)!
    if (seen.has(key)) {
      duplicates += 1
      continue
    }

    seen.add(key)
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
    sold: false,
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
  /** Read fresh provider state, including knives added while a batch is running. */
  getSavedSourceUrls?: () => Iterable<string>
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
  const savedUrls = new Set<string>()
  const rememberUrls = (urls: Iterable<string>) => {
    for (const url of urls) {
      const key = normalizeSourceUrl(url)
      if (key) savedUrls.add(key)
    }
  }
  const isSaved = (urls: string[]) => {
    const existingUrls = new Set(
      Array.from(deps.getSavedSourceUrls?.() ?? [], normalizeSourceUrl).filter(
        (key): key is string => key !== null,
      ),
    )
    return urls.some((url) => {
      const key = normalizeSourceUrl(url)
      return key !== null && (savedUrls.has(key) || existingUrls.has(key))
    })
  }
  const skip = (item: BatchScrapeItem) => {
    const skipped: BatchScrapeItem = {
      ...item,
      status: 'skipped',
      error: undefined,
      reason: 'Already saved in the collection',
    }
    deps.onUpdate(skipped)
    results.push(skipped)
  }

  for (const item of items) {
    if (deps.shouldStop?.()) {
      results.push(item)
      continue
    }

    if (isSaved([item.url])) {
      skip(item)
      continue
    }

    const scraping: BatchScrapeItem = {
      ...item,
      status: 'scraping',
      error: undefined,
      reason: undefined,
    }
    deps.onUpdate(scraping)

    try {
      const { product, finalUrl } = await deps.scrape(item.url)
      const draft = scrapedProductToKnifeDraft(product, finalUrl ?? item.url)
      const sourceUrls = [item.url, finalUrl ?? item.url, draft.sourceUrl]

      if (isSaved(sourceUrls)) {
        skip({ ...scraping, name: draft.name || undefined })
        continue
      }

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
      rememberUrls(sourceUrls)

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
