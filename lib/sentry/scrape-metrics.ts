import { isIP } from 'node:net'
import * as Sentry from '@sentry/nextjs'
import { toScrapeError } from '@/lib/scrape-errors'
import {
  getErrorReportingRuntime,
  isErrorReportingAllowed,
} from '@/lib/sentry/server'

// Anonymous import statistics: one counter per import attempt, labelled with
// the retailer's domain and the outcome, so broken retailer extractors show up
// before someone reports them. Nothing about the knife or the person is sent.

export type ScrapeMethod = 'url' | 'saved_page' | 'interactive'
export type ScrapeRenderer = 'browser' | 'html_fallback'

type Env = Record<string, string | undefined>

// Docker and source servers send usage data whenever their operator set a
// DSN. The desktop app sends it only after the user agreed to usage data.
export function isUsageMetricsEnabled(env: Env = process.env) {
  if (!Sentry.getClient() || !isErrorReportingAllowed(env)) return false
  return (
    getErrorReportingRuntime(env) !== 'desktop' ||
    env.BLADEVAULT_USAGE_METRICS === '1'
  )
}

// Public retailer hostname without "www.", or "unknown" for anything that is
// not a normal public domain (IP addresses, localhost, malformed input).
export function getScrapeDomain(url: string | URL | null | undefined) {
  if (!url) return 'unknown'
  let parsed: URL
  try {
    parsed = typeof url === 'string' ? new URL(url) : url
  } catch {
    return 'unknown'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'unknown'
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (
    !hostname.includes('.') ||
    isIP(hostname.replace(/^\[|\]$/g, '')) !== 0 ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    return 'unknown'
  }
  return hostname.replace(/^www\./, '')
}

function getQuality(product: { name?: string; images?: string[] }) {
  const hasName = Boolean(product.name?.trim())
  const hasImages = (product.images?.length ?? 0) > 0
  if (hasName && hasImages) return 'complete'
  if (hasName) return 'no_images'
  return 'no_name'
}

export function recordScrapeSuccess(
  method: ScrapeMethod,
  url: string | URL | null | undefined,
  result: { product: { name?: string; images?: string[] } },
  renderer?: ScrapeRenderer,
) {
  if (!isUsageMetricsEnabled()) return
  Sentry.metrics.count('scrape.attempt', 1, {
    attributes: {
      method,
      domain: getScrapeDomain(url),
      result: 'ok',
      quality: getQuality(result.product),
      ...(renderer ? { renderer } : {}),
    },
  })
}

export function recordScrapeFailure(
  method: ScrapeMethod,
  url: string | URL | null | undefined,
  error: unknown,
) {
  if (!isUsageMetricsEnabled()) return
  const code = toScrapeError(error).code
  // Rejected input never carries a domain: it may be private or malformed.
  const domain =
    code === 'invalid_url' || code === 'blocked_url'
      ? 'unknown'
      : getScrapeDomain(url)
  Sentry.metrics.count('scrape.attempt', 1, {
    attributes: { method, domain, result: code },
  })
}
