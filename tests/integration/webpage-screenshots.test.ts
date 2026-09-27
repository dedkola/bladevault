import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalStorage } from '@/lib/storage/local'
import { closeLocalDb, getLocalDb } from '@/lib/local-db'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'
import {
  saveScreenshotDraft,
  cleanupScreenshotDrafts,
  getScreenshotMetadata,
} from '@/lib/webpage-screenshot-store'
import {
  captureKnifeScreenshot,
  getScreenshotBackfill,
  processScreenshotBackfill,
} from '@/lib/webpage-screenshot-service'
import type { CreateKnifeInput } from '@/lib/storage/types'

const rendered = vi.hoisted(() => vi.fn())
vi.mock('@/lib/scrape-playwright', () => ({ fetchRenderedHtml: rendered }))
vi.mock('@/lib/url-validation', () => ({
  validateExternalUrl: async (url: string) =>
    url.startsWith('https://')
      ? { ok: true, url: new URL(url) }
      : { ok: false, reason: 'Invalid public URL' },
}))
let vault: TempVault | null = null
const input: CreateKnifeInput = {
  name: 'Screenshot knife',
  brand: 'Maker',
  bladeStyle: '',
  handleMaterial: '',
  imageUrls: ['data:image/png;base64,aGVsbG8='],
  specs: { weight: '', overallLength: '', bladeLength: '', country: '' },
  customFields: {},
  description: 'Original description',
  sourceUrl: 'https://example.com/product',
  pinned: false,
}
const metadata = {
  sourceUrl: input.sourceUrl,
  capturedAt: new Date().toISOString(),
  width: 1366,
  height: 4500,
}
const draft = () =>
  saveScreenshotDraft(Buffer.from('screenshot-bytes'), {
    ...metadata,
    capturedAt: new Date().toISOString(),
  })

afterEach(async () => {
  vi.useRealTimers()
  vi.clearAllMocks()
  await vault?.cleanup()
  vault = null
})

