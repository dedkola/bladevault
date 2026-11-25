import { createHash, randomUUID } from 'node:crypto'
import type { Knife } from '@/lib/data'
import { getMcpImageHostPolicy } from '@/lib/mcp/config'
import {
  fetchRemoteImage,
  mapWithConcurrency,
  REMOTE_IMAGE_MAX_BYTES,
  sniffImageType,
  type RemoteImageErrorCode,
} from '@/lib/remote-image'
import { toScrapeError } from '@/lib/scrape-errors'
import { createScrapeOperation } from '@/lib/scrape-operation'
import type { McpTransport } from '@/lib/services/knife-service'
import {
  scrapeProductPage,
  type RenderProductPage,
} from '@/lib/services/product-scrape-service'
import { getStorage } from '@/lib/storage'
import { validateExternalUrl } from '@/lib/url-validation'
import { withVaultWrite } from '@/lib/vault-access'
import { isWebpageScreenshot } from '@/lib/webpage-screenshot-shared'

/** Most images one MCP call may download. */
export const MCP_MAX_IMAGE_URLS = 12
const DOWNLOAD_CONCURRENCY = 3

export type ImageGalleryMode = 'append' | 'replace'

export type ImageUrlCheck = {
  url: string
  status: 'ok' | 'duplicate' | 'error'
  /** For `ok`: the detected image type and size. */
  mime?: string
  bytes?: number
  /** For `duplicate`: what it repeats (an earlier URL or a saved photo). */
  duplicateOf?: string
  code?: RemoteImageErrorCode
  reason?: string
}

type DownloadedImage = { url: string; dataUrl: string }

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Short, stable label for a source in results, hashes and audit entries. */
function sourceLabel(url: string): string {
  return url.startsWith('data:')
    ? `embedded image ${sha256(url).slice(0, 12)}`
    : url
}

function hostPolicy() {
  const policy = getMcpImageHostPolicy()
  return policy.enabled ? { allowedHosts: policy.hosts } : {}
}

/** Trim, drop exact repeats and enforce the per-call cap. */
export function normalizeImageUrls(urls: readonly string[]): string[] {
  const unique = Array.from(
    new Set(urls.map((url) => url.trim()).filter(Boolean)),
  )
  if (unique.length > MCP_MAX_IMAGE_URLS)
    throw new Error(
      `At most ${MCP_MAX_IMAGE_URLS} image URLs can be added in one call.`,
    )
  return unique
}

/** Decode an image the scraper embedded as a data URL (Poikilo galleries). */
function decodeEmbeddedImage(url: string) {
  const match = url.match(/^data:image\/[a-z0-9.+-]+;base64,/i)
  if (!match) return null
  const bytes = Buffer.from(url.slice(match[0].length), 'base64')
  if (bytes.length > REMOTE_IMAGE_MAX_BYTES) return null
  const type = sniffImageType(bytes)
  return type ? { bytes, mime: type.mime } : null
}

async function existingImageHashes(knife: Knife | null) {
  const hashes = new Map<string, string>()
  if (!knife) return hashes
  const storage = getStorage()
  for (const image of knife.images) {
    if (/^(https?:|data:)/i.test(image) || isWebpageScreenshot(image)) continue
    try {
      const { buffer } = await storage.getImage(image)
      hashes.set(sha256(buffer), image)
    } catch {
      // A missing file cannot be a duplicate.
    }
  }
  return hashes
}

/**
 * Download and check every URL. Exact duplicates (same bytes) of an earlier
 * URL in the list or of a photo the knife already has are skipped.
 * `embeddedAllowed` accepts data: images, which only the scraper produces.
 */
export async function downloadImages(
  urls: readonly string[],
  {
    knife = null,
    embeddedAllowed = false,
  }: { knife?: Knife | null; embeddedAllowed?: boolean } = {},
): Promise<{ checks: ImageUrlCheck[]; images: DownloadedImage[] }> {
  const policy = hostPolicy()
  const results = await mapWithConcurrency(
    urls,
    DOWNLOAD_CONCURRENCY,
    async (url) => {
      if (url.startsWith('data:')) {
        const embedded = embeddedAllowed ? decodeEmbeddedImage(url) : null
        return embedded
          ? { ok: true as const, url, ...embedded }
          : {
              ok: false as const,
              url,
              code: 'not_image' as const,
              reason: 'Only https image URLs are accepted.',
            }
      }
      return fetchRemoteImage(url, { policy })
    },
  )

  const seen = await existingImageHashes(knife)
  const checks: ImageUrlCheck[] = []
  const images: DownloadedImage[] = []
  for (const result of results) {
    const label = sourceLabel(result.url)
    if (!result.ok) {
      checks.push({
        url: label,
        status: 'error',
        code: result.code,
        reason: result.reason,
      })
      continue
    }
    const hash = sha256(result.bytes)
    const duplicateOf = seen.get(hash)
    if (duplicateOf) {
      checks.push({ url: label, status: 'duplicate', duplicateOf })
      continue
    }
    seen.set(hash, label)
    checks.push({
      url: label,
      status: 'ok',
      mime: result.mime,
      bytes: result.bytes.length,
    })
    images.push({
      url: label,
      dataUrl: `data:${result.mime};base64,${result.bytes.toString('base64')}`,
    })
  }
  return { checks, images }
}

