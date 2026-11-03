import { lookup } from 'dns/promises'
import { isIP } from 'net'
import { ScrapeError } from '@/lib/scrape-errors'
import { runWithSignal } from '@/lib/scrape-operation'

const BLOCKED_HOST_PATTERNS = [/^localhost\.?$/i, /^\s*$/]
const MAX_EXTERNAL_REDIRECTS = 5

function isPrivateIp(host: string): boolean {
  const normalizedHost = host.replace(/^\[|\]$/g, '').toLowerCase()
  const ipVersion = isIP(normalizedHost)
  if (ipVersion === 4) {
    const parts = normalizedHost.split('.').map(Number)
    const [a, b, c] = parts
    // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12,
    // 192.168.0.0/16, 192.0.0.0/24, 192.0.2.0/24, 198.18.0.0/15,
    // 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 192 && b === 0 && c === 0) return true
    if (a === 192 && b === 0 && c === 2) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a === 198 && b === 51 && c === 100) return true
    if (a === 203 && b === 0 && c === 113) return true
    if (a >= 224 && a <= 239) return true
    if (a >= 240 && a <= 255) return true
    return false
  }

  if (ipVersion === 6) {
    const ipv4Mapped = normalizedHost.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (ipv4Mapped) return isPrivateIp(ipv4Mapped[1])

    // Unspecified/loopback, link-local, unique-local, site-local, multicast,
    // and documentation-only ranges are never valid external destinations.
    if (
      normalizedHost === '::' ||
      normalizedHost === '::1' ||
      normalizedHost === '0:0:0:0:0:0:0:1' ||
      /^fe[89ab][0-9a-f]:/i.test(normalizedHost) ||
      /^f[cd][0-9a-f]{2}:/i.test(normalizedHost) ||
      /^fe[c-f][0-9a-f]:/i.test(normalizedHost) ||
      /^ff/i.test(normalizedHost) ||
      /^2001:db8:/i.test(normalizedHost)
    ) {
      return true
    }
    return false
  }

  return false
}

async function isBlockedHost(host: string): Promise<boolean> {
  const normalizedHost = host.replace(/^\[|\]$/g, '')
  if (BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(normalizedHost))) {
    return true
  }

  if (isPrivateIp(normalizedHost)) {
    return true
  }

  try {
    const addresses = await lookup(normalizedHost, {
      all: true,
      verbatim: true,
    })
    if (!addresses.length) throw new ScrapeError('network')
    return addresses.some(({ address }) => isPrivateIp(address))
  } catch {
    // Fail closed, but distinguish a DNS failure from a private destination.
    throw new ScrapeError(
      'network',
      'The website address could not be resolved. Check the URL and your connection, then try again.',
    )
  }
}

export type UrlValidationResult =
  { ok: true; url: URL } | { ok: false; reason: string; code?: 'network' }

export async function validateExternalUrl(
  value: string,
  options?: { allowDataUrl?: boolean; signal?: AbortSignal },
): Promise<UrlValidationResult> {
  if (!value) {
    return { ok: false, reason: 'URL is empty' }
  }

  if (options?.allowDataUrl && value.startsWith('data:')) {
    return { ok: true, url: new URL(value) }
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, reason: 'Invalid URL' }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Only HTTP and HTTPS URLs are allowed' }
  }

  try {
    if (
      await runWithSignal(options?.signal, () => isBlockedHost(parsed.hostname))
    ) {
      return { ok: false, reason: 'Private or internal URLs are not allowed' }
    }
  } catch (error) {
    options?.signal?.throwIfAborted()
    if (!(error instanceof ScrapeError)) throw error
    return { ok: false, reason: error.message, code: 'network' }
  }

  return { ok: true, url: parsed }
}

export async function fetchExternalUrl(
  initialUrl: URL,
  init: RequestInit,
): Promise<Response> {
  const signal = init.signal ?? undefined
  const initialValidation = await validateExternalUrl(initialUrl.href, {
    signal,
  })
  if (!initialValidation.ok) {
    throw new ScrapeError(
      initialValidation.code ??
        (initialValidation.reason.includes('Private')
          ? 'blocked_url'
          : 'invalid_url'),
      initialValidation.reason,
    )
  }

  let url = initialValidation.url

  for (let redirects = 0; redirects <= MAX_EXTERNAL_REDIRECTS; redirects += 1) {
    const response = await runWithSignal(signal, () =>
      fetch(url, { ...init, redirect: 'manual' }),
    )
    const location = response.headers.get('location')
    const isRedirect = [301, 302, 303, 307, 308].includes(response.status)

    if (!isRedirect) {
      return response
    }

    // Redirect bodies are not consumed; release their connection immediately.
    void response.body?.cancel().catch(() => {})
    if (!location) throw new ScrapeError('redirect')
    if (redirects === MAX_EXTERNAL_REDIRECTS) {
      throw new ScrapeError('redirect')
    }

    let nextUrl: URL
    try {
      nextUrl = new URL(location, url)
    } catch {
      throw new ScrapeError('redirect')
    }
    const validation = await validateExternalUrl(nextUrl.href, { signal })
    if (!validation.ok) {
      throw new ScrapeError(
        validation.code ??
          (validation.reason.includes('Private') ? 'blocked_url' : 'redirect'),
        validation.reason,
      )
    }

    url = validation.url
  }

  throw new ScrapeError('redirect')
}
