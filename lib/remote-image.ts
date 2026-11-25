import { createHash } from 'node:crypto'
import { ScrapeError } from '@/lib/scrape-errors'
import { fetchExternalUrl } from '@/lib/url-validation'

/** Per-image download deadline, covering redirects and the whole body. */
export const REMOTE_IMAGE_TIMEOUT_MS = 20_000
/** Largest image body accepted from a remote URL. */
export const REMOTE_IMAGE_MAX_BYTES = 25 * 1024 * 1024

export type RemoteImageErrorCode =
  | 'invalid_url'
  | 'not_https'
  | 'blocked_url'
  | 'host_not_allowed'
  | 'http'
  | 'timeout'
  | 'too_large'
  | 'not_image'
  | 'network'

export type RemoteImageHostPolicy = {
  /** When set, only these hosts (and their subdomains) may be contacted. */
  allowedHosts?: readonly string[]
}

export type RemoteImage = {
  ok: true
  url: string
  finalUrl: string
  mime: string
  ext: string
  bytes: Buffer
  sha256: string
}

export type RemoteImageFailure = {
  ok: false
  url: string
  code: RemoteImageErrorCode
  reason: string
}

export type RemoteImageResult = RemoteImage | RemoteImageFailure

class RemoteImageError extends Error {
  constructor(
    readonly code: RemoteImageErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'RemoteImageError'
  }
}

const IMAGE_TYPES = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  png: { mime: 'image/png', ext: 'png' },
  gif: { mime: 'image/gif', ext: 'gif' },
  webp: { mime: 'image/webp', ext: 'webp' },
  avif: { mime: 'image/avif', ext: 'avif' },
} as const

/**
 * Identify a raster image from its first bytes. Content-Type is not trusted:
 * SVG, HTML and anything unrecognized are rejected.
 */
export function sniffImageType(
  bytes: Uint8Array,
): (typeof IMAGE_TYPES)[keyof typeof IMAGE_TYPES] | null {
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end))
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return IMAGE_TYPES.jpeg
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    ascii(1, 4) === 'PNG' &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return IMAGE_TYPES.png
  if (
    bytes.length >= 6 &&
    (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')
  )
    return IMAGE_TYPES.gif
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP')
    return IMAGE_TYPES.webp
  if (bytes.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12)
    if (brand === 'avif' || brand === 'avis') return IMAGE_TYPES.avif
  }
  return null
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')
}

export function isHostAllowed(
  host: string,
  allowedHosts: readonly string[] | undefined,
): boolean {
  if (!allowedHosts) return true
  const candidate = normalizeHost(host)
  return allowedHosts.some((entry) => {
    const allowed = normalizeHost(entry)
    return (
      allowed !== '' &&
      (candidate === allowed || candidate.endsWith(`.${allowed}`))
    )
  })
}

function checkDestination(url: URL, policy: RemoteImageHostPolicy) {
  if (url.protocol !== 'https:')
    throw new RemoteImageError(
      'not_https',
      'Only https image URLs are allowed (including redirects).',
    )
  if (!isHostAllowed(url.hostname, policy.allowedHosts))
    throw new RemoteImageError(
      'host_not_allowed',
      `${url.hostname} is not in the MCP image host allowlist.`,
    )
}

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => {})
    throw new RemoteImageError('too_large', tooLargeMessage(maxBytes))
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      void reader.cancel().catch(() => {})
      throw new RemoteImageError('too_large', tooLargeMessage(maxBytes))
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

function tooLargeMessage(maxBytes: number) {
  return `Image is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`
}

function toFailure(url: string, error: unknown): RemoteImageFailure {
  if (error instanceof RemoteImageError)
    return { ok: false, url, code: error.code, reason: error.message }
  if (error instanceof ScrapeError) {
    const code: RemoteImageErrorCode =
      error.code === 'blocked_url'
        ? 'blocked_url'
        : error.code === 'invalid_url'
          ? 'invalid_url'
          : error.code === 'timeout' || error.code === 'cancelled'
            ? 'timeout'
            : 'network'
    return { ok: false, url, code, reason: error.message }
  }
  const name = (error as { name?: string } | null)?.name
  if (name === 'TimeoutError' || name === 'AbortError')
    return {
      ok: false,
      url,
      code: 'timeout',
      reason: `The image did not download within ${REMOTE_IMAGE_TIMEOUT_MS / 1000} seconds.`,
    }
  return {
    ok: false,
    url,
    code: 'network',
    reason: 'The image could not be downloaded.',
  }
}

/**
 * Download one image from a public https URL. Every hop is checked for https,
 * private addresses (via fetchExternalUrl) and the optional host allowlist;
 * the body is size-capped and must be a recognized raster image.
 */
export async function fetchRemoteImage(
  url: string,
  {
    signal,
    policy = {},
    timeoutMs = REMOTE_IMAGE_TIMEOUT_MS,
    maxBytes = REMOTE_IMAGE_MAX_BYTES,
  }: {
    signal?: AbortSignal
    policy?: RemoteImageHostPolicy
    timeoutMs?: number
    maxBytes?: number
  } = {},
): Promise<RemoteImageResult> {
  try {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new RemoteImageError('invalid_url', 'Invalid URL.')
    }
    checkDestination(parsed, policy)
    const deadline = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline

    // fetchExternalUrl resolves DNS and refuses private addresses on every hop.
    let finalUrl = parsed.href
    const response = await fetchExternalUrl(
      parsed,
      {
        signal: combined,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
        },
      },
      {
        checkDestination: (destination) => {
          checkDestination(destination, policy)
          finalUrl = destination.href
        },
      },
    )
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw new RemoteImageError(
        'http',
        `The server returned HTTP ${response.status}.`,
      )
    }
    const bytes = await readCapped(response, maxBytes)
    const type = sniffImageType(bytes)
    if (!type)
      throw new RemoteImageError(
        'not_image',
        'The URL did not return a JPEG, PNG, GIF, WebP or AVIF image (SVG and HTML are not accepted).',
      )
    return {
      ok: true,
      url,
      finalUrl,
      mime: type.mime,
      ext: type.ext,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  } catch (error) {
    return toFailure(url, error)
  }
}

/** Run `fn` over `items` with at most `limit` calls in flight, keeping order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await fn(items[index], index)
      }
    },
  )
  await Promise.all(workers)
  return results
}
