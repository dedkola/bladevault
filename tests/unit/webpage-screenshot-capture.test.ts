import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Page } from 'playwright'
import {
  captureWebpageScreenshot,
  tryCaptureWebpageScreenshot,
} from '@/lib/webpage-screenshot-capture'
import { ScrapeError } from '@/lib/scrape-errors'

const mocks = vi.hoisted(() => ({
  write: vi.fn(),
  save: vi.fn(),
  database: {},
}))
vi.mock('@/lib/vault-access', () => ({ withVaultWrite: mocks.write }))
vi.mock('@/lib/local-db', () => ({
  getLocalDb: () => mocks.database,
  getLocalDataDirPath: () => '/temporary-vault',
}))
vi.mock('@/lib/webpage-screenshot-store', () => ({
  saveScreenshotDraft: mocks.save,
}))
vi.mock('@/lib/scrape', () => ({ isSecurityChallengePage: () => false }))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.write.mockImplementation(async (action: () => Promise<unknown>) =>
    action(),
  )
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('screenshot persistence cancellation', () => {
  it('rejects an already-aborted capture before acquiring a vault write', async () => {
    const controller = new AbortController()
    controller.abort(new ScrapeError('timeout'))
    await expect(
      tryCaptureWebpageScreenshot({} as Page, controller.signal),
    ).rejects.toMatchObject({ code: 'timeout' })
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('does not persist a screenshot that finishes after cancellation', async () => {
    const controller = new AbortController()
    let resolveScreenshot!: (buffer: Buffer) => void
    const screenshot = new Promise<Buffer>((resolve) => {
      resolveScreenshot = resolve
    })
    const page = {
      content: vi.fn().mockResolvedValue('<html><h1>Product</h1></html>'),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockImplementation(async (fn: () => unknown) => {
        const source = fn.toString()
        if (source.includes('loadedStyles'))
          return { styles: 0, loadedStyles: 0, images: 0, loadedImages: 0 }
        if (source.includes('scrollWidth')) return { width: 100, height: 100 }
      }),
      addStyleTag: vi.fn().mockResolvedValue(undefined),
      screenshot: vi.fn().mockReturnValue(screenshot),
      url: vi.fn().mockReturnValue('https://retailer.example/product'),
    }
    const pending = captureWebpageScreenshot(
      page as unknown as Page,
      controller.signal,
    )
    await vi.waitFor(() => expect(page.screenshot).toHaveBeenCalledOnce())
    controller.abort(new ScrapeError('timeout'))
    resolveScreenshot(Buffer.from('screenshot'))
    await expect(pending).rejects.toMatchObject({ code: 'timeout' })
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
