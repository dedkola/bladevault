import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import * as tar from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import * as archiveRoute from '@/app/api/cloud-backup/archive/route'
import { closeLocalDb } from '@/lib/local-db'
import { getSettings, saveSettings } from '@/lib/settings'
import { LocalStorage } from '@/lib/storage/local'
import type { CreateKnifeInput } from '@/lib/storage/types'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault | null = null

const input: CreateKnifeInput = {
  name: 'Backup Knife',
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

afterEach(async () => {
  await vault?.cleanup()
  vault = null
})

describe('backup archive route', () => {
  it('round-trips the database, settings, compare state, and images', async () => {
    vault = await createTempVault('bladevault-source-')
    let storage = new LocalStorage()
    const knife = await storage.createKnife(input)
    await storage.addToCompare(knife.id)
    saveSettings({ theme: 'dark', timeFormat: '24h' })

    const exported = await archiveRoute.GET()
    expect(exported.status).toBe(200)
    expect(exported.headers.get('content-type')).toBe('application/gzip')
    const archive = await exported.arrayBuffer()

    await storage.deleteKnife(knife.id)
    saveSettings({ theme: 'light', timeFormat: '12h' })

    const restored = await archiveRoute.PUT(
      new Request('http://localhost/api/cloud-backup/archive', {
        method: 'PUT',
        body: archive,
      }),
    )
    expect(restored.status).toBe(200)

    storage = new LocalStorage()
    const restoredKnife = await storage.getKnifeById(knife.id)
    expect(restoredKnife).toMatchObject({
      name: 'Backup Knife',
      customFields: { condition: 'Used' },
      images: ['backup-knife/image-01.png'],
    })
    expect(await storage.getCompareList()).toEqual([knife.id])
    expect(getSettings().theme).toBe('dark')
    expect(getSettings().timeFormat).toBe('24h')
    await expect(
      storage.getImage(restoredKnife?.images[0] ?? ''),
    ).resolves.toMatchObject({
      contentType: 'image/png',
    })
  })

  it('restores an archive into a differently named data directory', async () => {
    vault = await createTempVault('bladevault-export-name-')
    const sourceStorage = new LocalStorage()
    const knife = await sourceStorage.createKnife(input)
    await sourceStorage.addMaintenanceEvent(knife.id, {
      type: 'cleaning',
      occurredAt: '2026-08-21T09:30:00.000Z',
      notes: 'Portable maintenance record',
    })
    const archive = await (await archiveRoute.GET()).arrayBuffer()

    await vault.cleanup()
    vault = await createTempVault('bladevault-import-different-name-')

    const restored = await archiveRoute.PUT(
      new Request('http://localhost/api/cloud-backup/archive', {
        method: 'PUT',
        body: archive,
      }),
    )
    expect(restored.status).toBe(200)
    const restoredStorage = new LocalStorage()
    expect(
      (await restoredStorage.getAllKnives()).map((knife) => knife.id),
    ).toEqual(['backup-knife'])
    await expect(
      restoredStorage.getMaintenanceEvents(knife.id),
    ).resolves.toEqual([
      expect.objectContaining({
        knifeId: knife.id,
        type: 'cleaning',
        notes: 'Portable maintenance record',
      }),
    ])
    expect(await restoredStorage.getKnifeActivity()).toContainEqual(
      expect.objectContaining({ knifeId: knife.id, type: 'maintained' }),
    )
    expect(await restoredStorage.getAuditLog()).toContainEqual(
      expect.objectContaining({
        knifeId: knife.id,
        source: 'Maintenance',
        summary: 'Cleaning was logged.',
      }),
    )
  })

  it('removes stale SQLite sidecars before opening a restored database', async () => {
    vault = await createTempVault('bladevault-stale-sidecars-')
    const storage = new LocalStorage()
    await storage.createKnife(input)
    const archive = await (await archiveRoute.GET()).arrayBuffer()

    closeLocalDb()
    const staleSidecar = Buffer.alloc(32, 0xff)
    await fs.writeFile(
      path.join(vault.dataDir, 'bladevault.sqlite-wal'),
      staleSidecar,
    )
    await fs.writeFile(
      path.join(vault.dataDir, 'bladevault.sqlite-shm'),
      staleSidecar,
    )

    const restored = await archiveRoute.PUT(
      new Request('http://localhost/api/cloud-backup/archive', {
        method: 'PUT',
        body: archive,
      }),
    )

    expect(restored.status).toBe(200)
    const walAfterRestore = await fs
      .readFile(path.join(vault.dataDir, 'bladevault.sqlite-wal'))
      .catch(() => null)
    const shmAfterRestore = await fs
      .readFile(path.join(vault.dataDir, 'bladevault.sqlite-shm'))
      .catch(() => null)
    expect(walAfterRestore).not.toEqual(staleSidecar)
    expect(shmAfterRestore).not.toEqual(staleSidecar)
    await expect(new LocalStorage().getAllKnives()).resolves.toHaveLength(1)
  })

  it('rejects empty, non-gzip, and corrupt archives without replacing the vault', async () => {
    vault = await createTempVault()
    await new LocalStorage().createKnife(input)

    const empty = await archiveRoute.PUT(
      new Request('http://localhost/api/cloud-backup/archive', {
        method: 'PUT',
        body: new Uint8Array(),
      }),
    )
    expect(empty.status).toBe(400)

    const plain = await archiveRoute.PUT(
      new Request('http://localhost/api/cloud-backup/archive', {
        method: 'PUT',
        body: Buffer.from('not an archive'),
      }),
    )
    expect(plain.status).toBe(400)

    const corrupt = await archiveRoute.PUT(
      new Request('http://localhost/api/cloud-backup/archive', {
        method: 'PUT',
        body: Buffer.from([0x1f, 0x8b, 0x00, 0x00]),
      }),
    )
    expect(corrupt.status).toBe(500)
    expect(
      (await new LocalStorage().getAllKnives()).map((knife) => knife.id),
    ).toEqual(['backup-knife'])
  })

  it('rejects archive entries that escape the top-level data directory', async () => {
    vault = await createTempVault()
    await new LocalStorage().createKnife(input)
    const archiveRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'bladevault-unsafe-archive-'),
    )

    try {
      await fs.writeFile(path.join(archiveRoot, 'payload'), 'unsafe')
      const archivePath = path.join(archiveRoot, 'unsafe.tar.gz')
      await tar.create(
        {
          cwd: archiveRoot,
          file: archivePath,
          gzip: true,
          prefix: '../escape',
        },
        ['payload'],
      )

      const response = await archiveRoute.PUT(
        new Request('http://localhost/api/cloud-backup/archive', {
          method: 'PUT',
          body: await fs.readFile(archivePath),
        }),
      )

      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining('Unsafe backup archive entry'),
      })
      expect(
        (await new LocalStorage().getAllKnives()).map((knife) => knife.id),
      ).toEqual(['backup-knife'])
    } finally {
      await fs.rm(archiveRoot, { recursive: true, force: true })
    }
  })
})
