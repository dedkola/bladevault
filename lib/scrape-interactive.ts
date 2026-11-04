import { tryCaptureWebpageScreenshot } from '@/lib/webpage-screenshot-capture'
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright'
import { isSecurityChallengePage } from '@/lib/scrape'
import { waitForSogProductContent } from '@/lib/scrape-sog-browser'
import { installScrapeBrowserInitScript } from '@/lib/scrape-browser-context'
import { createScrapeBrowserResources } from '@/lib/scrape-browser-resources'
import {
  createScrapeOperation,
  type ScrapeOperation,
} from '@/lib/scrape-operation'
import { ScrapeError, toScrapeError } from '@/lib/scrape-errors'
import { validateExternalUrl } from '@/lib/url-validation'

export type InteractiveSessionStatus =
  'waiting' | 'ready' | 'scraping' | 'completed' | 'error' | 'cancelled'

type InteractiveSession = {
  browser: Browser
  context: BrowserContext
  page: Page
  status: InteractiveSessionStatus
  timer: ReturnType<typeof setTimeout>
  close: () => Promise<void>
}

const SESSION_TTL_MS = 10 * 60 * 1000
const sessions = new Map<string, InteractiveSession>()

function userAgent(): string {
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
}

async function closeSession(id: string): Promise<void> {
  const session = sessions.get(id)
  if (!session) return
  sessions.delete(id)
  clearTimeout(session.timer)
  await session.close()
}

export async function startInteractiveSession(
  url: string,
  parent?: ScrapeOperation,
): Promise<string> {
  const operation = parent ?? createScrapeOperation()
  const resources = createScrapeBrowserResources(operation)
  let handedOff = false
  let sessionId: string | undefined
  try {
    return await operation.run(async () => {
      const validation = await validateExternalUrl(url, {
        signal: operation.signal,
      })
      if (!validation.ok) {
        throw new ScrapeError(
          validation.code ??
            (validation.reason.includes('Private')
              ? 'blocked_url'
              : 'invalid_url'),
          validation.reason,
        )
      }
      const launchOptions = {
        headless: false,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--disable-blink-features=AutomationControlled',
        ],
      }
      let browser
      let launchError: unknown
      // Installed browsers render verification more faithfully. Each launch
      // shares the request deadline and uses an isolated temporary profile.
      for (const channel of ['chrome', 'msedge', undefined]) {
        try {
          browser = await resources.acquireBrowser(() =>
            chromium.launch({
              ...launchOptions,
              channel,
              timeout: Math.min(10_000, operation.remainingMs()),
            }),
          )
          break
        } catch (error) {
          operation.remainingMs()
          launchError = error
        }
      }
      if (!browser) {
        const failure = toScrapeError(launchError)
        throw failure.code === 'unknown' ? new ScrapeError('browser') : failure
      }
      const activeBrowser = browser
      const context = await resources.acquireContext(() =>
        activeBrowser.newContext({
          userAgent: userAgent(),
          viewport: { width: 1280, height: 800 },
          screen: { width: 1280, height: 800 },
          locale: 'en-US',
          timezoneId: 'America/New_York',
          serviceWorkers: 'block',
          extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
        }),
      )
      await installScrapeBrowserInitScript(context)
      let navigationFailure: ScrapeError | undefined
      await context.route('**/*', async (route) => {
        // Startup's deadline stops after handoff; later verification resources
        // still need bounded URL/DNS validation during the human session.
        const routeOperation = createScrapeOperation({
          signal: operation.signal,
          timeoutMs: 10_000,
        })
        try {
          const allowed = await validateExternalUrl(route.request().url(), {
            signal: routeOperation.signal,
          })
          if (!allowed.ok) {
            if (route.request().isNavigationRequest()) {
              navigationFailure = new ScrapeError(
                allowed.code ??
                  (allowed.reason.includes('Private')
                    ? 'blocked_url'
                    : 'invalid_url'),
                allowed.reason,
              )
            }
            await route.abort()
            return
          }
          await route.continue()
        } catch {
          await route.abort().catch(() => {})
        } finally {
          routeOperation.dispose()
        }
      })
      const page = await resources.acquirePage(() => context.newPage())
      let response
      try {
        response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: Math.min(30_000, operation.remainingMs()),
        })
      } catch (error) {
        if (navigationFailure) throw navigationFailure
        throw error
      }
      const isChallenge = isSecurityChallengePage(await page.content())
      if (response && !response.ok() && !isChallenge) {
        throw new ScrapeError(
          'http',
          `The website returned HTTP ${response.status()}. Open the URL in your browser or try again later.`,
        )
      }
      // Return challenge pages immediately so the person can solve them.
      if (!isChallenge) {
        await page
          .waitForSelector(
            'h1, [data-main-product], .product-single__meta, .product-info, .product-detail, .product-title',
            { timeout: Math.min(5_000, operation.remainingMs()) },
          )
          .catch(() => operation.remainingMs())
      }
      operation.remainingMs()
      const id = crypto.randomUUID()
      sessionId = id
      const timer = setTimeout(() => {
        void closeSession(id)
      }, SESSION_TTL_MS)
      timer.unref?.()
      sessions.set(id, {
        browser,
        context,
        page,
        status: 'waiting',
        timer,
        close: resources.close,
      })
      page.once('close', () => {
        void closeSession(id)
      })
      browser.once('disconnected', () => {
        void closeSession(id)
      })
      resources.detach()
      handedOff = true
      return id
    })
  } catch (error) {
    if (sessionId) await closeSession(sessionId)
    throw error
  } finally {
    if (!handedOff) await resources.close()
    if (!parent) operation.dispose()
  }
}

