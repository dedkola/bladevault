import type { Page } from 'playwright'
import type { ScrapeOperation } from '@/lib/scrape-operation'
import { isSogProductUrl } from '@/lib/scrape-sog'

export async function waitForSogProductContent(
  page: Page,
  operation: ScrapeOperation,
): Promise<void> {
  if (
    !isSogProductUrl(page.url()) ||
    (await page.locator('.productView').count()) === 0
  )
    return

  // SOG renders its heading before replacing the description loader and
  // filling its specifications from embedded product data.
  await page.waitForFunction(
    () => {
      const description = document.querySelector(
        '.productView .productView-description',
      )
      const specifications = document.querySelectorAll(
        '.productSpecifications .spec-items .spec-item',
      )
      return Boolean(
        description?.textContent?.trim() &&
        !description.querySelector('.content-loading') &&
        Array.from(specifications).some(
          (item) =>
            item.querySelector('.label')?.textContent?.trim() &&
            item.querySelector('.value')?.textContent?.trim(),
        ),
      )
    },
    undefined,
    { timeout: Math.min(15_000, operation.remainingMs()) },
  )
}
