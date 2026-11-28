import { fetchExternalUrl } from '@/lib/url-validation'

/**
 * A store's robots.txt Crawl-delay, read once a day by the price worker:
 * the store's minimum gap never goes below it (lanes.ts, storeFloorMs).
 * Crawl-delay is not part of the robots.txt standard (RFC 9309), but many
 * stores set it to say how often they accept requests.
 */

const ROBOTS_TIMEOUT_MS = 15_000
/** robots.txt files are small; anything past this is ignored. */
const MAX_ROBOTS_CHARS = 512 * 1024

/**
 * The Crawl-delay (ms) in the `User-agent: *` group, or null when there is
 * none. Price checks send a browser user agent, so only the group for every
 * crawler applies. A group is one or more User-agent lines followed by its
 * rules; the first valid Crawl-delay in the group wins.
 */
export function parseCrawlDelay(text: string): number | null {
  let agents: string[] = []
  let inRules = false
  for (const rawLine of text.slice(0, MAX_ROBOTS_CHARS).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim()
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const field = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (field === 'user-agent') {
      // A User-agent line after rules starts a new group.
      if (inRules) {
        agents = []
        inRules = false
      }
      agents.push(value.toLowerCase())
      continue
    }
    inRules = true
    if (field !== 'crawl-delay' || !agents.includes('*')) continue
    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds > 0)
      return Math.round(seconds * 1000)
  }
  return null
}

/**
 * Reads the Crawl-delay from robots.txt at the origin of `pageUrl`. Null
 * when the file is missing, unreadable or sets none; the worker tries again
 * the next day. Uses the same private-address checks as price checks.
 */
export async function fetchCrawlDelay(
  pageUrl: string,
  signal: AbortSignal,
): Promise<number | null> {
  let robotsUrl: URL
  try {
    robotsUrl = new URL('/robots.txt', new URL(pageUrl).origin)
  } catch {
    return null
  }
  try {
    const response = await fetchExternalUrl(robotsUrl, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(ROBOTS_TIMEOUT_MS)]),
      headers: { Accept: 'text/plain' },
    })
    if (!response.ok) return null
    const type = response.headers.get('content-type') ?? ''
    // A store that answers with its HTML home page has no robots.txt.
    if (type && !type.includes('text/plain')) return null
    return parseCrawlDelay(await response.text())
  } catch (error) {
    if (signal.aborted) throw error
    return null
  }
}
