import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getLocalDb, getLocalImagesDirPath } from '@/lib/local-db'
import {
  isWebpageScreenshot,
  isScreenshotDraft,
  type WebpageScreenshot,
} from '@/lib/webpage-screenshot-shared'

const DRAFT_PREFIX = '__webpage_drafts/'
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000

export { isScreenshotDraft } from '@/lib/webpage-screenshot-shared'

export function getScreenshotMetadata(
  images: string[],
): WebpageScreenshot | undefined {
  for (const image of images) {
    if (!isWebpageScreenshot(image)) continue
    const row = getLocalDb()
      .prepare('SELECT metadata FROM webpage_screenshots WHERE path = ?')
      .get(image) as { metadata: string } | undefined
    if (row && existsSync(path.join(getLocalImagesDirPath(), image)))
      return JSON.parse(row.metadata) as WebpageScreenshot
  }
}

export async function saveScreenshotDraft(
  buffer: Buffer,
  metadata: Omit<WebpageScreenshot, 'path'>,
): Promise<string> {
  const database = getLocalDb()
  const root = getLocalImagesDirPath()
  await cleanupScreenshotDrafts()
  if (getLocalDb() !== database)
    throw new Error('The active vault changed. Please retry.')
  const relativePath = `${DRAFT_PREFIX}webpage-${randomUUID()}.png`
  const destination = path.join(root, relativePath)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.writeFile(destination, buffer)
  if (getLocalDb() !== database)
    throw new Error('The active vault changed. Please retry.')
  database
    .prepare('INSERT INTO webpage_screenshots(path, metadata) VALUES (?, ?)')
    .run(relativePath, JSON.stringify({ ...metadata, path: relativePath }))
  return relativePath
}

export async function promoteScreenshotDraft(
  src: string,
  knifeId: string,
): Promise<string> {
  const database = getLocalDb()
  if (!isScreenshotDraft(src)) throw new Error('Invalid screenshot draft')
  const metadata = getScreenshotMetadata([src])
  if (
    !metadata ||
    Date.now() - Date.parse(metadata.capturedAt) > DRAFT_TTL_MS
  ) {
    throw new Error('Screenshot preview expired. Please scrape the page again.')
  }
  const finalPath = `${knifeId}/${path.basename(src)}`
  const root = getLocalImagesDirPath()
  await fs.mkdir(path.join(root, knifeId), { recursive: true })
  await fs.copyFile(path.join(root, src), path.join(root, finalPath))
  if (getLocalDb() !== database)
    throw new Error('The active vault changed. Please retry.')
  database
    .prepare(
      'INSERT OR REPLACE INTO webpage_screenshots(path, metadata) VALUES (?, ?)',
    )
    .run(finalPath, JSON.stringify({ ...metadata, path: finalPath }))
  return finalPath
}

export async function cleanupScreenshotDrafts(): Promise<void> {
  const database = getLocalDb()
  const root = getLocalImagesDirPath()
  const rows = database
    .prepare(
      "SELECT path, metadata FROM webpage_screenshots WHERE path LIKE '__webpage_drafts/%'",
    )
    .all() as { path: string; metadata: string }[]
  for (const row of rows) {
    if (!isScreenshotDraft(row.path)) continue
    const metadata = JSON.parse(row.metadata) as WebpageScreenshot
    if (Date.now() - Date.parse(metadata.capturedAt) <= DRAFT_TTL_MS) continue
    if (getLocalDb() !== database) return
    await fs.unlink(path.join(root, row.path)).catch(() => {})
    if (getLocalDb() !== database) return
    database
      .prepare('DELETE FROM webpage_screenshots WHERE path = ?')
      .run(row.path)
  }
}