function summarizeChecks(checks: ImageUrlCheck[]) {
  return {
    okCount: checks.filter(({ status }) => status === 'ok').length,
    duplicateCount: checks.filter(({ status }) => status === 'duplicate')
      .length,
    errorCount: checks.filter(({ status }) => status === 'error').length,
  }
}

function listSources(urls: string[]): string {
  const shown = urls.slice(0, 5).join(', ')
  return urls.length > 5 ? `${shown} and ${urls.length - 5} more` : shown
}

function nextGallery(
  knife: Knife,
  images: DownloadedImage[],
  mode: ImageGalleryMode,
): string[] {
  const added = images.map(({ dataUrl }) => dataUrl)
  if (mode === 'append') return [...knife.images, ...added]
  // Like the app's "Refill all images": keep the saved webpage screenshot.
  return [...added, ...knife.images.filter(isWebpageScreenshot)]
}

async function requireKnife(knifeId: string): Promise<Knife> {
  const knife = await getStorage().getKnifeById(knifeId)
  if (!knife) throw new Error(`Knife with id "${knifeId}" not found`)
  return knife
}

/**
 * Save downloaded images to the knife through the same storage path as an
 * upload from the app. The knife must still match the previewed updatedAt.
 */
async function saveGallery({
  knifeId,
  expectedUpdatedAt,
  images,
  mode,
  tool,
  summary,
  transport,
}: {
  knifeId: string
  expectedUpdatedAt: string
  images: DownloadedImage[]
  mode: ImageGalleryMode
  tool: string
  summary: string
  transport: McpTransport
}) {
  return withVaultWrite(async () => {
    const knife = await requireKnife(knifeId)
    if (knife.updatedAt !== expectedUpdatedAt)
      throw new Error(
        `Knife "${knifeId}" changed after the preview; preview the images again`,
      )
    const gallery = nextGallery(knife, images, mode)
    return getStorage().updateKnife(
      knifeId,
      { images: gallery },
      {
        expectedUpdatedAt,
        mutation: {
          operationId: randomUUID(),
          source: 'mcp',
          transport,
          tool,
          summary,
          changes: [
            {
              field: 'images',
              previousValue: `${knife.images.length} photos`,
              value: `${gallery.length} photos`,
            },
          ],
        },
      },
    )
  })
}

/**
 * Preview (default) or add photos from image URLs to one knife. Preview
 * downloads and checks every URL but saves nothing.
 */
export async function addKnifeImagesFromMcp({
  knifeId,
  imageUrls,
  mode = 'append',
  apply = false,
  previewHash,
  transport,
}: {
  knifeId: string
  imageUrls: readonly string[]
  mode?: ImageGalleryMode
  apply?: boolean
  previewHash?: string
  transport: McpTransport
}) {
  const urls = normalizeImageUrls(imageUrls)
  if (urls.length === 0) throw new Error('Provide at least one image URL')
  const knife = await requireKnife(knifeId)
  const hash = sha256(
    JSON.stringify({
      tool: 'add_knife_images',
      knifeId,
      updatedAt: knife.updatedAt,
      mode,
      urls,
    }),
  )
  if (apply && previewHash !== hash)
    throw new Error(
      'Image preview is missing or stale; preview the exact request again',
    )

  // In replace mode the current photos go away, so they are not duplicates.
  const { checks, images } = await downloadImages(urls, {
    knife: mode === 'append' ? knife : null,
  })
  const counts = summarizeChecks(checks)
  const galleryBefore = knife.images.length
  const galleryAfter = images.length
    ? nextGallery(knife, images, mode).length
    : galleryBefore

  if (!apply) {
    return {
      applied: false,
      previewHash: hash,
      knifeId,
      mode,
      expectedUpdatedAt: knife.updatedAt,
      galleryBefore,
      galleryAfter,
      ...counts,
      images: checks,
      note:
        images.length === 0
          ? 'None of these URLs can be added; nothing would be saved.'
          : mode === 'replace'
            ? 'Nothing was saved. Applying replaces the current photos (a saved webpage screenshot is kept). Show this preview to the user, then call add_knife_images again with apply: true and this preview_hash.'
            : 'Nothing was saved. Show this preview to the user, then call add_knife_images again with apply: true and this preview_hash.',
    }
  }

  if (images.length === 0) {
    return {
      applied: false,
      knifeId,
      ...counts,
      images: checks,
      note: 'No image could be downloaded; the knife was not changed.',
    }
  }

  const sources = images.map(({ url }) => url)
  const updated = await saveGallery({
    knifeId,
    expectedUpdatedAt: knife.updatedAt,
    images,
    mode,
    tool: 'add_knife_images',
    summary:
      mode === 'replace'
        ? `Replaced the gallery with ${images.length} photo(s) via MCP from ${listSources(sources)}.`
        : `Added ${images.length} photo(s) via MCP from ${listSources(sources)}.`,
    transport,
  })
  return {
    applied: true,
    knifeId,
    mode,
    ...counts,
    images: checks,
    knife: updated,
  }
}

