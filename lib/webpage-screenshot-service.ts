import { getLocalDb, getLocalDataDirPath } from '@/lib/local-db'
import { getStorage } from '@/lib/storage'
import { validateExternalUrl } from '@/lib/url-validation'
import {
  isWebpageScreenshot,
  type ScreenshotBackfillItem,
} from '@/lib/webpage-screenshot-shared'
import { getScreenshotMetadata } from '@/lib/webpage-screenshot-store'

export function getScreenshotBackfill(): ScreenshotBackfillItem[] {
  const db = getLocalDb()
  // An item captured individually no longer belongs in the missing-capture backlog.
  const existingCaptures = db
    .prepare(
      `SELECT b.knife_id AS id, i.value AS path
    FROM screenshot_backfill b JOIN knives k ON k.id = b.knife_id, json_each(k.images) i
    JOIN webpage_screenshots s ON s.path = i.value WHERE b.status IN ('pending', 'failed')`,
    )
    .all() as { id: string; path: string }[]
  for (const capture of existingCaptures) {
    if (getScreenshotMetadata([capture.path]))
      db.prepare(
        "UPDATE screenshot_backfill SET status = 'completed', error = NULL, lease_until = 0 WHERE knife_id = ?",
      ).run(capture.id)
  }
  db.prepare(
    "UPDATE screenshot_backfill SET status = 'pending', lease_until = 0 WHERE status = 'running' AND lease_until < ?",
  ).run(Date.now())
  return db
    .prepare(
      `SELECT k.id, k.name, b.status, b.error FROM screenshot_backfill b JOIN knives k ON k.id = b.knife_id ORDER BY k.name`,
    )
    .all() as ScreenshotBackfillItem[]
}

export async function captureKnifeScreenshot(id: string, replace = false) {
  const storage = getStorage()
  const before = await storage.getKnifeById(id)
  if (!before) throw new Error('Item no longer exists.')
  if (before.webpageScreenshot && !replace) return before
  const validation = await validateExternalUrl(before.sourceUrl)
  if (!validation.ok) throw new Error(validation.reason)
  const dataDir = getLocalDataDirPath()
  const database = getLocalDb()
  const { fetchRenderedHtml } = await import('@/lib/scrape-playwright')
  const result = await fetchRenderedHtml(validation.url.href)
  if (!result.screenshot)
    throw new Error(result.screenshotWarning || 'Unable to capture webpage.')
  // Restoring or switching vaults while a page loads must never mutate the new vault.
  if (getLocalDataDirPath() !== dataDir || getLocalDb() !== database)
    throw new Error('The active vault changed. Retry the capture.')
  const current = await storage.getKnifeById(id)
  if (!current) throw new Error('Item was deleted during capture.')
  if (current.sourceUrl !== before.sourceUrl)
    throw new Error('The source URL changed during capture. Retry the capture.')
  if (
    current.webpageScreenshot &&
    (!replace ||
      current.webpageScreenshot.path !== before.webpageScreenshot?.path)
  )
    return current
  const images = current.images.filter((image) => !isWebpageScreenshot(image))
  return storage.updateKnife(
    id,
    { images: [...images, result.screenshot] },
    { expectedUpdatedAt: current.updatedAt },
  )
}

export async function processScreenshotBackfill(id: string) {
  const database = getLocalDb()
  const row = database
    .prepare(
      'SELECT status, lease_until FROM screenshot_backfill WHERE knife_id = ?',
    )
    .get(id) as { status: string; lease_until: number } | undefined
  if (!row)
    throw new Error('This item is not in the legacy screenshot backlog.')
  if (row.status === 'completed' || row.status === 'skipped') return
  const claim = database
    .prepare(
      "UPDATE screenshot_backfill SET status = 'running', error = NULL, lease_until = ? WHERE knife_id = ? AND (status IN ('pending', 'failed') OR (status = 'running' AND lease_until < ?))",
    )
    .run(Date.now() + 180000, id, Date.now())
  if (!claim.changes)
    throw new Error('This item is already being captured. Please wait.')
  try {
    const knife = await captureKnifeScreenshot(id)
    if (!getScreenshotMetadata(knife.images))
      throw new Error('Screenshot was not saved.')
    if (getLocalDb() === database)
      database
        .prepare(
          "UPDATE screenshot_backfill SET status = 'completed', error = NULL, lease_until = 0 WHERE knife_id = ?",
        )
        .run(id)
  } catch (error) {
    if (getLocalDb() === database)
      database
        .prepare(
          "UPDATE screenshot_backfill SET status = 'failed', error = ?, lease_until = 0 WHERE knife_id = ?",
        )
        .run(error instanceof Error ? error.message : 'Capture failed', id)
    throw error
  }
}
