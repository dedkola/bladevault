import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as jobRoute from '@/app/api/cloud-backup/job/route'
import * as archiveRoute from '@/app/api/cloud-backup/archive/route'
import {
  getCloudBackupJobState,
  startCloudBackupJob,
} from '@/lib/cloud-backup-job'
import { IDLE_CLOUD_BACKUP_JOB } from '@/lib/cloud-backup-shared'
import { setAppLockPassword } from '@/lib/app-lock'
import { getLocalDb } from '@/lib/local-db'
import { getSettings, saveSettings } from '@/lib/settings'
import { LocalStorage } from '@/lib/storage/local'
import type { CreateKnifeInput } from '@/lib/storage/types'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

// Google Drive transport is covered by drive-backup.test.ts; these tests focus
// on the snapshot archive the job builds and hands to the upload.
const { isDriveConnected, uploadDriveBackup } = vi.hoisted(() => ({
  isDriveConnected: vi.fn(),
  uploadDriveBackup: vi.fn(),
}))

vi.mock('@/lib/drive-backup', () => ({ isDriveConnected, uploadDriveBackup }))

let vault: TempVault
let temporaryDirectories: string[]
const input: CreateKnifeInput = {
  name: 'Background Knife',
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
  customFields: {},
  description: '',
  sourceUrl: '',
  pinned: false,
  sold: false,
}

function request(signal?: AbortSignal) {
  return new Request('http://localhost/api/cloud-backup/job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    signal,
  })
}

function stubDriveUpload(
  upload: (archive: Buffer) => Promise<void>,
  beforeUpload?: () => Promise<void>,
) {
  uploadDriveBackup.mockImplementation(
    async (archivePath: string, dataDir: string) => {
      expect(dataDir).toBe(vault.dataDir)
      expect(getCloudBackupJobState().phase).toBe('uploading')
      // The full archive exists before the upload starts.
      expect(path.dirname(archivePath)).toBe(temporaryDirectories.at(-1))
      await beforeUpload?.()
      await upload(await fs.readFile(archivePath))
    },
  )
}

async function waitForJob(status: 'success' | 'error') {
  await vi.waitFor(() => {
    expect(getCloudBackupJobState().status).toBe(status)
  })
  return getCloudBackupJobState()
}

async function expectTemporaryFilesRemoved() {
  expect(temporaryDirectories).toHaveLength(1)
  await expect(fs.stat(temporaryDirectories[0])).rejects.toMatchObject({
    code: 'ENOENT',
  })
}

beforeEach(async () => {
  vault = await createTempVault('bladevault-background-source-')
  temporaryDirectories = []
  isDriveConnected.mockReset().mockResolvedValue(true)
  uploadDriveBackup.mockReset()
  const mkdtemp = fs.mkdtemp.bind(fs)
  vi.spyOn(fs, 'mkdtemp').mockImplementation(async (prefix) => {
    const directory = await mkdtemp(prefix)
    if (String(prefix).includes('bladevault-cloud-job-')) {
      temporaryDirectories.push(directory)
    }
    return directory
  })
})

afterEach(async () => {
  await vault.cleanup()
  vi.unstubAllGlobals()
})