async function scrapeSourceImages(
  knife: Knife,
  renderPage: RenderProductPage | undefined,
): Promise<string[]> {
  if (!knife.sourceUrl)
    throw new Error(
      'This knife has no source_url. Set one with update_knife, or add photos with add_knife_images.',
    )
  const validation = await validateExternalUrl(knife.sourceUrl)
  if (!validation.ok)
    throw new Error(`The source_url cannot be read: ${validation.reason}`)

  const operation = createScrapeOperation()
  let images: string[]
  try {
    const { result } = await scrapeProductPage(validation.url, operation, {
      renderPage,
    })
    images = result.product.images
  } catch (error) {
    throw new Error(
      `Could not read the source page: ${toScrapeError(error).message}`,
    )
  } finally {
    operation.dispose()
  }

  const gallery = Array.from(
    new Set(
      images.filter(
        (image) =>
          !isWebpageScreenshot(image) &&
          (/^https?:\/\//i.test(image) || image.startsWith('data:image/')),
      ),
    ),
  ).slice(0, MCP_MAX_IMAGE_URLS)
  if (gallery.length === 0)
    throw new Error(
      'No product images were found on the source page. Add photos with add_knife_images instead.',
    )
  return gallery
}

/**
 * Preview (default) or replace a knife's photos with the product gallery
 * scraped from its source_url, like the app's "Refill all images".
 */
export async function refillKnifeImagesFromMcp({
  knifeId,
  apply = false,
  previewHash,
  transport,
  renderPage,
}: {
  knifeId: string
  apply?: boolean
  previewHash?: string
  transport: McpTransport
  renderPage?: RenderProductPage
}) {
  const knife = await requireKnife(knifeId)
  const scraped = await scrapeSourceImages(knife, renderPage)
  const sources = scraped.map(sourceLabel)
  const hash = sha256(
    JSON.stringify({
      tool: 'refill_knife_images',
      knifeId,
      updatedAt: knife.updatedAt,
      sources,
    }),
  )
  if (apply && previewHash !== hash)
    throw new Error(
      'Refill preview is missing or stale (the knife or the source page changed); preview again',
    )

  const { checks, images } = await downloadImages(scraped, {
    embeddedAllowed: true,
  })
  const counts = summarizeChecks(checks)

  if (!apply) {
    return {
      applied: false,
      previewHash: hash,
      knifeId,
      sourceUrl: knife.sourceUrl,
      expectedUpdatedAt: knife.updatedAt,
      galleryBefore: knife.images.length,
      galleryAfter: images.length
        ? nextGallery(knife, images, 'replace').length
        : knife.images.length,
      ...counts,
      images: checks,
      note:
        images.length === 0
          ? 'None of the source page images can be downloaded; nothing would change.'
          : 'Nothing was saved. Applying replaces the current photos with these (a saved webpage screenshot is kept). Show this preview to the user, then call refill_knife_images again with apply: true and this preview_hash.',
    }
  }

  if (images.length === 0) {
    return {
      applied: false,
      knifeId,
      ...counts,
      images: checks,
      note: 'No source page image could be downloaded; the knife was not changed.',
    }
  }

  const updated = await saveGallery({
    knifeId,
    expectedUpdatedAt: knife.updatedAt,
    images,
    mode: 'replace',
    tool: 'refill_knife_images',
    summary: `Replaced the gallery with ${images.length} photo(s) from the source page ${knife.sourceUrl}.`,
    transport,
  })
  return {
    applied: true,
    knifeId,
    sourceUrl: knife.sourceUrl,
    ...counts,
    images: checks,
    knife: updated,
  }
}
