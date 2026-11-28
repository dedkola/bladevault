import { describe, expect, it } from 'vitest'
import { parseCrawlDelay } from '@/lib/price-monitor/robots'

describe('parseCrawlDelay', () => {
  it('reads the delay for every crawler, in seconds', () => {
    expect(parseCrawlDelay('User-agent: *\nCrawl-delay: 10\n')).toBe(10_000)
    expect(parseCrawlDelay('user-agent: *\r\ncrawl-delay: 2.5')).toBe(2_500)
  })

  it('ignores groups for named crawlers', () => {
    const text = [
      'User-agent: Googlebot',
      'Crawl-delay: 1',
      '',
      'User-agent: *',
      'Disallow: /cart',
      'Crawl-delay: 20',
    ].join('\n')
    expect(parseCrawlDelay(text)).toBe(20_000)
    expect(parseCrawlDelay('User-agent: bingbot\nCrawl-delay: 5')).toBeNull()
  })

  it('applies a delay in a group shared with named crawlers', () => {
    const text = 'User-agent: bingbot\nUser-agent: *\nCrawl-delay: 3'
    expect(parseCrawlDelay(text)).toBe(3_000)
  })

  it('starts a new group after rules', () => {
    const text = 'User-agent: *\nDisallow: /a\nUser-agent: bot\nCrawl-delay: 9'
    expect(parseCrawlDelay(text)).toBeNull()
  })

  it('skips comments and values that are not a positive number', () => {
    expect(parseCrawlDelay('User-agent: * # all\nCrawl-delay: 4 # s')).toBe(
      4_000,
    )
    expect(parseCrawlDelay('User-agent: *\nCrawl-delay: soon')).toBeNull()
    expect(parseCrawlDelay('User-agent: *\nCrawl-delay: 0')).toBeNull()
    expect(parseCrawlDelay('')).toBeNull()
  })
})
