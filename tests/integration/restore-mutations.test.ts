import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as knivesRoute from '@/app/api/knives/route'
import * as appLockRoute from '@/app/api/app-lock/route'
import { closeLocalDb, getLocalDb } from '@/lib/local-db'
import { replaceLocalDataFromDirectory } from '@/lib/local-data-restore'
import { getSettings, saveSettings } from '@/lib/settings'
import { mutateComparison } from '@/lib/comparison-storage'
import { saveSmartCollection } from '@/lib/smart-collections-storage'
import { LocalStorage } from '@/lib/storage/local'
import { getStorage } from '@/lib/storage'
import type { CreateKnifeInput } from '@/lib/storage/types'
import {
  bulkUpdateKnifeMetadata,
  proposeKnifeChanges,
  updateKnifeMetadata,
} from '@/lib/services/knife-service'
import {
  addMaintenanceEvent,
  deleteMaintenanceEvent,
  updateMaintenanceEvent,
} from '@/lib/services/maintenance-service'
import {
  acquireVaultRestore,
  getVaultAccessState,
  getVaultControlDir,
  getVaultGeneration,
  VAULT_GENERATION_HEADER,
  type VaultRestoreLease,
} from '@/lib/vault-access'
import {
  cleanupScreenshotDrafts,
  promoteScreenshotDraft,
  saveScreenshotDraft,
} from '@/lib/webpage-screenshot-store'
import { getScreenshotBackfill } from '@/lib/webpage-screenshot-service'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault | null = null
const temporaryDirectories: string[] = []
const releasePauses: Array<() => void> = []
const pendingOperations: Promise<unknown>[] = []
const restoreLeases: VaultRestoreLease[] = []

