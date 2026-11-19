import type { BrowserStorageState } from '@/lib/scrape-playwright'

/**
 * Price checks ask every store for its United States edition in US dollars,
 * whatever country the computer's IP address is in. Stores that pick the
 * country from the IP (Shopify Markets, currency switchers) otherwise show
 * local prices, such as UAH from Ukraine.
 */
export const MONITOR_COUNTRY = 'US'
export const MONITOR_CURRENCY = 'USD'

/**
 * Shopify reads `localization` (country) and `cart_currency`; the others are
 * common WooCommerce currency switchers. Stores ignore cookies they don't use.
 */
const REGION_COOKIES: ReadonlyArray<readonly [string, string]> = [
  ['localization', MONITOR_COUNTRY],
  ['cart_currency', MONITOR_CURRENCY],
  ['woocs_current_currency', MONITOR_CURRENCY],
  ['wmc_current_currency', MONITOR_CURRENCY],
  ['aelia_cs_selected_currency', MONITOR_CURRENCY],
]
const REGION_COOKIE_NAMES = new Set(REGION_COOKIES.map(([name]) => name))

/**
 * Saved cookies that pin the old country: Shopify keeps a cart's currency,
 * and its session cookie carries the cart too. Monitoring never needs a cart.
 */
function pinsRegion(name: string): boolean {
  return (
    REGION_COOKIE_NAMES.has(name) ||
    /^cart(_|$)/.test(name) ||
    name === '_shopify_essential'
  )
}

/** The `Cookie` header for plain HTTP checks. */
export function regionCookieHeader(): string {
  return REGION_COOKIES.map(([name, value]) => `${name}=${value}`).join('; ')
}

/**
 * Saved store cookies with the region cookies replaced by the US ones, so a
 * country the store set from the IP on an earlier visit does not stick.
 * Bot-check and consent cookies are kept.
 */
export function withRegionCookies(
  url: string,
  state: BrowserStorageState | undefined,
): BrowserStorageState {
  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return state ?? { cookies: [], origins: [] }
  }
  // A leading dot covers the bare domain and www., as stores redirect both.
  const domain = `.${hostname.replace(/^www\./, '')}`
  const kept = (state?.cookies ?? []).filter(
    (cookie) => !pinsRegion(cookie.name),
  )
  return {
    cookies: [
      ...kept,
      ...REGION_COOKIES.map(([name, value]) => ({
        name,
        value,
        domain,
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: 'Lax' as const,
      })),
    ],
    origins: state?.origins ?? [],
  }
}

/** Shopify's cart, whose `currency` is the store's presentment currency. */
export function getShopifyCartJsUrl(url: string): string | undefined {
  try {
    return new URL('/cart.js', url).href
  } catch {
    return undefined
  }
}
