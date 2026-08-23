import { chromium, Browser, BrowserContext, Page } from 'playwright'
import { isSecurityChallengePage } from '@/lib/scrape'
import { validateExternalUrl } from '@/lib/url-validation'

export type InteractiveSessionStatus =
  'waiting' | 'ready' | 'scraping' | 'completed' | 'error' | 'cancelled'

type InteractiveSession = {
  id: string
  url: string
  browser: Browser
  context: BrowserContext
  page: Page
  status: InteractiveSessionStatus
  error?: string
  createdAt: number
}

const SESSION_TTL_MS = 10 * 60 * 1000 // 10 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000 // 1 minute

const sessions = new Map<string, InteractiveSession>()

function userAgent(): string {
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
}

function startCleanupTimer(): void {
  if (
    typeof globalThis !== 'undefined' &&
    (globalThis as unknown as Record<string, unknown>)
      .__bladevaultInteractiveCleanup
  ) {
    return
  }
  ;(
    globalThis as unknown as Record<string, unknown>
  ).__bladevaultInteractiveCleanup = true

  setInterval(() => {
    const now = Date.now()
    for (const [id, session] of sessions) {
      if (now - session.createdAt > SESSION_TTL_MS) {
        void closeSession(id, 'cancelled')
      }
    }
  }, CLEANUP_INTERVAL_MS)
}

startCleanupTimer()

async function closeSession(
  id: string,
  status: InteractiveSessionStatus,
  error?: string,
): Promise<void> {
  const session = sessions.get(id)
  if (!session) return

  sessions.delete(id)
  session.status = status
  if (error) session.error = error

  await session.page.close().catch(() => {
    // ignore close errors
  })
  await session.context.close().catch(() => {
    // ignore close errors
  })
  await session.browser.close().catch(() => {
    // ignore close errors
  })
}

async function launchInteractiveBrowser(): Promise<Browser> {
  const launchOptions = {
    headless: false as const,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
    ],
  }

  // Prefer the user's installed Chrome or Edge. Real browser installs render
  // pages more faithfully and are less likely to be blocked than the bundled
  // Chromium. Playwright still uses a temporary profile, so user data is not
  // touched.
  const channels: Array<{ channel: string; name: string }> = [
    { channel: 'chrome', name: 'Google Chrome' },
    { channel: 'msedge', name: 'Microsoft Edge' },
  ]

  for (const { channel, name } of channels) {
    try {
      const browser = await chromium.launch({
        ...launchOptions,
        channel: channel as 'chrome' | 'msedge',
      })
      return browser
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      console.log(`Interactive scrape: ${name} not available (${message})`)
    }
  }

  console.log('Interactive scrape: falling back to bundled Chromium')
  return chromium.launch(launchOptions)
}

export async function startInteractiveSession(url: string): Promise<string> {
  const browser = await launchInteractiveBrowser()

  const context = await browser.newContext({
    userAgent: userAgent(),
    viewport: { width: 1280, height: 800 },
    screen: { width: 1280, height: 800 },
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

  await context.route('**/*', async (route) => {
    const validation = await validateExternalUrl(route.request().url())
    if (!validation.ok) {
      await route.abort()
      return
    }

    await route.continue()
  })

  const page = await context.newPage()

  const id = crypto.randomUUID()
  const session: InteractiveSession = {
    id,
    url,
    browser,
    context,
    page,
    status: 'waiting',
    createdAt: Date.now(),
  }
  sessions.set(id, session)

  try {
    // In interactive mode the user needs a fully rendered, usable page so they
    // can complete the retailer's verification. Do not block stylesheets or
    // images like we do for the automatic headless scraper.
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    })

    await page
      .waitForSelector(
        'h1, [data-main-product], .product-single__meta, .product-info, .product-detail, .product-title',
        {
          timeout: 30000,
        },
      )
      .catch(() => {
        // Fall through: challenge pages may not have product selectors.
      })

    session.status = 'waiting'
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load page'
    await closeSession(id, 'error', message)
    throw new Error(message)
  }

  return id
}

export async function getInteractiveSessionStatus(id: string): Promise<{
  status: InteractiveSessionStatus
  isSecurityChallenge: boolean
  error?: string
}> {
  const session = sessions.get(id)
  if (!session) {
    return { status: 'cancelled', isSecurityChallenge: false }
  }

  let isSecurityChallenge = false
  try {
    const html = await session.page.content()
    isSecurityChallenge = isSecurityChallengePage(html)
  } catch {
    // If we cannot read the page content, assume it is still a challenge.
    isSecurityChallenge = true
  }

  return {
    status: session.status,
    isSecurityChallenge,
    error: session.error,
  }
}

export type InteractiveCapture = {
  html: string
  finalUrl: string
}

export async function captureInteractiveSession(
  id: string,
): Promise<InteractiveCapture> {
  const session = sessions.get(id)
  if (!session) {
    throw new Error('Interactive scrape session not found or expired.')
  }

  session.status = 'scraping'

  try {
    await session.page.waitForTimeout(1000)
    await session.page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight)
    })
    await session.page.waitForTimeout(500)

    const html = await session.page.content()
    const finalUrl = session.page.url()

    await closeSession(id, 'completed')

    return { html, finalUrl }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to capture page'
    await closeSession(id, 'error', message)
    throw new Error(message)
  }
}

export async function cancelInteractiveSession(id: string): Promise<void> {
  await closeSession(id, 'cancelled')
}
