import * as cheerio from 'cheerio'
import { fetchExternalUrl } from './url-validation'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024

export function isPoikiloProductUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      (url.hostname === 'poikiloblade.com' ||
        url.hostname === 'www.poikiloblade.com') &&
      /^\/shop\/product\/\d+\/?$/.test(url.pathname)
    )
  } catch {
    return false
  }
}

function resolveImageUrl(value: string, baseUrl: string): URL | undefined {
  try {
    return new URL(value, baseUrl)
  } catch {
    return undefined
  }
}

async function fetchPoikiloImage(url: URL): Promise<string> {
  const response = await fetchExternalUrl(url, {
    headers: { Accept: 'image/*', Referer: 'https://poikiloblade.com/' },
    signal: AbortSignal.timeout(15_000),
  })
  const contentType = response.headers.get('content-type')?.split(';')[0].trim()
  if (
    !response.ok ||
    !/^image\/(?:png|jpeg|webp|gif|avif)$/i.test(contentType ?? '') ||
    !response.body
  ) {
    await response.body?.cancel()
    throw new Error(
      `The image host returned an invalid image (HTTP ${response.status})`,
    )
  }
  if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
    await response.body.cancel()
    throw new Error('The image exceeds the 10 MB import limit')
  }

  const chunks: Uint8Array[] = []
  let size = 0
  // Enforce the limit while reading, including responses without Content-Length.
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > MAX_IMAGE_BYTES) {
      throw new Error('The image exceeds the 10 MB import limit')
    }
    chunks.push(chunk)
  }
  if (!size) throw new Error('The image host returned an empty image')
  return `data:${contentType?.toLowerCase()};base64,${Buffer.concat(chunks).toString('base64')}`
}

/** Poikilo's CDN rejects browser previews and downloads without its own referrer. */
export async function embedPoikiloGalleryImages(
  html: string,
  baseUrl: string,
  images: string[],
): Promise<{ html: string; images: string[]; warnings: string[] }> {
  const replacements = new Map<string, string>()
  const warnings: string[] = []
  for (const [index, image] of images.entries()) {
    const url = resolveImageUrl(image, baseUrl)
    if (url?.protocol !== 'https:' || url.hostname !== 'img.poikiloblade.cn')
      continue
    if (replacements.has(url.href)) continue
    try {
      replacements.set(url.href, await fetchPoikiloImage(url))
    } catch (error) {
      replacements.set(url.href, '')
      const message =
        error instanceof Error ? error.message : 'Image download failed'
      warnings.push(
        `Poikilo image ${index + 1} could not be imported: ${message}. Retry scraping to fetch it.`,
      )
    }
  }

  if (!replacements.size) return { html, images, warnings }
  const $ = cheerio.load(html)
  $('img[src]').each((_, element) => {
    const image = $(element)
    const src = image.attr('src')
    if (!src) return
    const resolved = resolveImageUrl(src, baseUrl)
    const replacement = resolved && replacements.get(resolved.href)
    if (replacement) {
      image.attr('src', replacement)
      image.removeAttr('srcset')
    }
  })
  return {
    html: $.html(),
    images: images
      .map(
        (image) =>
          replacements.get(resolveImageUrl(image, baseUrl)?.href ?? image) ??
          image,
      )
      .filter(Boolean),
    warnings,
  }
}
