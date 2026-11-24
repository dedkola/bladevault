import {
  isNetworkBlockPage,
  isSecurityChallengePage,
  networkBlockError,
} from '@/lib/scrape'
import {
  AMAZON_US_POSTCODE,
  amazonDeliveryBlocked,
  isAmazonUsHost,
} from '@/lib/scrape-amazon-location'
import { ScrapeError } from '@/lib/scrape-errors'
import type { ScrapeOperation } from '@/lib/scrape-operation'
import type { BrowserStorageState } from '@/lib/scrape-playwright'
import { fetchExternalUrl } from '@/lib/url-validation'
import { loadBrowserState, saveBrowserState } from './browser-state'

/**
 * Amazon price checks over plain HTTP, as a US shopper.
 *
 * From outside the US, amazon.com hides the buy box ("cannot be shipped to
 * your selected delivery location"). Amazon keeps the delivery location in
 * the session cookies, so one HTTP session that picked postcode 90210 reads
 * US prices in USD from any country, without a browser:
 *
 * 1. the product page gives the session cookies and a page CSRF token;
 * 2. the location modal (requested with that token) gives the form token;
 * 3. `glow/address-change` saves the postcode in the session.
 *
 * The cookies are kept with the Amazon lane's browser cookies, so a browser
 * fallback opens the same US session.
 */

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const HTML_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
/** Between page loads: two back-to-back loads is what Amazon throttles. */
export const AMAZON_PAGE_PAUSE_MS = 2_500
/** Between the location form's requests, like a person filling it in. */
const FORM_PAUSE_MS = 750

const AMAZON_COOKIE_DOMAIN = /(?:^|\.)amazon\.com$/i
/** Cookies Amazon sets for an English, USD session. */
const DEFAULT_COOKIES: ReadonlyArray<[string, string]> = [
  ['i18n-prefs', 'USD'],
  ['lc-main', 'en_US'],
]

// ------------------------------------------------------------ pure helpers

export type CookieJar = Map<string, { value: string; expires: number }>

/** amazon.com cookies from the lane's saved browser state. */
export function jarFromState(
  state: BrowserStorageState | undefined,
): CookieJar {
  const jar: CookieJar = new Map()
  for (const cookie of state?.cookies ?? []) {
    if (AMAZON_COOKIE_DOMAIN.test(cookie.domain.replace(/^\./, '')))
      jar.set(cookie.name, { value: cookie.value, expires: cookie.expires })
  }
  for (const [name, value] of DEFAULT_COOKIES)
    if (!jar.has(name)) jar.set(name, { value, expires: -1 })
  return jar
}

/** Applies `Set-Cookie` headers; an expired cookie is removed. */
export function absorbSetCookies(
  jar: CookieJar,
  headers: readonly string[],
  now = Date.now(),
): void {
  for (const header of headers) {
    const [pair, ...attributes] = header.split(';')
    const separator = pair.indexOf('=')
    if (separator <= 0) continue
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    let expires = -1
    for (const attribute of attributes) {
      const [key, ...rest] = attribute.split('=')
      const raw = rest.join('=').trim()
      if (/^\s*max-age\s*$/i.test(key)) {
        const seconds = Number(raw)
        if (Number.isFinite(seconds)) expires = now / 1000 + seconds
      } else if (/^\s*expires\s*$/i.test(key) && expires === -1) {
        const date = Date.parse(raw)
        if (Number.isFinite(date)) expires = date / 1000
      }
    }
    if (!name) continue
    if ((expires !== -1 && expires <= now / 1000) || value === '')
      jar.delete(name)
    else jar.set(name, { value, expires: Math.round(expires) || -1 })
  }
}

export function cookieHeader(jar: CookieJar): string {
  return [...jar].map(([name, { value }]) => `${name}=${value}`).join('; ')
}

/** The saved state with its amazon.com cookies replaced by the jar's. */
export function stateWithJar(
  state: BrowserStorageState | undefined,
  jar: CookieJar,
): BrowserStorageState {
  const kept = (state?.cookies ?? []).filter(
    (cookie) => !AMAZON_COOKIE_DOMAIN.test(cookie.domain.replace(/^\./, '')),
  )
  return {
    cookies: [
      ...kept,
      ...[...jar].map(([name, { value, expires }]) => ({
        name,
        value,
        domain: '.amazon.com',
        path: '/',
        expires,
        httpOnly: false,
        secure: true,
        sameSite: 'Lax' as const,
      })),
    ],
    origins: state?.origins ?? [],
  }
}

function decodeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x3D;/gi, '=')
    .replace(/&#x2F;/gi, '/')
    .replace(/&amp;/g, '&')
}

/** The page's `anti-csrftoken-a2z` for the location modal request. */
export function amazonPageCsrfToken(html: string): string | null {
  const match = decodeAttribute(html).match(
    /"anti-csrftoken-a2z"\s*:\s*"([^"]{8,200})"/,
  )
  return match?.[1] ?? null
}

/** The location modal's `CSRF_TOKEN` for the address-change form. */
export function amazonModalCsrfToken(html: string): string | null {
  const match = html.match(/CSRF_TOKEN\s*:\s*["']([^"']{8,200})["']/)
  return match?.[1] ?? null
}

