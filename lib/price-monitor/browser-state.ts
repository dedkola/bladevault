import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getLocalDataDirPath } from '@/lib/local-db'
import type { BrowserStorageState } from '@/lib/scrape-playwright'
import { getVaultControlDir } from '@/lib/vault-access'

/**
 * Per-store Playwright storage state (cookies, localStorage), so a store that
 * set a bot-check cookie keeps accepting later checks. Lives in the private
 * control folder: never in backups, survives restores.
 */
export const BROWSER_STATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

function safeLaneKey(laneKey: string): string {
  return laneKey
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '_')
    .slice(0, 120)
}

export function browserStatePath(
  laneKey: string,
  dataDir = getLocalDataDirPath(),
): string {
  return path.join(
    getVaultControlDir(dataDir),
    'price-monitor',
    'browser-state',
    `${safeLaneKey(laneKey)}.json`,
  )
}

export async function loadBrowserState(
  laneKey: string,
  now = Date.now(),
): Promise<BrowserStorageState | undefined> {
  const filePath = browserStatePath(laneKey)
  try {
    const stat = await fs.stat(filePath)
    if (now - stat.mtimeMs > BROWSER_STATE_MAX_AGE_MS) {
      await fs.rm(filePath, { force: true })
      return undefined
    }
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { cookies?: unknown }).cookies) &&
      Array.isArray((parsed as { origins?: unknown }).origins)
    )
      return parsed as BrowserStorageState
    return undefined
  } catch {
    return undefined
  }
}

export async function saveBrowserState(
  laneKey: string,
  state: BrowserStorageState,
): Promise<void> {
  const filePath = browserStatePath(laneKey)
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(state), { mode: 0o600 })
    await fs.rename(temporaryPath, filePath)
  } finally {
    await fs.rm(temporaryPath, { force: true })
  }
}

export async function clearBrowserState(laneKey: string): Promise<void> {
  await fs.rm(browserStatePath(laneKey), { force: true })
}