const image = (bytes: string) =>
  `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
const input: CreateKnifeInput = {
  name: 'Shared Item',
  brand: 'Snapshot Brand',
  bladeStyle: 'Drop Point',
  handleMaterial: 'Snapshot Handle',
  description: 'Snapshot description',
  sourceUrl: '',
  specs: { weight: '', overallLength: '', bladeLength: '', country: '' },
  customFields: {},
  pinned: false,
  imageUrls: [image('snapshot image 1'), image('snapshot image 2')],
}

function pause() {
  let entered!: () => void
  let release!: () => void
  const reached = new Promise<void>((resolve) => {
    entered = resolve
  })
  const resumed = new Promise<void>((resolve) => {
    release = resolve
  })
  releasePauses.push(release)
  return { entered, release, reached, resumed }
}

async function snapshot() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'bladevault-restore-snapshot-'),
  )
  temporaryDirectories.push(directory)
  closeLocalDb()
  await fs.cp(vault!.dataDir, directory, { recursive: true })
  return directory
}

afterEach(async () => {
  for (const release of releasePauses.splice(0)) release()
  for (const lease of restoreLeases.splice(0)) lease.release()
  await Promise.allSettled(pendingOperations.splice(0))
  vi.restoreAllMocks()
  if (vault) {
    const dataDir = vault.dataDir
    await vault.cleanup()
    vault = null
    await fs.rm(getVaultControlDir(dataDir), { recursive: true, force: true })
    const prefix = `${path.basename(dataDir)}.before-restore-`
    for (const entry of await fs.readdir(path.dirname(dataDir))) {
      if (entry.startsWith(prefix) && entry.endsWith('.bak'))
        await fs.rm(path.join(path.dirname(dataDir), entry), {
          recursive: true,
          force: true,
        })
    }
  }
  for (const directory of temporaryDirectories.splice(0))
    await fs.rm(directory, { recursive: true, force: true })
})

describe('restore mutation safety', () => {
  it.each(['metadata update', 'bulk apply', 'maintenance add'])(
    'drains a paused %s service from its first record read through its commit',
    async (kind) => {
      vault = await createTempVault('bladevault-restore-service-')
      const storage = getStorage()
      const knife = await storage.createKnife(input)
      const source = await snapshot()
      const items = [
        {
          knifeId: knife.id,
          expectedUpdatedAt: knife.updatedAt,
          changes: [{ field: 'brand', value: 'Pending MCP change' }],
        },
      ]
      const preview = await bulkUpdateKnifeMetadata({
        items,
        transport: 'stdio',
      })
      const blocked = pause()
      const readKnife = storage.getKnifeById.bind(storage)
      vi.spyOn(storage, 'getKnifeById').mockImplementationOnce(async (id) => {
        const before = await readKnife(id)
        blocked.entered()
        await blocked.resumed
        return before
      })
      const mutating =
        kind === 'metadata update'
          ? updateKnifeMetadata({
              knifeId: knife.id,
              expectedUpdatedAt: knife.updatedAt,
              changes: items[0].changes,
              transport: 'stdio',
            })
          : kind === 'bulk apply'
            ? bulkUpdateKnifeMetadata({
                items,
                apply: true,
                previewHash: preview.previewHash,
                transport: 'stdio',
              })
            : addMaintenanceEvent({
                knifeId: knife.id,
                type: 'cleaning',
                origin: 'mcp',
                notes: 'Pending maintenance',
              })
      pendingOperations.push(mutating)
      await blocked.reached
      let restored = false
      const restoring = replaceLocalDataFromDirectory(source).then((result) => {
        restored = true
        return result
      })
      pendingOperations.push(restoring)
      await expect.poll(() => getVaultAccessState().phase).toBe('preparing')
      expect(restored).toBe(false)
      blocked.release()
      await mutating
      await restoring
      await expect(storage.getKnifeById(knife.id)).resolves.toMatchObject({
        brand: 'Snapshot Brand',
        updatedAt: knife.updatedAt,
      })
      await expect(storage.getMaintenanceEvents(knife.id)).resolves.toEqual([])
    },
  )

  it.each(['update', 'delete'])(
    'drains a paused maintenance %s service before restoring its original event',
    async (kind) => {
      vault = await createTempVault('bladevault-restore-maintenance-service-')
      const storage = getStorage()
      const knife = await storage.createKnife(input)
      const event = await storage.addMaintenanceEvent(knife.id, {
        type: 'cleaning',
        occurredAt: '2026-10-01T10:00:00.000Z',
        notes: 'Snapshot notes',
      })
      const source = await snapshot()
      const blocked = pause()
      const readEvents = storage.getMaintenanceEvents.bind(storage)
      vi.spyOn(storage, 'getMaintenanceEvents').mockImplementationOnce(
        async (id) => {
          const before = await readEvents(id)
          blocked.entered()
          await blocked.resumed
          return before
        },
      )
      const mutating =
        kind === 'update'
          ? updateMaintenanceEvent({
              knifeId: knife.id,
              eventId: event.id,
              notes: 'Pending maintenance edit',
            })
          : deleteMaintenanceEvent(knife.id, event.id)
      pendingOperations.push(mutating)
      await blocked.reached
      const restoring = replaceLocalDataFromDirectory(source)
      pendingOperations.push(restoring)
      await expect.poll(() => getVaultAccessState().phase).toBe('preparing')
      blocked.release()
      await mutating
      await restoring
      await expect(storage.getMaintenanceEvents(knife.id)).resolves.toEqual([
        expect.objectContaining({ id: event.id, notes: 'Snapshot notes' }),
      ])
    },
  )

  it('keeps proposals and bulk previews readable while rejecting mutating service entry', async () => {
    vault = await createTempVault('bladevault-restore-service-readonly-')
    const storage = getStorage()
    const knife = await storage.createKnife(input)
    const read = vi.spyOn(storage, 'getKnifeById')
    restoreLeases.push(acquireVaultRestore())
    const items = [
      {
        knifeId: knife.id,
        expectedUpdatedAt: knife.updatedAt,
        changes: [{ field: 'brand', value: 'Proposed Brand' }],
      },
    ]
    await expect(
      updateKnifeMetadata({
        ...items[0],
        transport: 'stdio',
        expectedUpdatedAt: knife.updatedAt,
      }),
    ).rejects.toMatchObject({ code: 'VAULT_RESTORE_BUSY' })
    await expect(
      bulkUpdateKnifeMetadata({
        items,
        apply: true,
        previewHash: 'unused',
        transport: 'stdio',
      }),
    ).rejects.toMatchObject({ code: 'VAULT_RESTORE_BUSY' })
    await expect(
      addMaintenanceEvent({
        knifeId: knife.id,
        type: 'cleaning',
        origin: 'mcp',
      }),
    ).rejects.toMatchObject({ code: 'VAULT_RESTORE_BUSY' })
    expect(read).not.toHaveBeenCalled()
    await expect(
      proposeKnifeChanges([
        {
          knifeId: knife.id,
          field: 'brand',
          proposedValue: 'Proposed Brand',
          reason: 'Review only',
        },
      ]),
    ).resolves.toMatchObject({ validCount: 1 })
    await expect(
      bulkUpdateKnifeMetadata({ items, transport: 'stdio' }),
    ).resolves.toMatchObject({ applied: false, validCount: 1 })
    await expect(storage.getKnifeById(knife.id)).resolves.toMatchObject({
      brand: 'Snapshot Brand',
    })
  })

  it('rejects delayed lock configuration after restore even without a generation header', async () => {
    vault = await createTempVault('bladevault-restore-lock-request-')
    await new LocalStorage().createKnife(input)
    const source = await snapshot()
    const blocked = pause()
    const request = new Request('http://localhost/api/app-lock', {
      method: 'POST',
    })
    vi.spyOn(request, 'json').mockImplementation(async () => {
      blocked.entered()
      await blocked.resumed
      return {
        action: 'set-password',
        password: 'pending-password',
        confirmPassword: 'pending-password',
      }
    })
    const configuring = appLockRoute.POST(request)
    pendingOperations.push(configuring)
    await blocked.reached
    await replaceLocalDataFromDirectory(source)
    blocked.release()
    const response = await configuring
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'VAULT_CHANGED' })
    expect(
      getLocalDb()
        .prepare("SELECT value FROM settings WHERE key = 'app_lock_password'")
        .get(),
    ).toBeUndefined()
  })

  it('drains a request whose JSON body is still loading before installing a restore', async () => {
    vault = await createTempVault('bladevault-restore-request-')
    const storage = new LocalStorage()
    await storage.createKnife(input)
    const source = await snapshot()
    const blocked = pause()
    const request = new Request('http://localhost/api/knives', {
      method: 'POST',
      headers: { [VAULT_GENERATION_HEADER]: getVaultGeneration() },
    })
    vi.spyOn(request, 'json').mockImplementation(async () => {
      blocked.entered()
      await blocked.resumed
      return { ...input, name: 'Delayed Request Item' }
    })
    const creating = knivesRoute.POST(request)
    pendingOperations.push(creating)
    await blocked.reached
    let restored = false
    const restoring = replaceLocalDataFromDirectory(source).then((result) => {
      restored = true
      return result
    })
    pendingOperations.push(restoring)
    await expect.poll(() => getVaultAccessState().phase).toBe('preparing')
    expect(restored).toBe(false)
    blocked.release()
    const response = await creating
    expect(response.status).toBe(200)
    const { knife } = await response.json()
    expect(knife.images).toHaveLength(2)
    await restoring
    await expect(storage.getKnifeById(knife.id)).resolves.toBeUndefined()
  })

  it('rejects an old-generation request before reading its body after restore completes', async () => {
    vault = await createTempVault('bladevault-restore-stale-request-')
    const storage = new LocalStorage()
    await storage.createKnife(input)
    const source = await snapshot()
    const generation = getVaultGeneration()
    await replaceLocalDataFromDirectory(source)
    const request = new Request('http://localhost/api/knives', {
      method: 'POST',
      headers: { [VAULT_GENERATION_HEADER]: generation },
      body: JSON.stringify({ ...input, name: 'Stale Request Item' }),
    })
    const readBody = vi.spyOn(request, 'json')
    const response = await knivesRoute.POST(request)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'VAULT_CHANGED' })
    expect(readBody).not.toHaveBeenCalled()
    await expect(storage.getAllKnives()).resolves.toHaveLength(1)
  })

  it('allows an existing writer to finish nested image writes after preparation starts', async () => {
    vault = await createTempVault('bladevault-restore-nested-')
    const storage = new LocalStorage()
    const blocked = pause()
    const uniqueId = storage.ensureUniqueId.bind(storage)
    vi.spyOn(storage, 'ensureUniqueId').mockImplementation(async (id) => {
      const result = await uniqueId(id)
      blocked.entered()
      await blocked.resumed
      return result
    })
    const creating = storage.createKnife({
      ...input,
      imageUrls: [image('nested image bytes')],
    })
    pendingOperations.push(creating)
    await blocked.reached
    const lease = acquireVaultRestore()
    restoreLeases.push(lease)
    let drained = false
    const draining = lease.waitForWriters().then(() => {
      drained = true
    })
    pendingOperations.push(draining)
    expect(drained).toBe(false)
    blocked.release()
    const created = await creating
    await draining
    expect(created.images).toHaveLength(1)
    expect(
      await fs.readFile(
        path.join(vault.dataDir, 'images', created.images[0]),
        'utf8',
      ),
    ).toBe('nested image bytes')
  })

  it.each([false, true])(
    'drains an image update before replacing snapshot fields and bytes (version check: %s)',
    async (versionChecked) => {
      vault = await createTempVault('bladevault-restore-update-')
      const storage = new LocalStorage()
      const original = await storage.createKnife(input)
      const source = await snapshot()
      const live = await storage.updateKnife(original.id, {
        brand: 'Live Brand',
        handleMaterial: 'Live Handle',
        images: [original.images[0]],
      })
      const blocked = pause()
      const writeFile = fs.writeFile.bind(fs)
      vi.spyOn(fs, 'writeFile').mockImplementation(
        async (file, data, options) => {
          if (path.basename(String(file)).startsWith('._bladevault-image-')) {
            blocked.entered()
            await blocked.resumed
          }
          return writeFile(file, data, options)
        },
      )
      const updating = storage.updateKnife(
        original.id,
        {
          description: 'Pending old-vault edit',
          images: [live.images[0], image('pending image 2')],
        },
        versionChecked ? { expectedUpdatedAt: live.updatedAt } : {},
      )
      pendingOperations.push(updating)
      await blocked.reached
      let restored = false
      const restoring = replaceLocalDataFromDirectory(source).then((result) => {
        restored = true
        return result
      })
      pendingOperations.push(restoring)
      await expect.poll(() => getVaultAccessState().phase).toBe('preparing')
      expect(restored).toBe(false)
      await expect(storage.getKnifeById(original.id)).resolves.toMatchObject({
        brand: 'Live Brand',
      })
      await expect(storage.createKnife(input)).rejects.toMatchObject({
        code: 'VAULT_RESTORE_BUSY',
      })
      blocked.release()
      await updating
      await restoring
      await expect(storage.getKnifeById(original.id)).resolves.toMatchObject({
        brand: 'Snapshot Brand',
        handleMaterial: 'Snapshot Handle',
        description: 'Snapshot description',
        images: original.images,
      })
      expect(
        await fs.readFile(
          path.join(vault.dataDir, 'images', original.images[1]),
          'utf8',
        ),
      ).toBe('snapshot image 2')
      expect(getLocalDb().pragma('integrity_check', { simple: true })).toBe(
        'ok',
      )
    },
  )

  it('finishes a pending create before restore so it cannot reappear afterward', async () => {
    vault = await createTempVault('bladevault-restore-create-')
    const storage = new LocalStorage()
    await storage.createKnife(input)
    const source = await snapshot()
    const blocked = pause()
    const writeFile = fs.writeFile.bind(fs)
    vi.spyOn(fs, 'writeFile').mockImplementation(
      async (file, data, options) => {
        if (path.basename(String(file)).startsWith('._bladevault-image-')) {
          blocked.entered()
          await blocked.resumed
        }
        return writeFile(file, data, options)
      },
    )
    const creating = storage.createKnife({
      ...input,
      name: 'Pending New Item',
      imageUrls: [image('pending create image')],
    })
    pendingOperations.push(creating)
    await blocked.reached
    const restoring = replaceLocalDataFromDirectory(source)
    pendingOperations.push(restoring)
    await expect.poll(() => getVaultAccessState().phase).toBe('preparing')
    blocked.release()
    const created = await creating
    await restoring
    await expect(storage.getKnifeById(created.id)).resolves.toBeUndefined()
    await expect(
      fs.access(path.join(vault.dataDir, 'images', created.id)),
    ).rejects.toThrow()
  })

  it('drains deletion file cleanup before restoring the same item directory', async () => {
    vault = await createTempVault('bladevault-restore-delete-')
    const storage = new LocalStorage()
    const original = await storage.createKnife(input)
    const source = await snapshot()
    const blocked = pause()
    const remove = fs.rm.bind(fs)
    const imageDirectory = path.join(vault.dataDir, 'images', original.id)
    vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
      if (String(file) === imageDirectory) {
        blocked.entered()
        await blocked.resumed
      }
      return remove(file, options)
    })
    const deleting = storage.deleteKnife(original.id)
    pendingOperations.push(deleting)
    await blocked.reached
    const restoring = replaceLocalDataFromDirectory(source)
    pendingOperations.push(restoring)
    await expect.poll(() => getVaultAccessState().phase).toBe('preparing')
    blocked.release()
    await deleting
    await restoring
    await expect(storage.getKnifeById(original.id)).resolves.toBeDefined()
    expect(
      await fs.readFile(
        path.join(vault.dataDir, 'images', original.images[0]),
        'utf8',
      ),
    ).toBe('snapshot image 1')
  })

  it('rejects new mutations before any image or screenshot file changes while reads continue', async () => {
    vault = await createTempVault('bladevault-restore-readonly-')
    const storage = new LocalStorage()
    const knife = await storage.createKnife(input)
    const draft = await saveScreenshotDraft(Buffer.from('draft bytes'), {
      sourceUrl: 'https://example.com/item',
      capturedAt: new Date().toISOString(),
      width: 100,
      height: 200,
    })
    getLocalDb()
      .prepare(
        "INSERT INTO screenshot_backfill(knife_id, status, lease_until) VALUES (?, 'running', ?)",
      )
      .run(knife.id, Date.now() - 1)
    const writeFile = vi.spyOn(fs, 'writeFile')
    const mkdir = vi.spyOn(fs, 'mkdir')
    const remove = vi.spyOn(fs, 'rm')
    const unlink = vi.spyOn(fs, 'unlink')
    restoreLeases.push(acquireVaultRestore())
    const busy = { code: 'VAULT_RESTORE_BUSY' }
    await expect(storage.createKnife(input)).rejects.toMatchObject(busy)
    await expect(
      storage.updateKnife(knife.id, { images: [image('new bytes')] }),
    ).rejects.toMatchObject(busy)
    await expect(storage.deleteKnife(knife.id)).rejects.toMatchObject(busy)
    await expect(
      storage.saveDataUrl(image('new bytes'), knife.id, 0),
    ).rejects.toMatchObject(busy)
    await expect(
      storage.downloadImage('https://example.com/image.png', knife.id, 0),
    ).rejects.toMatchObject(busy)
    await expect(
      saveScreenshotDraft(Buffer.from('new bytes'), {
        sourceUrl: 'https://example.com/item',
        capturedAt: new Date().toISOString(),
        width: 100,
        height: 200,
      }),
    ).rejects.toMatchObject(busy)
    await expect(promoteScreenshotDraft(draft, knife.id)).rejects.toMatchObject(
      busy,
    )
    await expect(cleanupScreenshotDrafts()).rejects.toMatchObject(busy)
    expect(() => saveSettings({ theme: 'dark' })).toThrow(/read-only/)
    expect(() =>
      mutateComparison({ action: 'create', name: 'Blocked', ids: [knife.id] }),
    ).toThrow(/read-only/)
    expect(() =>
      saveSmartCollection({ name: 'Blocked', query: 'maker' }),
    ).toThrow(/read-only/)
    await expect(storage.getAllKnives()).resolves.toHaveLength(1)
    expect(getSettings().theme).toBe('light')
    expect(getScreenshotBackfill()).toEqual([
      expect.objectContaining({ id: knife.id, status: 'running' }),
    ])
    expect(writeFile).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(unlink).not.toHaveBeenCalled()
  })
})
