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
import { getConfiguredCloudBackupUrl } from '@/lib/cloud-backup-server'
import { setAppLockPassword } from '@/lib/app-lock'
import { getLocalDb } from '@/lib/local-db'
import { getSettings, saveSettings } from '@/lib/settings'
import { LocalStorage } from '@/lib/storage/local'
import type { CreateKnifeInput } from '@/lib/storage/types'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault
let temporaryDirectories: string[]
const accessToken = 'test-cloud-backup-secret'
const sessionToken = 'test-cloud-session-secret'
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
}

function request(token: string = sessionToken, signal?: AbortSignal) {
  return new Request('http://localhost/api/cloud-backup/job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionToken: token }),
    signal,
  })
}

function stubCloudUpload(
  upload: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  beforeToken?: () => Promise<void>,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(url)).pathname === '/api/auth/token') {
        expect(new Headers(init?.headers).get('authorization')).toBe(
          `Bearer ${sessionToken}`,
        )
        expect(init).toMatchObject({ redirect: 'error', cache: 'no-store' })
        expect(getCloudBackupJobState().phase).toBe('preparing')
        // A full archive must already exist before requesting a fresh access token.
        await expect(
          fs.stat(
            path.join(temporaryDirectories.at(-1)!, 'bladevault-data.tar.gz'),
          ),
        ).resolves.toMatchObject({ size: expect.any(Number) })
        await beforeToken?.()
        return Response.json({ token: accessToken })
      }
      return upload(url, init)
    }),
  )
}

async function collectUpload(init: RequestInit | undefined) {
  const chunks: Buffer[] = []
  for await (const chunk of init?.body as unknown as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
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
    const upload = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        uploaded = await collectUpload(init)
        await uploadGate
        return new Response(null, { status: 200 })
      },
    )
    stubCloudUpload(upload)

    const controller = new AbortController()
    const startedResponse = await jobRoute.POST(
      request(sessionToken, controller.signal),
    )
    const started = (await startedResponse.json()).job
    expect(startedResponse.status).toBe(202)
    expect(started).toMatchObject({ status: 'running', phase: 'preparing' })
    expect(started.id).toEqual(expect.any(String))
    expect(JSON.stringify(started)).not.toContain(accessToken)
    expect(JSON.stringify(started)).not.toContain(sessionToken)
    controller.abort()

    const duplicate = await jobRoute.POST(request('another-secret'))
    const duplicateData = await duplicate.json()
    expect(duplicateData.job.id).toBe(started.id)
    expect(duplicateData.started).toBe(false)
    await vi.waitFor(() => {
      expect(uploaded).not.toBeNull()
    })
    expect(upload).toHaveBeenCalledTimes(1)
    expect(database.open).toBe(true)
    expect(editedDuringSnapshot).toBe(true)
    expect(getSettings().cloudBackupLastSyncedAt).toBe('')
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
    const finished = await waitForJob('success')
    expect(finished.syncedAt).toEqual(expect.any(String))
    expect(getSettings().cloudBackupLastSyncedAt).toBe(finished.syncedAt)
    const [target, init] = upload.mock.calls[0]
    expect(String(target)).toBe(
      new URL('/backup/latest', getConfiguredCloudBackupUrl()).toString(),
    )
    expect(init).toMatchObject({
      method: 'PUT',
      duplex: 'half',
      redirect: 'error',
    })
    expect(new Headers(init?.headers).get('content-length')).toBe(
      String(uploaded!.length),
    )
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Bearer ${accessToken}`,
    )
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

  it('cleans up a rejected upload, preserves the timestamp, and can retry', async () => {
    saveSettings({ cloudBackupLastSyncedAt: '2026-01-01T00:00:00.000Z' })
    const upload = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        await collectUpload(init)
        return new Response(`Do not reveal ${accessToken}`, { status: 503 })
      },
    )
    stubCloudUpload(upload)
    const first = startCloudBackupJob(sessionToken)
    const failed = await waitForJob('error')
    expect(failed).toMatchObject({
      id: first.id,
      phase: null,
      syncedAt: '2026-01-01T00:00:00.000Z',
      message: 'Backup upload failed (503).',
    })
    expect(JSON.stringify(failed)).not.toContain(accessToken)
    expect(getSettings().cloudBackupLastSyncedAt).toBe(
      '2026-01-01T00:00:00.000Z',
    )
    await expectTemporaryFilesRemoved()

    upload.mockImplementationOnce(async (_url, init) => {
      await collectUpload(init)
      return new Response(null, { status: 200 })
    })
    const retry = startCloudBackupJob(sessionToken)
    expect(retry.id).not.toBe(first.id)
    await waitForJob('success')
    expect(upload).toHaveBeenCalledTimes(2)
  })

  it('does not leak credentials from transport errors and cleans up unread streams', async () => {
    getLocalDb()
    stubCloudUpload(
      vi.fn(async () => {
        throw new Error(`Failed using ${accessToken} and ${sessionToken}`)
      }),
    )
    startCloudBackupJob(sessionToken)
    const failed = await waitForJob('error')
    expect(failed.message).toBe('Failed using [redacted] and [redacted]')
    await expectTemporaryFilesRemoved()
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
      stubCloudUpload(
        async (_url, init) => {
          uploaded = await collectUpload(init)
          return new Response(null, { status: 200 })
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

      startCloudBackupJob(sessionToken)
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
    stubCloudUpload(async (_url, init) => {
      uploaded = await collectUpload(init)
      return new Response(null, { status: 200 })
    })
    startCloudBackupJob(sessionToken)
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
    stubCloudUpload(async (_url, init) => {
      uploaded = await collectUpload(init)
      return new Response(null, { status: 200 })
    })

    startCloudBackupJob(sessionToken)
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
    stubCloudUpload(async (_url, init) => {
      uploaded = await collectUpload(init)
      return new Response(null, { status: 200 })
    })
    startCloudBackupJob(sessionToken)
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
    stubCloudUpload(async (_url, init) => {
      uploaded = await collectUpload(init)
      return new Response(null, { status: 200 })
    })
    startCloudBackupJob(sessionToken)
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
    const upload = vi.fn()
    vi.stubGlobal('fetch', upload)
    startCloudBackupJob(sessionToken)
    await waitForJob('error')
    expect(upload).not.toHaveBeenCalled()
    expect(getSettings().cloudBackupLastSyncedAt).toBe('')
    await expectTemporaryFilesRemoved()
  })

  it('prevents a restore from replacing the vault while a backup is refreshing credentials', async () => {
    const storage = new LocalStorage()
    const knife = await storage.createKnife(input)
    const originalArchive = await (await archiveRoute.GET()).arrayBuffer()
    await storage.updateKnife(knife.id, { brand: 'Before restore' })
    let releaseToken!: () => void
    const tokenGate = new Promise<void>((resolve) => {
      releaseToken = resolve
    })
    let refreshing = false
    const upload = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        await collectUpload(init)
        return new Response(null, { status: 200 })
      },
    )
    stubCloudUpload(upload, async () => {
      refreshing = true
      await tokenGate
    })
    startCloudBackupJob(sessionToken)
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
    expect((await jobRoute.POST(request(''))).status).toBe(400)
  })
})
