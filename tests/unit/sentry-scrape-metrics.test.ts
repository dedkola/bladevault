import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sentry = vi.hoisted(() => ({
  client: {} as object | undefined,
  count: vi.fn(),
}))

vi.mock('@sentry/nextjs', () => ({
  getClient: () => sentry.client,
  metrics: { count: sentry.count },
}))

import { ScrapeError } from '@/lib/scrape-errors'
import {
  getScrapeDomain,
  isUsageMetricsEnabled,
  recordScrapeFailure,
  recordScrapeSuccess,
} from '@/lib/sentry/scrape-metrics'

const ENV_KEYS = [
  'BLADEVAULT_DESKTOP_RUNTIME',
  'BLADEVAULT_DOCKER_RUNTIME',
  'BLADEVAULT_USAGE_METRICS',
] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  sentry.client = {}
  sentry.count.mockClear()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

describe('scrape metric domain', () => {
  it('keeps only the public retailer hostname', () => {
    expect(getScrapeDomain('https://www.SOGknives.com/p/123?ref=x')).toBe(
      'sogknives.com',
    )
    expect(getScrapeDomain(new URL('https://shop.buck.com/knife'))).toBe(
      'shop.buck.com',
    )
  })

  it('hides private, local, and malformed addresses', () => {
    for (const url of [
      'http://192.168.1.10/knife',
      'http://[::1]/knife',
      'http://localhost:3000/knife',
      'http://nas.local/knife',
      'http://intranet/knife',
      'file:///Users/kola/knife.html',
      'not a url',
      undefined,
    ]) {
      expect(getScrapeDomain(url)).toBe('unknown')
    }
  })
})

describe('scrape metric gating', () => {
  it('stays off without a Sentry client', () => {
    sentry.client = undefined
    expect(isUsageMetricsEnabled()).toBe(false)
    recordScrapeSuccess('url', 'https://sog.com/a', {
      product: { name: 'Knife', images: ['a.jpg'] },
    })
    expect(sentry.count).not.toHaveBeenCalled()
  })

  it('needs the usage data consent flag on desktop', () => {
    process.env.BLADEVAULT_DESKTOP_RUNTIME = '1'
    expect(isUsageMetricsEnabled()).toBe(false)
    process.env.BLADEVAULT_USAGE_METRICS = '1'
    expect(isUsageMetricsEnabled()).toBe(true)
  })

  it('runs on servers whenever Sentry is configured', () => {
    process.env.BLADEVAULT_DOCKER_RUNTIME = '1'
    expect(isUsageMetricsEnabled()).toBe(true)
  })
})

describe('scrape metric attributes', () => {
  it('records a successful import with its quality and renderer', () => {
    recordScrapeSuccess(
      'url',
      new URL('https://www.sog.com/knife'),
      { product: { name: 'Pentagon', images: [] } },
      'html_fallback',
    )
    expect(sentry.count).toHaveBeenCalledWith('scrape.attempt', 1, {
      attributes: {
        method: 'url',
        domain: 'sog.com',
        result: 'ok',
        quality: 'no_images',
        renderer: 'html_fallback',
      },
    })
  })

  it('records a failure by error code', () => {
    recordScrapeFailure(
      'saved_page',
      'https://buck.com/knife',
      new ScrapeError('challenge'),
    )
    expect(sentry.count).toHaveBeenCalledWith('scrape.attempt', 1, {
      attributes: {
        method: 'saved_page',
        domain: 'buck.com',
        result: 'challenge',
      },
    })
  })

  it('never sends a domain for rejected input', () => {
    recordScrapeFailure(
      'url',
      'https://internal.example.com/a',
      new ScrapeError('blocked_url'),
    )
    expect(sentry.count).toHaveBeenCalledWith('scrape.attempt', 1, {
      attributes: { method: 'url', domain: 'unknown', result: 'blocked_url' },
    })
  })
})
