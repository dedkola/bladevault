export const SCRAPE_TIMEOUT_MS = 60_000

const ERRORS = {
  timeout: [
    504,
    'Scraping took longer than 60 seconds. Retry, use “Interact with page”, or enter the details manually.',
  ],
  cancelled: [499, 'Scraping was cancelled. You can try again.'],
  invalid_url: [
    400,
    'Enter a valid product URL starting with http:// or https://.',
  ],
  blocked_url: [
    400,
    'Private or internal URLs are not allowed. Use a public product page.',
  ],
  network: [
    502,
    'Could not connect to the website. Check the URL and your connection, then try again.',
  ],
  redirect: [
    502,
    'The website could not redirect to the product page. Open it in your browser and try its final URL.',
  ],
  challenge: [
    403,
    'This website requires CAPTCHA or security verification (bot protection). Use “Interact with page”, complete verification, then click Continue, or save the page from your browser and use “Import saved page”.',
  ],
  http: [
    502,
    'The website returned an error. Open the URL in your browser or try again later.',
  ],
  browser: [
    503,
    'The scraping browser could not start. Check that Chromium, Chrome, or Edge is installed, then try again.',
  ],
  session_expired: [
    410,
    'The interactive browser session expired or was closed. Click “Interact with page” to start again.',
  ],
  invalid_response: [
    502,
    'BladeVault received an invalid server response. Try again or check that the BladeVault server is available.',
  ],
  unknown: [
    500,
    'Could not import this product page. Try again, use “Interact with page”, or enter the details manually.',
  ],
} as const

export type ScrapeErrorCode = keyof typeof ERRORS

export class ScrapeError extends Error {
  readonly status: number

  constructor(
    readonly code: ScrapeErrorCode,
    message?: string,
    status?: number,
  ) {
    super(message ?? ERRORS[code][1])
    this.name = 'ScrapeError'
    this.status = status ?? ERRORS[code][0]
  }
}

export function isScrapeErrorCode(value: unknown): value is ScrapeErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERRORS, value)
}

/** Map known causes without displaying browser diagnostics or arbitrary HTML. */
export function toScrapeError(error: unknown): ScrapeError {
  if (error instanceof ScrapeError) return error
  const details = error as {
    name?: string
    message?: string
    code?: string
    cause?: { code?: string }
  } | null
  const message = details?.message ?? ''
  const code = details?.cause?.code ?? details?.code ?? ''
  if (
    details?.name === 'TimeoutError' ||
    /timed?[ _-]?out|timeout/i.test(message) ||
    /TIMEOUT|ETIMEDOUT/.test(code)
  )
    return new ScrapeError('timeout')
  if (details?.name === 'AbortError') return new ScrapeError('cancelled')
  if (
    /ERR_(?:TOO_MANY|INVALID|UNSAFE)_REDIRECTS?|too many redirects|invalid redirect/i.test(
      message,
    )
  )
    return new ScrapeError('redirect')
  if (
    /executable.*doesn.t exist|browserType\.launch|failed to launch|missing.*display|browser.*not.*installed/i.test(
      message,
    )
  )
    return new ScrapeError('browser')
  if (
    /ENOTFOUND|EAI_AGAIN|ECONN|ENET|EHOST|EPIPE|CERT_|UND_ERR/.test(code) ||
    /net::ERR_|fetch failed|failed to fetch|load failed|terminated|network|socket|certificate/i.test(
      message,
    )
  )
    return new ScrapeError('network')
  return new ScrapeError('unknown')
}

export function scrapeErrorResponse(error: unknown): Response {
  const failure = toScrapeError(error)
  return Response.json(
    { error: failure.message, code: failure.code },
    { status: failure.status, headers: { 'Cache-Control': 'no-store' } },
  )
}
