import { lookup } from 'dns/promises'
import { isIP } from 'net'
import { ScrapeError } from '@/lib/scrape-errors'
import { runWithSignal } from '@/lib/scrape-operation'
import { requestExternalUrl } from '@/lib/external-http'

const BLOCKED_HOST_PATTERNS = [/^localhost\.?$/i, /^\s*$/]
const MAX_EXTERNAL_REDIRECTS = 5

type ResolvedAddress = { address: string; family: number }

function normalizeHost(host: string): string {
  return host.replace(/^\[|\]$/g, '').toLowerCase()
}

function ipv6Words(host: string): number[] {
  // DNS can return dotted IPv4 tails, while URL normalizes them to hex words.
  const hexHost = host.replace(
    /(\d+)\.(\d+)\.(\d+)\.(\d+)$/,
    (_, a, b, c, d) =>
      `${((Number(a) << 8) | Number(b)).toString(16)}:${((Number(c) << 8) | Number(d)).toString(16)}`,
  )
  const [left, right] = hexHost.split('::')
  const leading = left ? left.split(':').map((word) => parseInt(word, 16)) : []
  const trailing = right
    ? right.split(':').map((word) => parseInt(word, 16))
    : []
  if (right === undefined) return leading
  return [
    ...leading,
    ...Array<number>(8 - leading.length - trailing.length).fill(0),
    ...trailing,
  ]
}

function isPrivateIp(host: string): boolean {
  const normalizedHost = normalizeHost(host)
  const ipVersion = isIP(normalizedHost)
  if (ipVersion === 4) {
    const parts = normalizedHost.split('.').map(Number)
    const [a, b, c] = parts
    // 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12,
    // 192.168.0.0/16, 192.0.0.0/24, 192.0.2.0/24, 198.18.0.0/15,
    // 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 100 && b >= 64 && b <= 127) return true
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
    const words = ipv6Words(normalizedHost)
    if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
      return isPrivateIp(
        `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`,
      )
    }

    // Unspecified/loopback, deprecated IPv4-compatible, link-local, unique-local, site-local, multicast,
    // and documentation-only ranges are never valid external destinations.
    if (
      words.slice(0, 6).every((word) => word === 0) ||
      (words[0] & 0xffc0) === 0xfe80 ||
      (words[0] & 0xfe00) === 0xfc00 ||
      (words[0] & 0xffc0) === 0xfec0 ||
      (words[0] & 0xff00) === 0xff00 ||
      (words[0] === 0x2001 && words[1] === 0xdb8)
    ) {
      return true
    }
    return false
  }

  return false
}

export type UrlValidationResult =
  { ok: true; url: URL } | { ok: false; reason: string; code?: 'network' }

type ResolvedExternalUrl =
  | { ok: true; url: URL; address: ResolvedAddress }
  | Extract<UrlValidationResult, { ok: false }>

async function resolveExternalUrl(
  value: string,
  signal?: AbortSignal,
): Promise<ResolvedExternalUrl> {
  signal?.throwIfAborted()
  if (!value) return { ok: false, reason: 'URL is empty' }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, reason: 'Invalid URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Only HTTP and HTTPS URLs are allowed' }
  }

  const host = normalizeHost(url.hostname)
  if (
    BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(host)) ||
    isPrivateIp(host)
  ) {
    return { ok: false, reason: 'Private or internal URLs are not allowed' }
  }

  let addresses: ResolvedAddress[]
  try {
    // Node returns IP literals directly without a DNS query. Use the same
    // validated resolver output for literals and hostnames at the socket boundary.
    addresses = await runWithSignal(signal, () =>
      lookup(host, { all: true, verbatim: true }),
    )
    if (
      !addresses.length ||
      addresses.some(({ address }) => !isIP(normalizeHost(address)))
    ) {
      throw new ScrapeError('network')
    }
  } catch {
    signal?.throwIfAborted()
    return {
      ok: false,
      code: 'network',
      reason:
        'The website address could not be resolved. Check the URL and your connection, then try again.',
    }
  }
  if (addresses.some(({ address }) => isPrivateIp(address))) {
    return { ok: false, reason: 'Private or internal URLs are not allowed' }
  }

  // Match the previous fetch fallback on hosts without outbound IPv6 routing.
  const selected =
    addresses.find(({ address }) => isIP(normalizeHost(address)) === 4) ??
    addresses[0]
  const address = normalizeHost(selected.address)
  return { ok: true, url, address: { address, family: isIP(address) } }
}

export async function validateExternalUrl(
  value: string,
  options?: { allowDataUrl?: boolean; signal?: AbortSignal },
): Promise<UrlValidationResult> {
  options?.signal?.throwIfAborted()
  if (options?.allowDataUrl && value.startsWith('data:')) {
    return { ok: true, url: new URL(value) }
  }
  const result = await resolveExternalUrl(value, options?.signal)
  return result.ok ? { ok: true, url: result.url } : result
}

export async function fetchExternalUrl(
  initialUrl: URL,
  init: RequestInit,
): Promise<Response> {
  const signal = init.signal ?? undefined
  const initialValidation = await resolveExternalUrl(initialUrl.href, signal)
  if (!initialValidation.ok) {
    throw new ScrapeError(
      initialValidation.code ??
        (initialValidation.reason.includes('Private')
          ? 'blocked_url'
          : 'invalid_url'),
      initialValidation.reason,
    )
  }

  let destination = initialValidation

  for (let redirects = 0; redirects <= MAX_EXTERNAL_REDIRECTS; redirects += 1) {
    const response = await runWithSignal(signal, () =>
      requestExternalUrl(destination.url, destination.address, {
        ...init,
        redirect: 'manual',
      }),
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
      nextUrl = new URL(location, destination.url)
    } catch {
      throw new ScrapeError('redirect')
    }
    const validation = await resolveExternalUrl(nextUrl.href, signal)
    if (!validation.ok) {
      throw new ScrapeError(
        validation.code ??
          (validation.reason.includes('Private') ? 'blocked_url' : 'redirect'),
        validation.reason,
      )
    }

    destination = validation
  }

  throw new ScrapeError('redirect')
}
