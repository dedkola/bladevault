import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelInteractiveSession,
  captureInteractiveSession,
  getInteractiveSessionStatus,
  startInteractiveSession,
} from '@/lib/scrape-interactive'
import { createScrapeOperation } from '@/lib/scrape-operation'

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  init: vi.fn(),
  validate: vi.fn(),
  screenshot: vi.fn(),
}))
vi.mock('playwright', () => ({ chromium: { launch: mocks.launch } }))
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
let sessionIds: string[] = []
function resources() {
  const page = {
    close: vi.fn().mockResolvedValue(undefined),
    once: vi.fn(),
    goto: vi.fn().mockResolvedValue({ ok: () => true }),
    content: vi.fn().mockResolvedValue(html),
    url: vi.fn().mockReturnValue(url),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
  }
  const context = {
    close: vi.fn().mockResolvedValue(undefined),
    route: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue(page),
  }
  const browser = {
    close: vi.fn().mockResolvedValue(undefined),
    once: vi.fn(),
    newContext: vi.fn().mockResolvedValue(context),
  }
  mocks.launch.mockResolvedValue(browser)
  return { browser, context, page }
}
async function start() {
  const id = await startInteractiveSession(url)
  sessionIds.push(id)
  return id
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  sessionIds = []
  mocks.validate.mockImplementation(async (value: string) => ({
    ok: true,
    url: new URL(value),
  }))
  mocks.screenshot.mockResolvedValue({ screenshot: '/drafts/screenshot.png' })
})
afterEach(async () => {
  for (const id of sessionIds) await cancelInteractiveSession(id)
  vi.useRealTimers()
})

describe('interactive scrape lifecycle', () => {
  it('keeps the browser alive when Continue cancels an in-flight status poll', async () => {
    const { browser, page } = resources()
    const id = await start()
    page.content.mockReturnValueOnce(new Promise(() => {}))
    const operation = createScrapeOperation()
    const pending = getInteractiveSessionStatus(id, operation)
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'cancelled',
    })
    await vi.advanceTimersByTimeAsync(0)
    operation.abort()
    await rejected
    expect(browser.close).not.toHaveBeenCalled()
    await expect(captureInteractiveSession(id)).resolves.toMatchObject({ html })
    expect(browser.close).toHaveBeenCalledOnce()
    operation.dispose()
  })

  it('closes partial setup when creating the page fails', async () => {
    const { browser, context } = resources()
    context.newPage.mockRejectedValue(new Error('page setup failed'))
    await expect(startInteractiveSession(url)).rejects.toThrow(
      'page setup failed',
    )
    expect(context.close).toHaveBeenCalledOnce()
    expect(browser.close).toHaveBeenCalledOnce()
  })

  it('preserves the verification browser when Continue encounters an unsolved CAPTCHA', async () => {
    const { browser, page } = resources()
    page.content.mockResolvedValue('<html>CAPTCHA challenge</html>')
    page.goto.mockResolvedValue({ ok: () => false, status: () => 403 })
    const id = await start()
    expect(page.waitForSelector).not.toHaveBeenCalled()
    await expect(captureInteractiveSession(id)).rejects.toMatchObject({
      code: 'challenge',
    })
    await expect(getInteractiveSessionStatus(id)).resolves.toMatchObject({
      status: 'waiting',
      isSecurityChallenge: true,
    })
    expect(browser.close).not.toHaveBeenCalled()
    page.content.mockResolvedValue(html)
    await expect(captureInteractiveSession(id)).resolves.toMatchObject({
      html,
      screenshot: '/drafts/screenshot.png',
    })
    expect(browser.close).toHaveBeenCalledOnce()
    await expect(getInteractiveSessionStatus(id)).resolves.toMatchObject({
      status: 'cancelled',
    })
  })

  it('gives the person ten minutes separately from the automatic deadline', async () => {
    const { browser } = resources()
    const id = await start()
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(getInteractiveSessionStatus(id)).resolves.toMatchObject({
      status: 'waiting',
    })
    expect(browser.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(540_000)
    expect(browser.close).toHaveBeenCalledOnce()
    await expect(getInteractiveSessionStatus(id)).resolves.toMatchObject({
      status: 'cancelled',
      error: expect.stringContaining('expired or was closed'),
    })
  })

  it('reports a manually closed browser as terminal', async () => {
    const { browser } = resources()
    const id = await start()
    const disconnected = browser.once.mock.calls.find(
      ([event]) => event === 'disconnected',
    )![1]
    disconnected()
    await expect(getInteractiveSessionStatus(id)).resolves.toMatchObject({
      status: 'cancelled',
      error: expect.stringContaining('Interact with page'),
    })
  })

  it('bounds hung status reads and closes the session', async () => {
    const { browser, page } = resources()
    const id = await start()
    page.content.mockReturnValue(new Promise(() => {}))
    const pending = getInteractiveSessionStatus(id)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(10_000)
    await rejected
    expect(browser.close).toHaveBeenCalledOnce()
    await expect(getInteractiveSessionStatus(id)).resolves.toMatchObject({
      status: 'cancelled',
    })
  })

  it('bounds Continue and releases resources on timeout', async () => {
    const { browser, page } = resources()
    const id = await start()
    page.evaluate.mockReturnValue(new Promise(() => {}))
    const operation = createScrapeOperation({ timeoutMs: 50 })
    const pending = captureInteractiveSession(id, operation)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(50)
    await rejected
    expect(browser.close).toHaveBeenCalledOnce()
    await expect(getInteractiveSessionStatus(id)).resolves.toMatchObject({
      status: 'cancelled',
    })
    operation.dispose()
  })

  it('closes a browser that finishes starting after request cancellation', async () => {
    const { browser } = resources()
    let resolveLaunch!: (value: unknown) => void
    mocks.launch.mockReturnValue(
      new Promise((resolve) => {
        resolveLaunch = resolve
      }),
    )
    const operation = createScrapeOperation({ timeoutMs: 50 })
    const pending = startInteractiveSession(url, operation)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(50)
    await rejected
    resolveLaunch(browser)
    await vi.advanceTimersByTimeAsync(0)
    expect(browser.close).toHaveBeenCalledOnce()
    expect(browser.newContext).not.toHaveBeenCalled()
    operation.dispose()
  })
})