describe('server-owned cloud backup job', () => {
  it('keeps running after request abort, deduplicates starts, and restores its online snapshot', async () => {
    const storage = new LocalStorage()
    const knife = await storage.createKnife(input)
    saveSettings({ theme: 'dark' })
    await fs.mkdir(path.join(vault.dataDir, '__webpage_drafts'))
    await fs.writeFile(
      path.join(vault.dataDir, '__webpage_drafts', 'draft.txt'),
      'draft',
    )

    const database = getLocalDb()
    const backup = database.backup.bind(database)
    let editedDuringSnapshot = false
    vi.spyOn(database, 'backup').mockImplementation((destination, options) =>
      backup(destination, {
        ...options,
        progress: (progress) => {
          if (!editedDuringSnapshot) {
            database
              .prepare('UPDATE knives SET brand = ? WHERE id = ?')
              .run('Edited during snapshot', knife.id)
            editedDuringSnapshot = true
          }
          return options?.progress?.(progress) ?? 100
        },
      }),
    )

    let uploaded: Buffer | null = null
    let completeUpload!: () => void
    const uploadGate = new Promise<void>((resolve) => {
      completeUpload = resolve
    })
    stubDriveUpload(async (archive) => {
      uploaded = archive
      await uploadGate
    })

    const controller = new AbortController()
    const startedResponse = await jobRoute.POST(request(controller.signal))
    const started = (await startedResponse.json()).job
    expect(startedResponse.status).toBe(202)
    expect(started).toMatchObject({ status: 'running', phase: 'preparing' })
    expect(started.id).toEqual(expect.any(String))
    controller.abort()

    const duplicate = await jobRoute.POST(request())
    const duplicateData = await duplicate.json()
    expect(duplicateData.job.id).toBe(started.id)
    expect(duplicateData.started).toBe(false)
    await vi.waitFor(() => {
      expect(uploaded).not.toBeNull()
    })
    expect(uploadDriveBackup).toHaveBeenCalledTimes(1)
    expect(database.open).toBe(true)
    expect(editedDuringSnapshot).toBe(true)
    await storage.updateKnife(knife.id, { brand: 'Edited during upload' })
    expect((await storage.getKnifeById(knife.id))?.brand).toBe(
      'Edited during upload',
    )

    const runningResponse = await jobRoute.GET(
      new Request('http://localhost/api/cloud-backup/job'),
    )
    expect(runningResponse.headers.get('cache-control')).toBe('no-store')
    expect((await runningResponse.json()).job).toMatchObject({
      id: started.id,
      status: 'running',
      phase: 'uploading',
    })

    completeUpload()
    await waitForJob('success')
    await expectTemporaryFilesRemoved()

    const restored = await archiveRoute.PUT(
      new Request('http://localhost/api/cloud-backup/archive', {
        method: 'PUT',
        body: new Uint8Array(uploaded!),
      }),
    )
    expect(restored.status).toBe(200)
    expect(getLocalDb().pragma('integrity_check', { simple: true })).toBe('ok')
    const restoredKnife = await new LocalStorage().getKnifeById(knife.id)
    expect(restoredKnife?.brand).toBe('Edited during snapshot')
    expect(getSettings().theme).toBe('dark')
    await expect(
      fs.stat(path.join(vault.dataDir, '__webpage_drafts')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      new LocalStorage().getImage(restoredKnife!.images[0]),
    ).resolves.toMatchObject({ contentType: 'image/png' })
  })

  it('cleans up a rejected upload and can retry', async () => {
    const upload = vi.fn(async (): Promise<void> => {
      throw new Error('Google Drive upload failed (503).')
    })
    stubDriveUpload(upload)
    const first = startCloudBackupJob()
    const failed = await waitForJob('error')
    expect(failed).toMatchObject({
      id: first.id,
      phase: null,
      message: 'Google Drive upload failed (503).',
    })
    await expectTemporaryFilesRemoved()

    upload.mockImplementationOnce(async () => {})
    const retry = startCloudBackupJob()
    expect(retry.id).not.toBe(first.id)
    await waitForJob('success')
    expect(upload).toHaveBeenCalledTimes(2)
  })

  it.each(['delete', 'replace'] as const)(
    'restores all snapshot images after a concurrent %s once staging finishes',
    async (mutation) => {
      const storage = new LocalStorage()
      const knife = await storage.createKnife(input)
      const originalImage = await fs.readFile(
        path.join(vault.dataDir, 'images', knife.images[0]),
      )
      let mutated = false
      let uploaded: Buffer | null = null
      stubDriveUpload(
        async (archive) => {
          uploaded = archive
        },
        async () => {
          mutated = true
          if (mutation === 'delete') {
            await storage.deleteKnife(knife.id)
          } else {
            await storage.updateKnife(knife.id, {
              images: ['data:image/png;base64,cmVwbGFjZWQ='],
            })
          }
        },
      )

      startCloudBackupJob()
      await waitForJob('success')
      expect(mutated).toBe(true)
      await expect(
        fs.stat(path.join(vault.dataDir, 'images', knife.images[0])),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      const restored = await archiveRoute.PUT(
        new Request('http://localhost/api/cloud-backup/archive', {
          method: 'PUT',
          body: new Uint8Array(uploaded!),
        }),
      )
      expect(restored.status).toBe(200)
      const restoredKnife = await new LocalStorage().getKnifeById(knife.id)
      expect(restoredKnife?.images).toEqual(knife.images)
      await expect(
        fs.readFile(path.join(vault.dataDir, 'images', knife.images[0])),
      ).resolves.toEqual(originalImage)
      await expectTemporaryFilesRemoved()
    },
  )

  it('restarts a fresh database snapshot when a referenced image is deleted before staging', async () => {
    const storage = new LocalStorage()
    const knife = await storage.createKnife(input)
    const database = getLocalDb()
    const backup = database.backup.bind(database)
    let attempts = 0
    vi.spyOn(database, 'backup').mockImplementation(
      async (destination, options) => {
        const result = await backup(destination, options)
        attempts += 1
        if (attempts === 1) await storage.deleteKnife(knife.id)
        return result
      },
    )
    let uploaded: Buffer | null = null
    stubDriveUpload(async (archive) => {
      uploaded = archive
    })
    startCloudBackupJob()
    await waitForJob('success')
    expect(attempts).toBe(2)
    const restored = await archiveRoute.PUT(
      new Request('http://localhost/api/cloud-backup/archive', {
        method: 'PUT',
        body: new Uint8Array(uploaded!),
      }),
    )
    expect(restored.status).toBe(200)
    expect(await new LocalStorage().getAllKnives()).toHaveLength(0)
    await expectTemporaryFilesRemoved()
  })

  it('retries if an image filename is reused immediately after the database snapshot finishes', async () => {
    const storage = new LocalStorage()
    const knife = await storage.createKnife(input)
    const database = getLocalDb()
    const backup = database.backup.bind(database)
    let attempts = 0
    vi.spyOn(database, 'backup').mockImplementation(
      async (destination, options) => {
        const result = await backup(destination, options)
        attempts += 1
        if (attempts === 1) {
          await storage.updateKnife(knife.id, {
            images: [],
            brand: 'Removed photo',
          })
          await storage.updateKnife(knife.id, {
            images: ['data:image/png;base64,bmV3IGltYWdl'],
            brand: 'New photo',
          })
        }
        return result
      },
    )
    let uploaded: Buffer | null = null
    stubDriveUpload(async (archive) => {
      uploaded = archive
    })

    startCloudBackupJob()
    await waitForJob('success')
    const restored = await archiveRoute.PUT(
      new Request('http://localhost/api/cloud-backup/archive', {
        method: 'PUT',
        body: new Uint8Array(uploaded!),
      }),
    )

    expect(restored.status).toBe(200)
    const restoredKnife = await new LocalStorage().getKnifeById(knife.id)
    expect(restoredKnife?.brand).toBe('New photo')
    expect(restoredKnife?.images).toEqual(knife.images)
    await expect(
      fs.readFile(path.join(vault.dataDir, 'images', knife.images[0])),
    ).resolves.toEqual(Buffer.from('new image'))
    expect(attempts).toBeGreaterThanOrEqual(2)
    await expectTemporaryFilesRemoved()
  })

  it('retries if an image filename is reused while staging, preserving matching metadata and bytes', async () => {
    const storage = new LocalStorage()
    const knife = await storage.createKnife(input)
    const copy = fs.copyFile.bind(fs)
    const backup = vi.spyOn(getLocalDb(), 'backup')
    let changed = false
    vi.spyOn(fs, 'copyFile').mockImplementation(
      async (source, destination, mode) => {
        if (
          !changed &&
          String(source).includes(`${path.sep}images${path.sep}`)
        ) {
          changed = true
          await storage.updateKnife(knife.id, {
            images: [],
            brand: 'Removed photo',
          })
          await storage.updateKnife(knife.id, {
            images: ['data:image/png;base64,bmV3IGltYWdl'],
            brand: 'New photo',
          })
        }
        await copy(source, destination, mode)
      },
    )
    let uploaded: Buffer | null = null
    stubDriveUpload(async (archive) => {
      uploaded = archive
    })
    startCloudBackupJob()
    await waitForJob('success')
    expect(backup).toHaveBeenCalledTimes(2)
    const restored = await archiveRoute.PUT(
      new Request('http://localhost/api/cloud-backup/archive', {
        method: 'PUT',
        body: new Uint8Array(uploaded!),
      }),
    )
    expect(restored.status).toBe(200)
    const restoredKnife = await new LocalStorage().getKnifeById(knife.id)
    expect(restoredKnife?.brand).toBe('New photo')
    expect(restoredKnife?.images).toEqual(knife.images)
    await expect(
      fs.readFile(path.join(vault.dataDir, 'images', knife.images[0])),
    ).resolves.toEqual(Buffer.from('new image'))
  })

  it('uses the bounded stream fallback when file cloning is unsupported', async () => {
    const storage = new LocalStorage()
    const knife = await storage.createKnife(input)
    const originalImage = await fs.readFile(
      path.join(vault.dataDir, 'images', knife.images[0]),
    )
    const clone = vi
      .spyOn(fs, 'copyFile')
      .mockRejectedValue(
        Object.assign(new Error('Cloning unsupported'), { code: 'EOPNOTSUPP' }),
      )
    let uploaded: Buffer | null = null
    stubDriveUpload(async (archive) => {
      uploaded = archive
    })
    startCloudBackupJob()
    await waitForJob('success')
    expect(clone).toHaveBeenCalled()
    const restored = await archiveRoute.PUT(
      new Request('http://localhost/api/cloud-backup/archive', {
        method: 'PUT',
        body: new Uint8Array(uploaded!),
      }),
    )
    expect(restored.status).toBe(200)
    await expect(
      fs.readFile(path.join(vault.dataDir, 'images', knife.images[0])),
    ).resolves.toEqual(originalImage)
    await expectTemporaryFilesRemoved()
  })

  it('fails without uploading if a snapshot still references a missing image', async () => {
    const storage = new LocalStorage()
    const knife = await storage.createKnife(input)
    await fs.unlink(path.join(vault.dataDir, 'images', knife.images[0]))
    startCloudBackupJob()
    await waitForJob('error')
    expect(uploadDriveBackup).not.toHaveBeenCalled()
    await expectTemporaryFilesRemoved()
  })

  it('prevents a restore from replacing the vault while a backup is uploading', async () => {
    const storage = new LocalStorage()
    const knife = await storage.createKnife(input)
    const originalArchive = await (
      await archiveRoute.GET(
        new Request('http://localhost/api/cloud-backup/archive'),
      )
    ).arrayBuffer()
    await storage.updateKnife(knife.id, { brand: 'Before restore' })
    let releaseToken!: () => void
    const tokenGate = new Promise<void>((resolve) => {
      releaseToken = resolve
    })
    let refreshing = false
    const upload = vi.fn(async () => {})
    stubDriveUpload(upload, async () => {
      refreshing = true
      await tokenGate
    })
    startCloudBackupJob()
    await vi.waitFor(() => {
      expect(refreshing).toBe(true)
    })
    const restored = await archiveRoute.PUT(
      new Request('http://localhost/api/cloud-backup/archive', {
        method: 'PUT',
        body: originalArchive,
      }),
    )
    expect(restored.status).toBe(409)
    expect((await new LocalStorage().getKnifeById(knife.id))?.brand).toBe(
      'Before restore',
    )
    releaseToken()
    await waitForJob('success')
    expect(upload).toHaveBeenCalledOnce()
    const allowedRestore = await archiveRoute.PUT(
      new Request('http://localhost/api/cloud-backup/archive', {
        method: 'PUT',
        body: originalArchive,
      }),
    )
    expect(allowedRestore.status).toBe(200)
    expect((await new LocalStorage().getKnifeById(knife.id))?.brand).toBe(
      'Maker',
    )
    await expectTemporaryFilesRemoved()
  })

  it('scopes job status to the data directory and protects both routes when locked', async () => {
    expect(getCloudBackupJobState()).toEqual(IDLE_CLOUD_BACKUP_JOB)
    setAppLockPassword('local-password')
    expect(
      (await jobRoute.GET(new Request('http://localhost/api/cloud-backup/job')))
        .status,
    ).toBe(401)
    expect((await jobRoute.POST(request())).status).toBe(401)
    setAppLockPassword('')
    isDriveConnected.mockResolvedValue(false)
    expect((await jobRoute.POST(request())).status).toBe(400)
  })
})
