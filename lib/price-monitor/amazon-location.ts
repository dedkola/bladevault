import type { Page } from 'playwright'

/**
 * Amazon hides products that do not ship to the shopper's location. A fresh
 * browser outside the marketplace's country gets "Deliver to Ukraine", and
 * searches for most knives come back empty. Price monitoring shops with the
 * postcode from Other stores settings (or the marketplace's default), kept in
 * the Amazon lane's cookies.
 */
const LOCATION_LINE = '#glow-ingress-line2'
const LOCATION_LINK = '#nav-global-location-popover-link'
const POSTCODE_INPUT = '#GLUXZipUpdateInput'
const POSTCODE_PARTS = '#GLUXZipUpdateInput_0'
const POSTCODE_APPLY = '#GLUXZipUpdate'
const STEP_TIMEOUT_MS = 15_000

const compact = (value: string) =>
  value.toUpperCase().replace(/[^\p{L}\p{N}]/gu, '')

/**
 * True when Amazon already delivers to the postcode, or when the page shows
 * no location at all (another layout: left alone). Amazon may shorten the
 * postcode ("London SW1A 1"), so its first part is enough.
 */
export function amazonDeliversTo(
  location: string | null,
  postcode: string,
): boolean {
  if (!location) return true
  const first = compact(postcode.split(/[\s-]+/)[0] ?? '')
  return Boolean(first) && compact(location).includes(first)
}

/** Amazon would not take the marketplace's postcode. */
export class AmazonLocationError extends Error {
  constructor(
    readonly shownLocation: string,
    readonly postcode: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Amazon delivers to ${shownLocation}, and BladeVault could not set the postcode ${postcode}.`,
      options,
    )
    this.name = 'AmazonLocationError'
  }
}

async function readLocation(page: Page): Promise<string | null> {
  const line = page.locator(LOCATION_LINE).first()
  if (!(await line.count())) return null
  const text = await line.textContent({ timeout: STEP_TIMEOUT_MS })
  // Amazon pads the line with zero-width characters.
  const clean = (text ?? '').replace(/[​-‏\s]+/g, ' ').trim()
  return clean || null
}

/**
 * Clicks in the page's own script: Amazon's header can sit under a banner
 * after the scraper scrolls, and a pointer click then never lands.
 */
async function clickInPage(page: Page, selector: string) {
  const clicked = await page.evaluate((target) => {
    const element = document.querySelector<HTMLElement>(target)
    element?.click()
    return Boolean(element)
  }, selector)
  if (!clicked) throw new Error(`Amazon has no ${selector} on this page.`)
}

async function enterPostcode(page: Page, postcode: string) {
  const input = page.locator(`${POSTCODE_INPUT}, ${POSTCODE_PARTS}`).first()
  await clickInPage(page, LOCATION_LINK)
  try {
    await input.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  } catch {
    // The popover's script loads late; one more click when it did not open.
    await clickInPage(page, LOCATION_LINK)
    await input.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  }
  if (await page.locator(POSTCODE_PARTS).count()) {
    // Canada and Japan split the postcode over two fields.
    const parts = postcode.split(/[\s-]+/)
    for (const [index, part] of parts.entries())
      await page
        .locator(`#GLUXZipUpdateInput_${index}`)
        .fill(part, { timeout: STEP_TIMEOUT_MS })
  } else {
    await page
      .locator(POSTCODE_INPUT)
      .fill(postcode, { timeout: STEP_TIMEOUT_MS })
  }
  const saved = page
    .waitForResponse((response) => response.url().includes('address-change'), {
      timeout: STEP_TIMEOUT_MS,
    })
    .catch(() => null)
  // Apply needs a real click: Amazon ignores a script click on it.
  try {
    await page
      .locator(`${POSTCODE_APPLY} input`)
      .first()
      .click({ timeout: STEP_TIMEOUT_MS })
  } catch {
    await page
      .locator(`${POSTCODE_INPUT}, ${POSTCODE_PARTS}`)
      .last()
      .press('Enter')
  }
  if (!(await saved))
    throw new Error('Amazon did not save the delivery postcode.')
}

/**
 * Runs on a loaded Amazon page: when Amazon delivers somewhere else, sets the
 * postcode and reloads the page so it lists what ships there. Throws
 * AmazonLocationError when Amazon does not take the postcode.
 */
export async function ensureAmazonDelivery(
  page: Page,
  postcode: string,
): Promise<void> {
  const shown = await readLocation(page)
  if (amazonDeliversTo(shown, postcode)) return
  try {
    await enterPostcode(page, postcode)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)
  } catch (cause) {
    throw new AmazonLocationError(shown ?? 'another country', postcode, {
      cause,
    })
  }
  const now = await readLocation(page)
  if (!amazonDeliversTo(now, postcode))
    throw new AmazonLocationError(now ?? shown ?? 'another country', postcode)
}
