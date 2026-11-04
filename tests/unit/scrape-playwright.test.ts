import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchRenderedHtml } from '@/lib/scrape-playwright'
import { createScrapeOperation } from '@/lib/scrape-operation'
import { ScrapeError } from '@/lib/scrape-errors'

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  init: vi.fn(),
  validate: vi.fn(),
  screenshot: vi.fn(),
  database: {},
}))
vi.mock('playwright', () => ({ chromium: { launch: mocks.launch } }))
vi.mock('@/lib/local-db', () => ({ getLocalDb: () => mocks.database }))
vi.mock('@/lib/scrape-browser-context', () => ({
  installScrapeBrowserInitScript: mocks.init,
}))
vi.mock('@/lib/url-validation', () => ({ validateExternalUrl: mocks.validate }))
vi.mock('@/lib/webpage-screenshot-capture', () => ({
  tryCaptureWebpageScreenshot: mocks.screenshot,
}))
vi.mock('@/lib/scrape', () => ({
  isSecurityChallengePage: (html: string) => html.includes('CAPTCHA challenge'),
}))

const url = 'https://retailer.example/product'
const html = '<html><body><h1>Product</h1></body></html>'

function resources() {
  const page = {
    close: vi.fn().mockResolvedValue(undefined),
    route: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue({ ok: () => true }),
    content: vi.fn().mockResolvedValue(html),
    url: vi.fn().mockReturnValue(url),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(1) }),
    evaluate: vi.fn().mockResolvedValue(undefined),
  }
  const context = {
    close: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue(page),
  }
  const browser = {
    close: vi.fn().mockResolvedValue(undefined),
    newContext: vi.fn().mockResolvedValue(context),
  }
  mocks.launch.mockResolvedValue(browser)
  return { browser, context, page }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  mocks.validate.mockImplementation(async (value: string) => ({
    ok: true,
    url: new URL(value),
  }))
  mocks.screenshot.mockResolvedValue({ screenshot: '/drafts/screenshot.png' })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('rendered scrape browser lifecycle', () => {
  it('waits for SOG details before capturing the product HTML and screenshot', async () => {
    const { page } = resources()
    const sogUrl = 'https://www.sogknives.com/instinct-mini-g10-satin/'
    page.url.mockReturnValue(sogUrl)
    let finishHydration!: () => void
    page.waitForFunction.mockReturnValue(
      new Promise<void>((resolve) => {
        finishHydration = resolve
      }),
    )
    const pending = fetchRenderedHtml(sogUrl)
    await vi.advanceTimersByTimeAsync(0)
    expect(page.waitForFunction).toHaveBeenCalledWith(
      expect.any(Function),
      undefined,
      { timeout: 15_000 },
    )
    expect(page.content).toHaveBeenCalledOnce()
    expect(mocks.screenshot).not.toHaveBeenCalled()
    finishHydration()
    await expect(pending).resolves.toMatchObject({ html })
    expect(mocks.screenshot).toHaveBeenCalledOnce()
  })

  it('preserves DNS/network failures during guarded navigation', async () => {
    const { page } = resources()
    mocks.validate.mockResolvedValueOnce({ ok: true, url: new URL(url) })
    mocks.validate.mockResolvedValue({
      ok: false,
      code: 'network',
      reason: 'Could not connect to the website.',
    })
    page.goto.mockImplementation(async () => {
      const handler = page.route.mock.calls[0][1]
      await handler({
        request: () => ({
          resourceType: () => 'document',
          isNavigationRequest: () => true,
          url: () => url,
        }),
        abort: vi.fn().mockResolvedValue(undefined),
      })
      throw new Error('net::ERR_FAILED')
    })
    await expect(fetchRenderedHtml(url)).rejects.toMatchObject({
      code: 'network',
    })
  })

  it('cleans up when context setup fails before a page exists', async () => {
    const { browser, context } = resources()
    mocks.init.mockRejectedValue(new Error('context initialization failed'))
    await expect(fetchRenderedHtml(url)).rejects.toThrow(
      'context initialization failed',
    )
    expect(context.close).toHaveBeenCalledOnce()
    expect(browser.close).toHaveBeenCalledOnce()
  })

  it('closes a browser whose launch finishes after the deadline', async () => {
    const { browser } = resources()
    let resolveLaunch!: (value: unknown) => void
    mocks.launch.mockReturnValue(
      new Promise((resolve) => {
        resolveLaunch = resolve
      }),
    )
    const operation = createScrapeOperation({ timeoutMs: 50 })
    const pending = fetchRenderedHtml(url, operation)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(50)
    await rejected
    resolveLaunch(browser)
    await vi.advanceTimersByTimeAsync(0)
    expect(browser.close).toHaveBeenCalledOnce()
    expect(browser.newContext).not.toHaveBeenCalled()
    operation.dispose()
  })

  it('aborts stuck navigation and closes every acquired resource', async () => {
    const { browser, context, page } = resources()
    page.goto.mockReturnValue(new Promise(() => {}))
    const operation = createScrapeOperation({ timeoutMs: 50 })
    const pending = fetchRenderedHtml(url, operation)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(50)
    await rejected
    expect(page.close).toHaveBeenCalledOnce()
    expect(context.close).toHaveBeenCalledOnce()
    expect(browser.close).toHaveBeenCalledOnce()
    operation.dispose()
  })

  it('terminates the browser even when page and context close never settle', async () => {
    const { browser, context, page } = resources()
    page.close.mockReturnValue(new Promise(() => {}))
    context.close.mockReturnValue(new Promise(() => {}))
    const pending = fetchRenderedHtml(url)
    await vi.advanceTimersByTimeAsync(500)
    await expect(pending).resolves.toMatchObject({ html })
    expect(browser.close).toHaveBeenCalledOnce()
  })

  it('reports CAPTCHA immediately before selector waits or screenshot work', async () => {
    const { browser, page } = resources()
    page.content.mockResolvedValue('<html>CAPTCHA challenge</html>')
    page.goto.mockResolvedValue({ ok: () => false, status: () => 403 })
    await expect(fetchRenderedHtml(url)).rejects.toMatchObject({
      code: 'challenge',
    })
    expect(page.waitForSelector).not.toHaveBeenCalled()
    expect(mocks.screenshot).not.toHaveBeenCalled()
    expect(browser.close).toHaveBeenCalledOnce()
  })

  it('returns usable product data with a warning when optional screenshot stalls', async () => {
    const { browser } = resources()
    mocks.screenshot.mockReturnValue(new Promise(() => {}))
    const pending = fetchRenderedHtml(url)
    await vi.advanceTimersByTimeAsync(25_000)
    await expect(pending).resolves.toMatchObject({
      html,
      screenshotWarning: expect.stringContaining('screenshot took too long'),
    })
    expect(browser.close).toHaveBeenCalledOnce()
    expect(mocks.screenshot.mock.calls[0][1].aborted).toBe(true)
  })

  it('cleans up on caller cancellation', async () => {
    const { browser, page } = resources()
    page.goto.mockImplementation(async () => {
      throw new ScrapeError('cancelled')
    })
    await expect(fetchRenderedHtml(url)).rejects.toMatchObject({
      code: 'cancelled',
    })
    expect(browser.close).toHaveBeenCalledOnce()
  })
})
