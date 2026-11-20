import { getLocalDb } from '@/lib/local-db'
import { tryCaptureWebpageScreenshot } from '@/lib/webpage-screenshot-capture'
import { chromium, type BrowserContextOptions, type Page } from 'playwright'
import { installScrapeBrowserInitScript } from '@/lib/scrape-browser-context'
import { createScrapeBrowserResources } from '@/lib/scrape-browser-resources'
import {
  createScrapeOperation,
  type ScrapeOperation,
} from '@/lib/scrape-operation'
import { ScrapeError, toScrapeError } from '@/lib/scrape-errors'
import {
  isNetworkBlockPage,
  isSecurityChallengePage,
  networkBlockError,
} from '@/lib/scrape'
import { waitForSogProductContent } from '@/lib/scrape-sog-browser'
import { validateExternalUrl } from '@/lib/url-validation'

export type RenderedPage = {
  html: string
  finalUrl: string
  screenshot?: string
  screenshotWarning?: string
  /** The main document as the server sent it, before scripts ran. */
  serverHtml?: string
  /** Cookies and storage after the page loaded, when requested. */
  storageState?: BrowserStorageState
}

export type BrowserStorageState = Exclude<
  BrowserContextOptions['storageState'],
  string | undefined
>

export type RenderOptions = {
  /** Capture the webpage screenshot (default true). Monitoring skips it. */
  screenshot?: boolean
  /** Also block images and fonts, not only media, to keep the load light. */
  light?: boolean
  /** Return the navigation response body as `serverHtml`. */
  captureServerHtml?: boolean
  /** Start from saved cookies and storage (price monitoring, per store). */
  storageState?: BrowserStorageState
  /** Return the context's cookies and storage after the page loaded. */
  captureStorageState?: boolean
  /** Launch with a window (default headless). Needs a display, e.g. Xvfb. */
  headless?: boolean
  /** Whole render budget in ms (default and cap without it: 40 s). */
  budgetMs?: number
  /**
   * Runs on the loaded page before its HTML is read: the price monitor's
   * AI problem solver and store recipes act on the page here.
   */
  interact?: (page: Page, operation: ScrapeOperation) => Promise<void>
}

const LIGHT_BLOCKED_RESOURCES = new Set(['media', 'image', 'font'])

function userAgent(): string {
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
}

