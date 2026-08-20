import { createWriteStream } from 'fs'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import * as unzipper from 'unzipper'
import { ZipFile } from 'yazl'
import { afterEach, describe, expect, it } from 'vitest'
import * as localBackupRoute from '@/app/api/local-backup/archive/route'
import { getSettings, saveSettings } from '@/lib/settings'
import { LocalStorage } from '@/lib/storage/local'
import type { CreateKnifeInput } from '@/lib/storage/types'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault | null = null

const input: CreateKnifeInput = {
  name: 'Portable Backup Knife',
  brand: 'Maker',
  bladeStyle: 'Drop Point',
  handleMaterial: 'G10',
  imageUrls: ['data:image/png;base64,aGVsbG8='],
  specs: {
    weight: '',
    overallLength: '',
    bladeLength: '',
    country: 'USA',
  },
  customFields: { condition: 'Used' },
  description: '',
  sourceUrl: '',
  pinned: false,
}

async function removeSafetyBackups(dataDir: string) {
  const parentDir = path.dirname(dataDir)
  const prefix = `${path.basename(dataDir)}.before-restore-`
  const entries = await fs.readdir(parentDir)
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.bak'))
      .map((entry) =>
        fs.rm(path.join(parentDir, entry), { recursive: true, force: true }),
      ),
  )
}

async function createZip(
  entries: Array<{
    data?: Buffer | string
    name: string
    type?: 'directory' | 'file'
  }>,
): Promise<Buffer> {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'bladevault-test-zip-'),
  )
  const zipPath = path.join(tempRoot, 'backup.zip')

  try {
    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(zipPath)
      const archive = new ZipFile()
      output.on('close', resolve)
      output.on('error', reject)
      archive.outputStream.on('error', reject)
      archive.outputStream.pipe(output)

      for (const entry of entries) {
        if (entry.type === 'directory') {
          archive.addEmptyDirectory(entry.name)
        } else {
          archive.addBuffer(Buffer.from(entry.data ?? ''), entry.name)
        }
      }
      archive.end()
    })

    return await fs.readFile(zipPath)
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
}

afterEach(async () => {
  if (!vault) return
  const dataDir = vault.dataDir
  await vault.cleanup()
  await removeSafetyBackups(dataDir)
  vault = null
})

