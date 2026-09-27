import { getLocalDb } from '@/lib/local-db'
import { tryCaptureWebpageScreenshot } from '@/lib/webpage-screenshot-capture'
import { chromium } from 'playwright'
import type { Browser, BrowserContext } from 'playwright'
import { validateExternalUrl } from '@/lib/url-validation'

export type RenderedPage = {
  html: string
  finalUrl: string
  screenshot?: string
  screenshotWarning?: string
}

type BrowserState = {
  browser: Browser
  context: BrowserContext
}

function userAgent(): string {
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
}

async function acquireBrowser(): Promise<BrowserState> {
  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
    ],
  }
  // Desktop installs may use an installed browser when bundled Chromium is absent.
  const browser = await chromium.launch(launchOptions).catch(async (error) => {
    if (process.env.BLADEVAULT_DESKTOP_RUNTIME !== '1') throw error
    return chromium
      .launch({ ...launchOptions, channel: 'chrome' })
      .catch(() => chromium.launch({ ...launchOptions, channel: 'msedge' }))
  })

  const context = await browser.newContext({
    userAgent: userAgent(),
    viewport: { width: 1366, height: 768 },
    screen: { width: 1366, height: 768 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    serviceWorkers: 'block',
    // Let Chromium choose Accept and Sec-Fetch headers for each resource type.
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  })

  await context.addInitScript(() => {
    // Reduce obvious automation fingerprints that some bot walls inspect.
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        {
          name: 'Chrome PDF Viewer',
          filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
        },
        { name: 'Native Client', filename: 'internal-nacl-plugin' },
      ],
    })
    const w = window as unknown as Record<string, unknown>
    w.chrome = (w.chrome as Record<string, unknown>) || { runtime: {} }
    delete w.__playwright
    delete w.__pw_manual
  })

  return { browser, context }
}

export async function fetchRenderedHtml(url: string): Promise<RenderedPage> {
  const database = getLocalDb()
  const validation = await validateExternalUrl(url)
  if (!validation.ok) throw new Error(validation.reason)
  const { browser, context } = await acquireBrowser()
  const page = await context.newPage()

  try {
    // Shopify stores and modern product pages keep analytics/tracking sockets open,
    // so waiting for "networkidle" frequently times out in Docker. Use
    // "domcontentloaded" and wait for the primary product heading instead.
    await page.route('**/*', async (route) => {
      const type = route.request().resourceType()
      if (['media'].includes(type)) {
        await route.abort()
        return
      }

      const validation = await validateExternalUrl(route.request().url())
      if (!validation.ok) {
        await route.abort()
        return
      }

      await route.continue()
    })

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    })

    if (response && !response.ok())
      throw new Error(`Website returned HTTP ${response.status()}`)

    // Wait for any meaningful page element before assuming content is present.
    await page
      .waitForSelector(
        'h1, [data-main-product], .product-single__meta, .product-info, .product-detail, .product-title',
        {
          timeout: 30000,
        },
      )
      .catch(() => {
        // Fall through: some sites have unusual markup and we still want the HTML.
      })

    // Some retailers render specs inside accordions or tabs. Give them a moment
    // to expand lazy content, then scroll to the bottom to trigger more loaders.
    await page.waitForTimeout(1000)
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight)
    })
    await page.waitForTimeout(500)

    const html = await page.content()
    const finalUrl = page.url()

    // Some sites detect Playwright and return a bare error page (e.g. LionSteel).
    // Throw so the caller can fall back to a plain HTTP fetch.
    if (html.length < 2000) {
      const lower = html.toLowerCase()
      if (
        lower.includes('exception') ||
        lower.includes('this action caused') ||
        lower.includes('please report via e-mail')
      ) {
        throw new Error(
          'The page returned an automation error; falling back to plain fetch.',
        )
      }
    }

    if (getLocalDb() !== database)
      return {
        html,
        finalUrl,
        screenshotWarning:
          'The active vault changed during scraping. Please retry.',
      }
    const capture = await tryCaptureWebpageScreenshot(page)
    return { html, finalUrl, ...capture }
  } finally {
    await page.close().catch(() => {
      // ignore close errors
    })
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}
