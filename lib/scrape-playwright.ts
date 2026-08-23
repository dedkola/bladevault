import { chromium } from 'playwright'
import type { Browser, BrowserContext } from 'playwright'
import { validateExternalUrl } from '@/lib/url-validation'

export type RenderedPage = {
  html: string
  finalUrl: string
}

type BrowserState = {
  browser: Browser
  context: BrowserContext
  refs: number
}

let state: BrowserState | null = null

function userAgent(): string {
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
}

async function acquireBrowser(): Promise<BrowserState> {
  if (state) {
    state.refs += 1
    return state
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
    ],
  })

  const context = await browser.newContext({
    userAgent: userAgent(),
    viewport: { width: 1366, height: 768 },
    screen: { width: 1366, height: 768 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    },
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

  state = { browser, context, refs: 1 }

  browser.on('disconnected', () => {
    state = null
  })

  return state
}

async function releaseBrowser(): Promise<void> {
  if (!state) return
  state.refs -= 1
  if (state.refs <= 0) {
    const { browser } = state
    state = null
    await browser.close().catch(() => {
      // ignore close errors
    })
  }
}

export async function fetchRenderedHtml(url: string): Promise<RenderedPage> {
  const { context } = await acquireBrowser()
  const page = await context.newPage()

  try {
    // Shopify stores and modern product pages keep analytics/tracking sockets open,
    // so waiting for "networkidle" frequently times out in Docker. Use
    // "domcontentloaded" and wait for the primary product heading instead.
    await page.route('**/*', async (route) => {
      const type = route.request().resourceType()
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
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

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    })

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

    return { html, finalUrl }
  } finally {
    await page.close().catch(() => {
      // ignore close errors
    })
    await releaseBrowser()
  }
}
