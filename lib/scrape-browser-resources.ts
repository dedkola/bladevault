import type { Browser, BrowserContext, Page } from 'playwright'
import { ScrapeError } from '@/lib/scrape-errors'
import type { ScrapeOperation } from '@/lib/scrape-operation'

async function closeQuietly(resource?: { close: () => Promise<unknown> }) {
  await Promise.resolve()
    .then(() => resource?.close())
    .catch(() => {})
}

async function settleWithin(work: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Own resources from the moment they are created, including late launches. */
export function createScrapeBrowserResources(operation: ScrapeOperation) {
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  let page: Page | undefined
  let closed = false
  let closing: Promise<void> | undefined

  const close = (): Promise<void> => {
    closed = true
    operation.signal.removeEventListener('abort', onAbort)
    closing ??= (async () => {
      // Do not let a stalled page/context close prevent browser termination.
      await settleWithin(
        Promise.all([closeQuietly(page), closeQuietly(context)]),
        500,
      )
      await settleWithin(closeQuietly(browser), 500)
    })()
    return closing
  }
  const onAbort = () => {
    void close()
  }
  operation.signal.addEventListener('abort', onAbort, { once: true })

  const acquire = <T extends { close: () => Promise<unknown> }>(
    factory: () => Promise<T>,
    remember: (resource: T) => void,
  ): Promise<T> =>
    operation.run(async () => {
      const resource = await factory()
      if (closed || operation.signal.aborted) {
        // The deadline can win before Playwright resolves launch/newContext.
        void closeQuietly(resource)
        operation.remainingMs()
        throw new ScrapeError('cancelled')
      }
      remember(resource)
      return resource
    })

  return {
    acquireBrowser: (factory: () => Promise<Browser>) =>
      acquire(factory, (resource) => {
        browser = resource
      }),
    acquireContext: (factory: () => Promise<BrowserContext>) =>
      acquire(factory, (resource) => {
        context = resource
      }),
    acquirePage: (factory: () => Promise<Page>) =>
      acquire(factory, (resource) => {
        page = resource
      }),
    // A successful interactive start hands ownership to the 10-minute session.
    detach: () => operation.signal.removeEventListener('abort', onAbort),
    close,
  }
}