export async function getInteractiveSessionStatus(
  id: string,
  parent?: ScrapeOperation,
): Promise<{
  status: InteractiveSessionStatus
  isSecurityChallenge: boolean
  error?: string
}> {
  const session = sessions.get(id)
  if (!session) {
    return {
      status: 'cancelled',
      isSecurityChallenge: false,
      error: new ScrapeError('session_expired').message,
    }
  }
  const operation = parent ?? createScrapeOperation({ timeoutMs: 10_000 })
  try {
    const html = await operation.run(() => session.page.content())
    operation.remainingMs()
    if (!sessions.has(id)) {
      return {
        status: 'cancelled',
        isSecurityChallenge: false,
        error: new ScrapeError('session_expired').message,
      }
    }
    return {
      status: session.status,
      isSecurityChallenge: isSecurityChallengePage(html),
    }
  } catch (error) {
    // Continue stops the UI poll; cancelling it must keep the browser alive.
    if (toScrapeError(error).code !== 'cancelled') await closeSession(id)
    throw error
  } finally {
    if (!parent) operation.dispose()
  }
}

export type InteractiveCapture = {
  html: string
  finalUrl: string
  screenshot?: string
  screenshotWarning?: string
}

export async function captureInteractiveSession(
  id: string,
  parent?: ScrapeOperation,
): Promise<InteractiveCapture> {
  const session = sessions.get(id)
  if (!session) throw new ScrapeError('session_expired')
  if (session.status === 'scraping') {
    throw new ScrapeError(
      'unknown',
      'This page is already being imported. Wait for it to finish.',
      409,
    )
  }
  const operation = parent ?? createScrapeOperation()
  const onAbort = () => {
    void closeSession(id)
  }
  operation.signal.addEventListener('abort', onAbort, { once: true })
  session.status = 'scraping'
  try {
    return await operation.run(async () => {
      const initialHtml = await session.page.content()
      if (isSecurityChallengePage(initialHtml))
        throw new ScrapeError('challenge')
      await waitForSogProductContent(session.page, operation)
      await session.page.waitForTimeout(1000)
      await session.page.evaluate(() =>
        window.scrollTo(0, document.body.scrollHeight),
      )
      await session.page.waitForTimeout(500)
      const html = await session.page.content()
      if (isSecurityChallengePage(html)) throw new ScrapeError('challenge')
      const finalUrl = session.page.url()
      const captureOperation = createScrapeOperation({
        signal: operation.signal,
        timeoutMs: Math.min(25_000, operation.remainingMs()),
      })
      let capture: { screenshot?: string; screenshotWarning?: string }
      try {
        capture = await captureOperation.run(() =>
          tryCaptureWebpageScreenshot(session.page, captureOperation.signal),
        )
      } catch (error) {
        operation.remainingMs()
        if (toScrapeError(error).code !== 'timeout') throw error
        capture = {
          screenshotWarning:
            'Product details were imported, but the webpage screenshot took too long. Retry the screenshot from the saved item.',
        }
      } finally {
        captureOperation.dispose()
      }
      operation.remainingMs()
      const cleanedHtml = await session.page.content()
      if (isSecurityChallengePage(cleanedHtml))
        throw new ScrapeError('challenge')
      await closeSession(id)
      return { html: cleanedHtml || html, finalUrl, ...capture }
    })
  } catch (error) {
    if (
      toScrapeError(error).code === 'challenge' &&
      !operation.signal.aborted &&
      sessions.has(id)
    ) {
      // Verification is still open: keep the existing browser for another Continue.
      session.status = 'waiting'
    } else {
      await closeSession(id)
    }
    throw error
  } finally {
    operation.signal.removeEventListener('abort', onAbort)
    if (!parent) operation.dispose()
  }
}

export async function cancelInteractiveSession(
  id: string,
  parent?: ScrapeOperation,
): Promise<void> {
  if (parent) await parent.run(() => closeSession(id))
  else await closeSession(id)
}
