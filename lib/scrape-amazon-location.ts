import type { Page } from 'playwright'

/**
 * Amazon hides the price, buy box and parts of the details for products that
 * do not ship to the shopper's location. A browser outside the US gets
 * "Deliver to Ukraine" and "This item cannot be shipped to your selected
 * delivery location", so Add knife imports came back almost empty. Before
 * reading an amazon.com product page, the scraper picks a US delivery
 * postcode in the page's own location popover, like a shopper would.
 */
export const AMAZON_US_POSTCODE = '90210'

const LOCATION_LINE = '#glow-ingress-line2'
const LOCATION_LINK = '#nav-global-location-popover-link'
const POSTCODE_INPUT = '#GLUXZipUpdateInput'
const POSTCODE_APPLY = '#GLUXZipUpdate'

/** Only amazon.com takes a US postcode; other marketplaces are left alone. */
export function isAmazonUsHost(hostname: string): boolean {
  return /^(?:www\.|smile\.)?amazon\.com$/i.test(hostname)
}

/** True when Amazon already delivers to the postcode, or shows no location. */
export function amazonDeliversTo(
  location: string | null,
  postcode: string,
): boolean {
  if (!location) return true
  return location.replace(/[^0-9]/g, '').includes(postcode)
}

async function readLocation(
  page: Page,
  timeout: number,
): Promise<string | null> {
  const line = page.locator(LOCATION_LINE).first()
  if (!(await line.count())) return null
  const text = await line.textContent({ timeout })
  // Amazon pads the line with zero-width characters.
  return (text ?? '').replace(/[​-‏\s]+/g, ' ').trim() || null
}

/**
 * Sets the delivery postcode on a loaded amazon.com page and reloads it.
 * Returns false when the location could not be changed; the caller keeps the
 * page as it is (details still import, the price may be missing).
 */
export async function ensureAmazonUsDelivery(
  page: Page,
  remainingMs: () => number,
  postcode = AMAZON_US_POSTCODE,
): Promise<boolean> {
  const step = () => Math.max(1000, Math.min(10_000, remainingMs() - 15_000))
  try {
    if (!isAmazonUsHost(new URL(page.url()).hostname)) return true
    if (amazonDeliversTo(await readLocation(page, step()), postcode))
      return true
    // The popover's script is attached only after the page has loaded.
    await page.waitForLoadState('load', { timeout: step() }).catch(() => {})
    await page.locator(LOCATION_LINK).first().click({ timeout: step() })
    const input = page.locator(POSTCODE_INPUT).first()
    await input.waitFor({ state: 'visible', timeout: step() })
    await input.fill(postcode, { timeout: step() })
    // The popover binds Apply a moment after its form appears; a click before
    // that is silently ignored.
    const apply = page.locator(POSTCODE_APPLY).first()
    await apply.waitFor({ state: 'visible', timeout: step() })
    await page.waitForTimeout(750)
    const saved = page
      .waitForResponse(
        (response) =>
          response.url().includes('/glow/address-change') && response.ok(),
        { timeout: step() },
      )
      .catch(() => null)
    // Apply needs a real click: Amazon ignores a script click on it.
    await apply.click({ timeout: step() })
    if (!(await saved)) return false
    await page.reload({ waitUntil: 'domcontentloaded', timeout: step() })
    await page
      .waitForSelector('#productTitle', { timeout: Math.min(5000, step()) })
      .catch(() => {})
    return amazonDeliversTo(await readLocation(page, step()), postcode)
  } catch {
    return false
  }
}