export async function fetchRenderedHtml(
  url: string,
  parent?: ScrapeOperation,
  options: RenderOptions = {},
): Promise<RenderedPage> {
  const blockedResources = options.light
    ? LIGHT_BLOCKED_RESOURCES
    : new Set(['media'])
  // Leave part of the request's 60-second budget for HTTP fallback/enrichment.
  const operation = createScrapeOperation({
    signal: parent?.signal,
    timeoutMs: Math.min(
      options.budgetMs ?? 40_000,
      parent?.remainingMs() ?? options.budgetMs ?? 40_000,
    ),
  })
  const resources = createScrapeBrowserResources(operation)
  try {
    return await operation.run(async () => {
      const database = getLocalDb()
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
      // Desktop installs can use an installed browser when Chromium is absent.
      const channels =
        process.env.BLADEVAULT_DESKTOP_RUNTIME === '1'
          ? [undefined, 'chrome', 'msedge']
          : [undefined]
      let browser
      let launchError: unknown
      for (const channel of channels) {
        try {
          browser = await resources.acquireBrowser(() =>
            chromium.launch({
              ...launchOptions,
              headless: options.headless ?? true,
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
          viewport: { width: 1366, height: 768 },
          screen: { width: 1366, height: 768 },
          locale: 'en-US',
          timezoneId: 'America/New_York',
          serviceWorkers: 'block',
          extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
          ...(options.storageState
            ? { storageState: options.storageState }
            : {}),
        }),
      )
      await installScrapeBrowserInitScript(context)
      const page = await resources.acquirePage(() => context.newPage())
      let navigationFailure: ScrapeError | undefined
      await page.route('**/*', async (route) => {
        try {
          if (blockedResources.has(route.request().resourceType())) {
            await route.abort()
            return
          }
          const allowed = await validateExternalUrl(route.request().url(), {
            signal: operation.signal,
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
        }
      })

      let response
      try {
        response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: Math.min(25_000, operation.remainingMs()),
        })
      } catch (error) {
        if (navigationFailure) throw navigationFailure
        throw error
      }
      let serverHtml: string | undefined
      if (options.captureServerHtml && response) {
        serverHtml = await response.text().catch(() => undefined)
      }
      const initialHtml = await page.content()
      if (isNetworkBlockPage(initialHtml))
        throw networkBlockError(response?.status())
      if (isSecurityChallengePage(initialHtml))
        throw new ScrapeError('challenge')
      if (response && !response.ok()) {
        throw Object.assign(
          new ScrapeError(
            'http',
            `The website returned HTTP ${response.status()}. Open the URL in your browser or try again later.`,
          ),
          // Price monitoring honors Retry-After when pacing a store.
          {
            retryAfter:
              typeof response.headers === 'function'
                ? (response.headers()['retry-after'] ?? null)
                : null,
          },
        )
      }

      // Avoid networkidle: retailer analytics can keep connections open forever.
      await page
        .waitForSelector(
          'h1, [data-main-product], .product-single__meta, .product-info, .product-detail, .product-details, .product-title',
          { timeout: Math.min(5_000, operation.remainingMs()) },
        )
        .catch(() => {
          // Unusual markup can still contain useful product data.
          operation.remainingMs()
        })
      const pageUrl = new URL(page.url())
      if (
        (pageUrl.hostname === 'poikiloblade.com' ||
          pageUrl.hostname === 'www.poikiloblade.com') &&
        /^\/shop\/product\/\d+\/?$/.test(pageUrl.pathname)
      ) {
        await page.waitForFunction(
          () =>
            Boolean(
              document.querySelector('.product-info h1')?.textContent?.trim(),
            ),
          undefined,
          { timeout: Math.min(15_000, operation.remainingMs()) },
        )
      }
      if (
        pageUrl.hostname === 'zt.kaiusa.com' &&
        (await page.locator('.product-details').count()) > 0
      ) {
        await page.waitForFunction(
          () =>
            Boolean(
              document.querySelector('.product-details__attributes li') &&
              document.querySelector('.product-details__gallery img'),
            ),
          undefined,
          { timeout: Math.min(15_000, operation.remainingMs()) },
        )
      }
      await waitForSogProductContent(page, operation)
      await page.waitForTimeout(1000)
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await page.waitForTimeout(500)
      if (options.interact) await options.interact(page, operation)
      const html = await page.content()
      const finalUrl = page.url()
      if (isNetworkBlockPage(html)) throw networkBlockError()
      if (isSecurityChallengePage(html)) throw new ScrapeError('challenge')
      if (
        html.length < 2000 &&
        /exception|this action caused|please report via e-mail/i.test(html)
      ) {
        throw new Error(
          'The page returned an automation error; falling back to plain fetch.',
        )
      }
      const storageState = options.captureStorageState
        ? await context.storageState().catch(() => undefined)
        : undefined
      if (getLocalDb() !== database) {
        return {
          html,
          finalUrl,
          serverHtml,
          screenshotWarning:
            'The active vault changed during scraping. Please retry.',
        }
      }
      if (options.screenshot === false)
        return { html, finalUrl, serverHtml, storageState }

      const screenshotBudget = Math.min(25_000, operation.remainingMs() - 1000)
      if (screenshotBudget < 1000) {
        return {
          html,
          finalUrl,
          serverHtml,
          screenshotWarning:
            'Product details were imported, but there was not enough time to capture the webpage screenshot. Retry the screenshot from the saved item.',
        }
      }
      const captureOperation = createScrapeOperation({
        signal: operation.signal,
        timeoutMs: screenshotBudget,
      })
      try {
        const capture = await captureOperation.run(() =>
          tryCaptureWebpageScreenshot(page, captureOperation.signal),
        )
        operation.remainingMs()
        // Screenshot scrolling can trigger overlays; retain the cleaned DOM.
        return { html: await page.content(), finalUrl, serverHtml, ...capture }
      } catch (error) {
        operation.remainingMs()
        if (toScrapeError(error).code !== 'timeout') throw error
        return {
          html,
          finalUrl,
          serverHtml,
          screenshotWarning:
            'Product details were imported, but the webpage screenshot took too long. Retry the screenshot from the saved item.',
        }
      } finally {
        captureOperation.dispose()
      }
    })
  } finally {
    await resources.close()
    operation.dispose()
  }
}