/** The location modal's URL as the page names it (it carries storeContext). */
export function amazonLocationModalUrl(html: string, pageUrl: string): string {
  const match = decodeAttribute(html).match(
    /(\/portal-migration\/hz\/glow\/get-rendered-address-selections\?[^"'\s\\]+)/,
  )
  const fallback =
    '/portal-migration/hz/glow/get-rendered-address-selections?deviceType=desktop&pageType=Detail&storeContext=generic&actionSource=desktop-modal'
  return new URL(match?.[1] ?? fallback, pageUrl).href
}

/** Whether Amazon's JSON answer saved the US postcode. */
export function addressChangeAccepted(
  body: string,
  postcode = AMAZON_US_POSTCODE,
): boolean {
  try {
    const answer = JSON.parse(body) as {
      successful?: unknown
      isAddressUpdated?: unknown
      address?: { countryCode?: unknown; zipCode?: unknown }
    }
    return (
      Boolean(answer.successful || answer.isAddressUpdated) &&
      answer.address?.countryCode === 'US' &&
      String(answer.address?.zipCode ?? '').startsWith(postcode)
    )
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- requests

type AmazonResponse = { status: number; body: string; finalUrl: string }

async function amazonRequest(
  url: string,
  operation: ScrapeOperation,
  jar: CookieJar,
  init: {
    method?: 'GET' | 'POST'
    body?: string
    headers?: Record<string, string>
  } = {},
): Promise<AmazonResponse> {
  const response = await operation.run(() =>
    fetchExternalUrl(
      new URL(url),
      {
        signal: operation.signal,
        method: init.method ?? 'GET',
        body: init.body,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: HTML_ACCEPT,
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          ...(jar.size ? { Cookie: cookieHeader(jar) } : {}),
          ...init.headers,
        },
      },
      { allowBody: init.body !== undefined },
    ),
  )
  absorbSetCookies(jar, response.headers.getSetCookie?.() ?? [])
  const body = await operation.run(() => response.text())
  return { status: response.status, body, finalUrl: response.url || url }
}

/** A product page, with the same block and HTTP status handling as checks. */
async function productPage(
  url: string,
  operation: ScrapeOperation,
  jar: CookieJar,
): Promise<AmazonResponse> {
  const page = await amazonRequest(url, operation, jar, {
    headers: { 'Upgrade-Insecure-Requests': '1' },
  })
  if (isNetworkBlockPage(page.body)) throw networkBlockError(page.status)
  if (isSecurityChallengePage(page.body)) throw new ScrapeError('challenge')
  if (page.status < 200 || page.status >= 300)
    throw new ScrapeError('http', `The store returned HTTP ${page.status}.`)
  return page
}

function pause(ms: number, operation: ScrapeOperation): Promise<void> {
  return operation.run(
    () => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  )
}

/**
 * Saves the US postcode in the session, from a loaded product page. False
 * when Amazon did not take it; never throws for Amazon's answers.
 */
async function chooseUsDelivery(
  page: AmazonResponse,
  operation: ScrapeOperation,
  jar: CookieJar,
): Promise<boolean> {
  const pageToken = amazonPageCsrfToken(page.body)
  if (!pageToken) return false
  const ajax = {
    'anti-csrftoken-a2z': pageToken,
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'text/html,*/*',
    Referer: page.finalUrl,
  }
  await pause(FORM_PAUSE_MS, operation)
  const modal = await amazonRequest(
    amazonLocationModalUrl(page.body, page.finalUrl),
    operation,
    jar,
    { headers: ajax },
  )
  const formToken = modal.status === 200 && amazonModalCsrfToken(modal.body)
  if (!formToken) return false
  await pause(FORM_PAUSE_MS, operation)
  const change = await amazonRequest(
    new URL(
      '/portal-migration/hz/glow/address-change?actionSource=glow',
      page.finalUrl,
    ).href,
    operation,
    jar,
    {
      method: 'POST',
      body: JSON.stringify({
        locationType: 'LOCATION_INPUT',
        zipCode: AMAZON_US_POSTCODE,
        deviceType: 'web',
        storeContext: 'generic',
        pageType: 'Detail',
        actionSource: 'glow',
      }),
      headers: {
        ...ajax,
        'anti-csrftoken-a2z': formToken,
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/json',
      },
    },
  )
  return change.status === 200 && addressChangeAccepted(change.body)
}

export type AmazonHttpPage = {
  html: string
  finalUrl: string
  /** Amazon still delivers somewhere other than the US postcode. */
  deliveryBlocked: boolean
}

/**
 * One Amazon product page over HTTP with the lane's saved session. When an
 * amazon.com page does not deliver to the US postcode, the session picks
 * the postcode once and the page is read again 2.5 s later. Other
 * marketplaces are read as they are. Throws for bot checks and HTTP errors.
 */
export async function readAmazonPageViaHttp(
  url: string,
  operation: ScrapeOperation,
  laneKey: string,
): Promise<AmazonHttpPage> {
  // The session is amazon.com's; other marketplaces are read as they are,
  // without its cookies (i18n-prefs=USD would convert their prices).
  let usHost = false
  try {
    usHost = isAmazonUsHost(new URL(url).hostname)
  } catch {
    // An invalid URL fails in the request below.
  }
  const saved = usHost ? await loadBrowserState(laneKey) : undefined
  const jar: CookieJar = usHost ? jarFromState(saved) : new Map()
  let stored = cookieHeader(jar)
  const save = async () => {
    if (!usHost || cookieHeader(jar) === stored) return
    stored = cookieHeader(jar)
    await saveBrowserState(laneKey, stateWithJar(saved, jar)).catch(() => {})
  }

  let page = await productPage(url, operation, jar)
  let blocked = usHost && amazonDeliveryBlocked(page.body)
  if (blocked) {
    let chosen = false
    try {
      chosen = await chooseUsDelivery(page, operation, jar)
    } catch (error) {
      if (operation.signal.aborted) throw error
    }
    if (chosen) {
      await save()
      await pause(AMAZON_PAGE_PAUSE_MS, operation)
      page = await productPage(url, operation, jar)
      blocked = amazonDeliveryBlocked(page.body)
    }
  }
  await save()
  return { html: page.body, finalUrl: page.finalUrl, deliveryBlocked: blocked }
}