describe('local backup archive route', () => {
  it('exports, inspects, and restores the full portable vault', async () => {
    vault = await createTempVault('bladevault-local-backup-')
    let storage = new LocalStorage()
    const knife = await storage.createKnife(input)
    await storage.addToCompare(knife.id)
    saveSettings({ theme: 'dark' })

    const exported = await localBackupRoute.GET()
    expect(exported.status).toBe(200)
    expect(exported.headers.get('content-type')).toBe('application/zip')
    expect(exported.headers.get('content-disposition')).toMatch(
      /bladevault-backup-\d{4}-\d{2}-\d{2}\.zip/,
    )
    const archive = Buffer.from(await exported.arrayBuffer())
    const directory = await unzipper.Open.buffer(archive)
    const paths = directory.files.map((entry) => entry.path)
    expect(paths).toEqual(
      expect.arrayContaining([
        'manifest.json',
        'metadata.json',
        'database.sqlite',
        'images/',
        'images/portable-backup-knife/image-01.png',
      ]),
    )

    const manifestEntry = directory.files.find(
      (entry) => entry.path === 'manifest.json',
    )
    const manifest = JSON.parse(
      (await manifestEntry!.buffer()).toString('utf8'),
    ) as Record<string, unknown>
    expect(manifest).toMatchObject({
      formatVersion: 1,
      knifeCount: 1,
      imageCount: 1,
      schemaVersion: 2,
    })

    const inspected = await localBackupRoute.POST(
      new Request('http://localhost/api/local-backup/archive', {
        method: 'POST',
        body: archive,
      }),
    )
    expect(inspected.status).toBe(200)
    await expect(inspected.json()).resolves.toMatchObject({
      manifest: {
        formatVersion: 1,
        knifeCount: 1,
        imageCount: 1,
      },
    })
    expect(await storage.getKnifeById(knife.id)).not.toBeNull()

    await storage.deleteKnife(knife.id)
    saveSettings({ theme: 'light' })
    const restored = await localBackupRoute.PUT(
      new Request('http://localhost/api/local-backup/archive', {
        method: 'PUT',
        body: archive,
      }),
    )
    expect(restored.status).toBe(200)
    await expect(restored.json()).resolves.toMatchObject({
      manifest: { knifeCount: 1, imageCount: 1 },
      safetyBackupCreated: true,
    })

    storage = new LocalStorage()
    const restoredKnife = await storage.getKnifeById(knife.id)
    expect(restoredKnife).toMatchObject({
      customFields: { condition: 'Used' },
      images: ['portable-backup-knife/image-01.png'],
      name: 'Portable Backup Knife',
    })
    expect(await storage.getCompareList()).toEqual([knife.id])
    expect(getSettings().theme).toBe('dark')
    await expect(
      storage.getImage(restoredKnife?.images[0] ?? ''),
    ).resolves.toMatchObject({ contentType: 'image/png' })
  })

  it('rejects non-ZIP and incomplete archives without replacing the vault', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()
    const knife = await storage.createKnife(input)

    const plain = await localBackupRoute.PUT(
      new Request('http://localhost/api/local-backup/archive', {
        method: 'PUT',
        body: Buffer.from('not a zip'),
      }),
    )
    expect(plain.status).toBe(400)

    const incompleteArchive = await createZip([
      { name: 'metadata.json', data: '{}' },
      { name: 'images/', type: 'directory' },
    ])
    const incomplete = await localBackupRoute.POST(
      new Request('http://localhost/api/local-backup/archive', {
        method: 'POST',
        body: Uint8Array.from(incompleteArchive),
      }),
    )
    expect(incomplete.status).toBe(400)
    await expect(incomplete.json()).resolves.toMatchObject({
      error: expect.stringContaining('missing manifest.json'),
    })

    const exported = Buffer.from(
      await (await localBackupRoute.GET()).arrayBuffer(),
    )
    const directory = await unzipper.Open.buffer(exported)
    const imageEntry = directory.files.find(
      (entry) => entry.path === 'images/portable-backup-knife/image-01.png',
    )
    expect(imageEntry).toBeDefined()
    const localHeaderOffset = imageEntry!.offsetToLocalFileHeader
    const fileNameLength = exported.readUInt16LE(localHeaderOffset + 26)
    const extraFieldLength = exported.readUInt16LE(localHeaderOffset + 28)
    const imageDataOffset =
      localHeaderOffset + 30 + fileNameLength + extraFieldLength
    const corruptedArchive = Buffer.from(exported)
    corruptedArchive[
      imageDataOffset + Math.floor(imageEntry!.compressedSize / 2)
    ] ^= 0x01

    const corrupt = await localBackupRoute.PUT(
      new Request('http://localhost/api/local-backup/archive', {
        method: 'PUT',
        body: Uint8Array.from(corruptedArchive),
      }),
    )
    expect(corrupt.status).toBe(400)
    expect(await storage.getKnifeById(knife.id)).not.toBeNull()
  })

  it('rejects an incompatible manifest before changing local data', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()
    const knife = await storage.createKnife(input)
    const exported = Buffer.from(
      await (await localBackupRoute.GET()).arrayBuffer(),
    )
    const directory = await unzipper.Open.buffer(exported)
    const entries = await Promise.all(
      directory.files.map(async (entry) => {
        if (entry.type === 'Directory') {
          return { name: entry.path, type: 'directory' as const }
        }
        if (entry.path === 'manifest.json') {
          const manifest = JSON.parse(
            (await entry.buffer()).toString('utf8'),
          ) as Record<string, unknown>
          manifest.formatVersion = 99
          return {
            name: entry.path,
            type: 'file' as const,
            data: JSON.stringify(manifest),
          }
        }
        return {
          name: entry.path,
          type: 'file' as const,
          data: await entry.buffer(),
        }
      }),
    )
    const incompatibleArchive = await createZip(entries)

    const response = await localBackupRoute.PUT(
      new Request('http://localhost/api/local-backup/archive', {
        method: 'PUT',
        body: Uint8Array.from(incompatibleArchive),
      }),
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('Backup format 99'),
    })
    expect(await storage.getKnifeById(knife.id)).not.toBeNull()
  })
})