describe('webpage screenshots', () => {
  it('saves a screenshot last, preserves its metadata and bytes, and keeps it last when reordered', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()
    const preview = await draft()
    const knife = await storage.createKnife({
      ...input,
      imageUrls: [preview, ...input.imageUrls],
    })
    expect(knife.images[0]).toMatch(/image-/)
    expect(knife.images[1]).toMatch(/^screenshot-knife\/webpage-/)
    expect(knife.webpageScreenshot).toMatchObject({
      ...metadata,
      capturedAt: expect.any(String),
      path: knife.images[1],
    })
    expect(
      await fs.readFile(
        path.join(vault.dataDir, 'images', knife.images[1]),
        'utf8',
      ),
    ).toBe('screenshot-bytes')
    const updated = await storage.updateKnife(knife.id, {
      images: [...knife.images].reverse(),
    })
    expect(updated.images).toEqual(knife.images)
    closeLocalDb()
    expect((await storage.getKnifeById(knife.id))?.webpageScreenshot).toEqual(
      knife.webpageScreenshot,
    )
    const removed = await storage.updateKnife(knife.id, {
      images: [knife.images[0]],
    })
    expect(removed.webpageScreenshot).toBeUndefined()
    await expect(
      fs.access(path.join(vault.dataDir, 'images', knife.images[1])),
    ).rejects.toThrow()
  })

  it('recaptures a screenshot whose file is missing without keeping the broken reference', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()
    const knife = await storage.createKnife({
      ...input,
      imageUrls: [...input.imageUrls, await draft()],
    })
    await fs.unlink(
      path.join(vault.dataDir, 'images', knife.webpageScreenshot!.path),
    )
    expect(
      (await storage.getKnifeById(knife.id))?.webpageScreenshot,
    ).toBeUndefined()
    rendered.mockResolvedValueOnce({ screenshot: await draft() })
    const repaired = await captureKnifeScreenshot(knife.id)
    expect(repaired.images).toHaveLength(2)
    expect(repaired.images).not.toContain(knife.webpageScreenshot!.path)
    expect(repaired.webpageScreenshot).toBeDefined()
  })

  it('seeds only existing source-linked items on upgrade and does not repopulate on restart', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()
    const old = await storage.createKnife(input)
    await storage.createKnife({ ...input, name: 'Manual', sourceUrl: '' })
    getLocalDb().exec(
      'DROP TABLE screenshot_backfill; DROP TABLE webpage_screenshots; PRAGMA user_version = 5;',
    )
    closeLocalDb()
    expect(getScreenshotBackfill()).toEqual([
      expect.objectContaining({ id: old.id, status: 'pending' }),
    ])
    await storage.createKnife({ ...input, name: 'Future item' })
    closeLocalDb()
    expect(getScreenshotBackfill()).toHaveLength(1)
  })

  it('backfills without replacing product data, is repeat-safe, and retries failures', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()
    const knife = await storage.createKnife(input)
    getLocalDb()
      .prepare('INSERT INTO screenshot_backfill(knife_id) VALUES (?)')
      .run(knife.id)
    rendered.mockResolvedValueOnce({ screenshotWarning: 'Website is offline' })
    await expect(processScreenshotBackfill(knife.id)).rejects.toThrow(
      'Website is offline',
    )
    expect(getScreenshotBackfill()[0]).toMatchObject({
      status: 'failed',
      error: 'Website is offline',
    })
    rendered.mockResolvedValueOnce({ screenshot: await draft() })
    await processScreenshotBackfill(knife.id)
    const updated = await storage.getKnifeById(knife.id)
    expect(updated).toMatchObject({
      name: knife.name,
      description: knife.description,
      sourceUrl: knife.sourceUrl,
    })
    expect(updated?.images).toHaveLength(2)
    expect(updated?.images[0]).toBe(knife.images[0])
    expect(getScreenshotBackfill()[0].status).toBe('completed')
    await processScreenshotBackfill(knife.id)
    await captureKnifeScreenshot(knife.id)
    expect(rendered).toHaveBeenCalledTimes(2)
  })

  it('retains concurrent edits and rejects a changed source URL', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()
    const knife = await storage.createKnife(input)
    rendered.mockImplementationOnce(async () => {
      await storage.updateKnife(knife.id, {
        description: 'Edited while capturing',
      })
      return { screenshot: await draft() }
    })
    const captured = await captureKnifeScreenshot(knife.id)
    expect(captured.description).toBe('Edited while capturing')
    rendered.mockImplementationOnce(async () => {
      await storage.updateKnife(knife.id, {
        sourceUrl: 'https://example.com/other',
      })
      return { screenshot: await draft() }
    })
    await expect(captureKnifeScreenshot(knife.id, true)).rejects.toThrow(
      'source URL changed',
    )
    expect(
      (await storage.getKnifeById(knife.id))?.webpageScreenshot?.path,
    ).toBe(captured.webpageScreenshot?.path)
  })

  it('replaces a capture only explicitly, recovers expired leases, and cleans abandoned drafts', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()
    const knife = await storage.createKnife(input)
    rendered.mockResolvedValueOnce({ screenshot: await draft() })
    const first = await captureKnifeScreenshot(knife.id)
    rendered.mockResolvedValueOnce({ screenshot: await draft() })
    const second = await captureKnifeScreenshot(knife.id, true)
    expect(second.images).toHaveLength(2)
    expect(second.webpageScreenshot?.path).not.toBe(
      first.webpageScreenshot?.path,
    )
    getLocalDb()
      .prepare(
        "INSERT INTO screenshot_backfill(knife_id, status, lease_until) VALUES (?, 'running', ?)",
      )
      .run(knife.id, Date.now() - 1)
    expect(getScreenshotBackfill()[0].status).toBe('pending')
    const abandoned = await draft()
    vi.useFakeTimers()
    vi.advanceTimersByTime(25 * 60 * 60 * 1000)
    await cleanupScreenshotDrafts()
    expect(getScreenshotMetadata([abandoned])).toBeUndefined()
    expect(getScreenshotMetadata(second.images)).toBeDefined()
    await expect(
      fs.access(path.join(vault.dataDir, 'images', second.images[1])),
    ).resolves.toBeUndefined()
  })
})
