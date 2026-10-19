import { withVaultWrite } from '@/lib/vault-access'
import { getLocalDb, getLocalDataDirPath } from '@/lib/local-db'
import type { Page } from 'playwright'
import { isSecurityChallengePage } from '@/lib/scrape'
import { saveScreenshotDraft } from '@/lib/webpage-screenshot-store'
import { cleanupScrapePopups } from '@/lib/scrape-popup-cleanup'

const MAX_HEIGHT = 30000
const MAX_WIDTH = 4096
const MAX_PIXELS = 60_000_000
const MAX_BYTES = 30 * 1024 * 1024
const SCROLL_SETTLE_MS = 250
const FINAL_SETTLE_MS = 750

/** Capture the live page, never a reconstructed HTML preview. */
export async function captureWebpageScreenshot(page: Page): Promise<string> {
  return withVaultWrite(async () => {
    const database = getLocalDb()
    const dataDir = getLocalDataDirPath()
    if (isSecurityChallengePage(await page.content())) {
      throw new Error(
        'The website requires verification. Use the interactive browser to capture it.',
      )
    }
    // DOM readiness is enough for parsing, but images and styles can still be loading.
    await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {})
    const deadline = Date.now() + 20000
    await page.evaluate(async () => {
      await Promise.race([
        document.fonts.ready,
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ])
    })
    for (let top = 0; ; top += 700) {
      const size = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight,
        ),
      }))
      if (
        size.height > MAX_HEIGHT ||
        size.width > MAX_WIDTH ||
        size.width * size.height > MAX_PIXELS
      )
        throw new Error(
          `This webpage is too large to capture at full resolution (${size.width} × ${size.height} pixels).`,
        )
      if (top >= size.height) break
      if (Date.now() > deadline)
        throw new Error(
          'The webpage did not finish loading in time for a complete screenshot.',
        )
      await page.evaluate(
        (y) => window.scrollTo({ top: y, behavior: 'auto' }),
        top,
      )
      await page.waitForTimeout(SCROLL_SETTLE_MS)
    }
    await page.evaluate(async () => {
      await Promise.race([
        Promise.all(
          Array.from(document.images)
            .filter((image) => !image.complete)
            .map(
              (image) =>
                new Promise<void>((resolve) => {
                  image.addEventListener('load', () => resolve(), {
                    once: true,
                  })
                  image.addEventListener('error', () => resolve(), {
                    once: true,
                  })
                }),
            ),
        ),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ])
    })
    await page.evaluate(() => window.scrollTo(0, 0))
    // Some storefronts paint below-the-fold sections only after the scroll
    // position has settled. Give the browser a final render window before the
    // full-page screenshot stitches those sections together.
    await page.waitForTimeout(FINAL_SETTLE_MS)
    // Hide cookie and marketing overlays only after the page has hydrated,
    // lazy sections have rendered, and the viewport is back at the top.
    // Removing them while a storefront is scrolled can interrupt hydration and
    // leave below-the-fold content blank in Chromium's full-page stitch.
    await page.evaluate(cleanupScrapePopups, { hideOnly: true })
    await page.waitForTimeout(FINAL_SETTLE_MS)
    const size = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
      ),
    }))
    if (
      size.height > MAX_HEIGHT ||
      size.width > MAX_WIDTH ||
      size.width * size.height > MAX_PIXELS
    )
      throw new Error(
        `This webpage is too large to capture at full resolution (${size.width} × ${size.height} pixels).`,
      )
    const assets = await page.evaluate(() => {
      const styles = Array.from(
        document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
      )
      const images = Array.from(document.images).filter(
        (image) => image.getBoundingClientRect().width > 32,
      )
      return {
        styles: styles.length,
        loadedStyles: styles.filter((style) => style.sheet).length,
        images: images.length,
        loadedImages: images.filter(
          (image) => image.complete && image.naturalWidth > 0,
        ).length,
      }
    })
    if (
      (assets.styles > 0 && assets.loadedStyles === 0) ||
      (assets.images > 0 && assets.loadedImages === 0)
    ) {
      throw new Error(
        'The webpage styles or images could not be loaded. Retry the screenshot when the website is available.',
      )
    }
    // Some storefronts use content-visibility and lazy image loading to keep
    // below-the-fold sections out of the render tree until they are visible.
    // Full-page screenshots need those sections rendered after the warm-up
    // scroll, otherwise Chromium can stitch blank space below the viewport.
    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          content-visibility: visible !important;
        }
        img[loading="lazy"] {
          content-visibility: visible !important;
        }
      `,
    })
    await page.evaluate(() => {
      for (const image of document.images) image.loading = 'eager'
    })
    await page.waitForTimeout(FINAL_SETTLE_MS)
    const buffer = await page.screenshot({
      fullPage: true,
      type: 'png',
      animations: 'allow',
      timeout: 10000,
      scale: 'css',
    })
    if (buffer.length > MAX_BYTES)
      throw new Error('The screenshot exceeds the 30 MB limit.')
    if (getLocalDataDirPath() !== dataDir || getLocalDb() !== database)
      throw new Error('The active vault changed during capture. Please retry.')
    return saveScreenshotDraft(buffer, {
      sourceUrl: page.url(),
      capturedAt: new Date().toISOString(),
      ...size,
    })
  })
}

export async function tryCaptureWebpageScreenshot(
  page: Page,
): Promise<{ screenshot?: string; screenshotWarning?: string }> {
  try {
    return { screenshot: await captureWebpageScreenshot(page) }
  } catch (error) {
    return {
      screenshotWarning:
        error instanceof Error
          ? error.message
          : 'Unable to capture the webpage screenshot.',
    }
  }
}
