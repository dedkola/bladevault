import Database from 'better-sqlite3'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as archiveRoute from '@/app/api/cloud-backup/archive/route'
import * as restoreRoute from '@/app/api/cloud-backup/restore-job/route'
import * as vaultStatusRoute from '@/app/api/vault/status/route'
import { createAppUnlockToken, setAppLockPassword } from '@/lib/app-lock'
import { APP_LOCK_COOKIE } from '@/lib/app-lock-shared'
import { getCloudRestoreJobState } from '@/lib/cloud-restore-job'
import { getConfiguredCloudBackupUrl } from '@/lib/cloud-backup-server'
import { getLocalDb } from '@/lib/local-db'
import { getSettings, saveSettings } from '@/lib/settings'
import { LocalStorage } from '@/lib/storage/local'
import type { CreateKnifeInput } from '@/lib/storage/types'
import {
  getVaultAccessState,
  getVaultControlDir,
  getVaultGeneration,
  VAULT_GENERATION_HEADER,
  withVaultControlTransaction,
} from '@/lib/vault-access'
import { tryBeginVaultOperation } from '@/lib/vault-operation'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault
let temporaryDirectories: string[]
let releasePauses: Array<() => void>
let archiveFixtureDirectories: string[]
let pendingRequests: Promise<Response>[]
const accessToken = 'test-restore-access-secret'
const sessionToken = 'test-restore-session-secret'
const input: CreateKnifeInput = {
  name: 'Restored Item',
  brand: 'Snapshot Brand',
  bladeStyle: 'Drop Point',
  handleMaterial: 'G10',
  imageUrls: ['data:image/png;base64,c25hcHNob3QgaW1hZ2U='],
  specs: { weight: '', overallLength: '', bladeLength: '', country: '' },
  description: 'Snapshot description',
  customFields: {},
  sourceUrl: '',
  pinned: false,
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

function request(token = sessionToken, signal?: AbortSignal, cookie?: string) {
  return new Request('http://localhost/api/cloud-backup/restore-job', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ sessionToken: token }),
    signal,
  })
}

function statusRequest(cookie?: string) {
  return new Request('http://localhost/api/vault/status', {
    headers: cookie ? { cookie } : {},
  })
}

function stubDownload(
  download: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(url)).pathname === '/api/auth/token') {
      expect(new Headers(init?.headers).get('authorization')).toBe(
        `Bearer ${sessionToken}`,
      )
      expect(init).toMatchObject({ redirect: 'error', cache: 'no-store' })
      return Response.json({ token: accessToken })
    }
    expect(String(url)).toBe(
      new URL('/backup/latest', getConfiguredCloudBackupUrl()).toString(),
    )
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Bearer ${accessToken}`,
    )
    expect(init).toMatchObject({ redirect: 'error', cache: 'no-store' })
    return download(url, init)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

async function exportedSnapshot(cookie?: string) {
  const storage = new LocalStorage()
  const knife = await storage.createKnife(input)
  saveSettings({ theme: 'dark' })
  const response = await archiveRoute.GET(
    new Request('http://localhost/api/cloud-backup/archive', {
      headers: cookie ? { cookie } : {},
    }),
  )
  expect(response.status).toBe(200)
  const archive = Buffer.from(await response.arrayBuffer())
  await storage.updateKnife(knife.id, {
    brand: 'Live Brand',
    description: 'Live description',
  })
  saveSettings({ theme: 'light' })
  return { storage, knife, archive }
}

async function waitForFinished(status: 'success' | 'error') {
  await vi.waitFor(() => expect(getCloudRestoreJobState().status).toBe(status))
  await vi.waitFor(async () => {
    for (const directory of temporaryDirectories)
      await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  // Operation ownership is released after the public status and cleanup settle.
  await new Promise<void>((resolve) => setImmediate(resolve))
  return getCloudRestoreJobState()
}

async function archiveWithoutImage(archive: Buffer, imagePath: string) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'bladevault-missing-image-archive-'),
  )
  archiveFixtureDirectories.push(directory)
  const originalArchive = path.join(directory, 'original.tar.gz')
  const extractRoot = path.join(directory, 'extract')
  await fs.writeFile(originalArchive, archive)
  await fs.mkdir(extractRoot)
  await tar.extract({ file: originalArchive, gzip: true, cwd: extractRoot })
  const [topDir] = await fs.readdir(extractRoot)
  await fs.unlink(path.join(extractRoot, topDir, 'images', imagePath))
  const incompleteArchive = path.join(directory, 'missing-image.tar.gz')
  await tar.create({ file: incompleteArchive, gzip: true, cwd: extractRoot }, [
    topDir,
  ])
  return fs.readFile(incompleteArchive)
}

beforeEach(async () => {
  vault = await createTempVault('bladevault-restore-job-')
  temporaryDirectories = []
  releasePauses = []
  archiveFixtureDirectories = []
  pendingRequests = []
  const mkdtemp = fs.mkdtemp.bind(fs)
  vi.spyOn(fs, 'mkdtemp').mockImplementation(async (prefix) => {
    const directory = await mkdtemp(prefix)
    if (String(prefix).includes('bladevault-cloud-restore-'))
      temporaryDirectories.push(directory)
    return directory
  })
})

afterEach(async () => {
  for (const release of releasePauses) release()
  await Promise.allSettled(pendingRequests)
  await vi.waitFor(() =>
    expect(getCloudRestoreJobState().status).not.toBe('running'),
  )
  await vi.waitFor(async () => {
    for (const directory of temporaryDirectories)
      await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  const dataDir = vault.dataDir
  await vault.cleanup()
  await fs.rm(getVaultControlDir(dataDir), { recursive: true, force: true })
  for (const directory of archiveFixtureDirectories)
    await fs.rm(directory, { recursive: true, force: true })
})

describe('server-owned cloud restore job', () => {
  it('rejects a delayed restore request after another restore changes its captured generation', async () => {
    const { archive } = await exportedSnapshot()
    const generation = getVaultGeneration()
    const blocked = pause()
    const delayedRequest = request()
    vi.spyOn(delayedRequest, 'json').mockImplementation(async () => {
      blocked.entered()
      await blocked.resumed
      return { sessionToken }
    })
    const delayed = restoreRoute.POST(delayedRequest)
    pendingRequests.push(delayed)
    await blocked.reached
    const fetch = stubDownload(
      async () => new Response(new Uint8Array(archive)),
    )
    const accepted = await restoreRoute.POST(request())
    expect(accepted.status).toBe(202)
    const { job } = await accepted.json()
    await waitForFinished('success')
    expect(getVaultGeneration()).not.toBe(generation)
    blocked.release()
    const rejected = await delayed
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({ code: 'VAULT_CHANGED' })
    expect(getCloudRestoreJobState()).toMatchObject({
      id: job.id,
      status: 'success',
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(temporaryDirectories).toHaveLength(1)
  })

  it('rejects an explicitly stale generation without starting another cloud download', async () => {
    const { archive } = await exportedSnapshot()
    const generation = getVaultGeneration()
    const fetch = stubDownload(
      async () => new Response(new Uint8Array(archive)),
    )
    expect((await restoreRoute.POST(request())).status).toBe(202)
    const completed = await waitForFinished('success')
    const stale = request()
    stale.headers.set(VAULT_GENERATION_HEADER, generation)
    const rejected = await restoreRoute.POST(stale)
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({ code: 'VAULT_CHANGED' })
    expect(getCloudRestoreJobState().id).toBe(completed.id)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(temporaryDirectories).toHaveLength(1)
  })

  it('leaves the current vault intact when a valid database references a missing archived image', async () => {
    const { storage, knife, archive } = await exportedSnapshot()
    const generation = getVaultGeneration()
    const incomplete = await archiveWithoutImage(archive, knife.images[0])
    stubDownload(async () => new Response(new Uint8Array(incomplete)))
    expect((await restoreRoute.POST(request())).status).toBe(202)
    await waitForFinished('error')
    expect(getVaultAccessState()).toMatchObject({
      generation,
      phase: 'idle',
      readOnly: false,
    })
    await expect(storage.getKnifeById(knife.id)).resolves.toMatchObject({
      brand: 'Live Brand',
      description: 'Live description',
    })
    expect((await storage.getImage(knife.images[0])).buffer.toString()).toBe(
      'snapshot image',
    )
    expect(getSettings().theme).toBe('light')
    expect(getLocalDb().pragma('integrity_check', { simple: true })).toBe('ok')
    expect(
      (await fs.readdir(vault.dataDir)).some((entry) =>
        entry.startsWith('._bladevault-before-restore-'),
      ),
    ).toBe(false)
    await expect(
      storage.updateKnife(knife.id, {
        description: 'Writable after rejection',
      }),
    ).resolves.toMatchObject({ description: 'Writable after rejection' })
  })

  it('survives request abort, deduplicates, permits reads while preparing, and installs a validated snapshot', async () => {
    const { storage, knife, archive } = await exportedSnapshot()
    const generation = getVaultGeneration()
    const download = pause()
    const validating = pause()
    const applying = pause()
    const stat = fs.stat.bind(fs)
    let pausedValidation = false
    vi.spyOn(fs, 'stat').mockImplementation(async (file, options) => {
      if (
        path.basename(String(file)) === 'backup.tar.gz' &&
        !pausedValidation
      ) {
        pausedValidation = true
        validating.entered()
        await validating.resumed
      }
      return stat(file, options)
    })
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (
        String(source) === path.join(vault.dataDir, 'bladevault.sqlite') &&
        String(destination).includes('._bladevault-before-restore-')
      ) {
        applying.entered()
        await applying.resumed
      }
      return rename(source, destination)
    })
    const fetch = stubDownload(async () => {
      const split = Math.floor(archive.length / 2)
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(archive.subarray(0, split)))
          download.entered()
          void download.resumed.then(() => {
            controller.enqueue(new Uint8Array(archive.subarray(split)))
            controller.close()
          })
        },
      })
      return new Response(body, {
        headers: { 'Content-Length': String(archive.length) },
      })
    })
    const controller = new AbortController()
    const accepted = await restoreRoute.POST(
      request(sessionToken, controller.signal),
    )
    expect(accepted.status).toBe(202)
    const started = await accepted.json()
    expect(started).toMatchObject({
      started: true,
      job: { status: 'running', phase: 'downloading', id: expect.any(String) },
    })
    controller.abort()
    const duplicate = await restoreRoute.POST(
      request('different-session-secret'),
    )
    expect(duplicate.status).toBe(202)
    expect(await duplicate.json()).toMatchObject({
      started: false,
      job: { id: started.job.id },
    })
    await download.reached
    expect(fetch).toHaveBeenCalledTimes(2)
    const preparing = await vaultStatusRoute.GET(statusRequest())
    expect(preparing.headers.get('cache-control')).toBe('no-store')
    expect(await preparing.json()).toMatchObject({
      generation,
      phase: 'preparing',
      readOnly: true,
    })
    await expect(storage.getKnifeById(knife.id)).resolves.toMatchObject({
      brand: 'Live Brand',
    })
    expect(getSettings().theme).toBe('light')
    await expect(
      storage.updateKnife(knife.id, { brand: 'Blocked' }),
    ).rejects.toMatchObject({
      code: 'VAULT_RESTORE_BUSY',
    })
    download.release()
    await validating.reached
    expect(getCloudRestoreJobState().phase).toBe('validating')
    expect(getVaultAccessState().phase).toBe('preparing')
    validating.release()
    await applying.reached
    const switching = await vaultStatusRoute.GET(statusRequest())
    expect(await switching.json()).toMatchObject({
      phase: 'switching',
      readOnly: true,
    })
    const running = await restoreRoute.GET(statusRequest())
    expect(await running.json()).toMatchObject({
      job: { phase: 'applying', status: 'running' },
    })
    applying.release()
    const finished = await waitForFinished('success')
    expect(finished).toMatchObject({
      id: started.job.id,
      phase: null,
      message: null,
      restoredAt: expect.any(String),
    })
    expect(finished.generation).not.toBe(generation)
    expect(getVaultAccessState()).toMatchObject({
      generation: finished.generation,
      phase: 'idle',
      readOnly: false,
    })
    await expect(storage.getKnifeById(knife.id)).resolves.toMatchObject({
      brand: 'Snapshot Brand',
      description: 'Snapshot description',
    })
    expect(getSettings().theme).toBe('dark')
    expect((await storage.getImage(knife.images[0])).buffer.toString()).toBe(
      'snapshot image',
    )
    expect(getLocalDb().pragma('integrity_check', { simple: true })).toBe('ok')
    const safetyCopy = (await fs.readdir(vault.dataDir)).find(
      (entry) =>
        entry.startsWith('._bladevault-before-restore-') &&
        entry.endsWith('.bak'),
    )
    expect(safetyCopy).toEqual(expect.any(String))
    const safetyDb = new Database(
      path.join(vault.dataDir, safetyCopy!, 'bladevault.sqlite'),
      { readonly: true, fileMustExist: true },
    )
    try {
      expect(
        safetyDb.prepare('SELECT brand FROM knives WHERE id = ?').get(knife.id),
      ).toEqual({ brand: 'Live Brand' })
    } finally {
      safetyDb.close()
    }
    const persisted = await fs.readFile(
      path.join(getVaultControlDir(), 'last-restore.json'),
      'utf8',
    )
    for (const secret of [
      sessionToken,
      accessToken,
      'different-session-secret',
    ]) {
      expect(persisted).not.toContain(secret)
      expect(JSON.stringify(finished)).not.toContain(secret)
    }
    expect(temporaryDirectories).toHaveLength(1)
  })

  it.each(['remote rejection', 'invalid archive'])(
    'preserves the current vault after %s and permits a retry',
    async (failure) => {
      const { storage, knife, archive } = await exportedSnapshot()
      const generation = getVaultGeneration()
      stubDownload(async () =>
        failure === 'remote rejection'
          ? new Response(`Do not reveal ${accessToken}`, { status: 503 })
          : new Response('this is not a gzip tar archive'),
      )
      expect((await restoreRoute.POST(request())).status).toBe(202)
      const failed = await waitForFinished('error')
      expect(failed.phase).toBeNull()
      expect(failed.message).toEqual(expect.any(String))
      expect(JSON.stringify(failed)).not.toContain(accessToken)
      expect(JSON.stringify(failed)).not.toContain(sessionToken)
      expect(getVaultAccessState()).toMatchObject({
        generation,
        phase: 'idle',
        readOnly: false,
      })
      await expect(storage.getKnifeById(knife.id)).resolves.toMatchObject({
        brand: 'Live Brand',
      })
      await expect(
        storage.updateKnife(knife.id, {
          description: 'Writable after failure',
        }),
      ).resolves.toMatchObject({ description: 'Writable after failure' })
      stubDownload(async () => new Response(new Uint8Array(archive)))
      const retryResponse = await restoreRoute.POST(request())
      expect(retryResponse.status).toBe(202)
      const retry = await retryResponse.json()
      expect(retry.started).toBe(true)
      expect(retry.job.id).not.toBe(failed.id)
      await waitForFinished('success')
      await expect(storage.getKnifeById(knife.id)).resolves.toMatchObject({
        brand: 'Snapshot Brand',
      })
      expect(temporaryDirectories).toHaveLength(2)
    },
  )

  it('cannot start while another backup or restore operation owns the vault', async () => {
    await new LocalStorage().createKnife(input)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const release = tryBeginVaultOperation()
    expect(release).toEqual(expect.any(Function))
    try {
      const response = await restoreRoute.POST(request())
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining('Another backup or restore'),
      })
      expect(getCloudRestoreJobState().status).toBe('idle')
      expect(getVaultAccessState().readOnly).toBe(false)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      release!()
    }
  })

  it('requires app unlock to start and exposes no job status to locked requests', async () => {
    setAppLockPassword('restore-password')
    const cookie = `${APP_LOCK_COOKIE}=${createAppUnlockToken()}`
    const { archive } = await exportedSnapshot(cookie)
    const fetch = stubDownload(
      async () => new Response(new Uint8Array(archive)),
    )
    expect((await restoreRoute.POST(request())).status).toBe(401)
    expect((await restoreRoute.GET(statusRequest())).status).toBe(401)
    expect((await vaultStatusRoute.GET(statusRequest())).status).toBe(401)
    expect(fetch).not.toHaveBeenCalled()
    const accepted = await restoreRoute.POST(
      request(sessionToken, undefined, cookie),
    )
    expect(accepted.status).toBe(202)
    await waitForFinished('success')
    // Restoring lock settings rotates the session secret, invalidating old cookies.
    expect((await restoreRoute.GET(statusRequest(cookie))).status).toBe(401)
    const refreshedCookie = `${APP_LOCK_COOKIE}=${createAppUnlockToken()}`
    expect(
      (await restoreRoute.GET(statusRequest(refreshedCookie))).status,
    ).toBe(200)
  })

  it('does not let a finished job cleanup overwrite a newer process persisted restore status', async () => {
    const { archive } = await exportedSnapshot()
    const cleanup = pause()
    const remove = fs.rm.bind(fs)
    let paused = false
    vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
      if (!paused && temporaryDirectories.includes(String(file))) {
        paused = true
        cleanup.entered()
        await cleanup.resumed
      }
      return remove(file, options)
    })
    stubDownload(async () => new Response(new Uint8Array(archive)))
    const accepted = await restoreRoute.POST(request())
    expect(accepted.status).toBe(202)
    const first = await accepted.json()
    await cleanup.reached
    expect(getVaultAccessState()).toMatchObject({
      phase: 'idle',
      readOnly: false,
    })
    expect(getCloudRestoreJobState()).toMatchObject({
      id: first.job.id,
      status: 'success',
    })
    const newer = {
      id: 'newer-process-restore',
      status: 'success',
      phase: null,
      message: null,
      restoredAt: '2026-10-12T07:15:00.000Z',
      generation: getVaultGeneration(),
    }
    const persistedPath = path.join(getVaultControlDir(), 'last-restore.json')
    // Simulate a different server process publishing its completed restore while
    // this process still owns only temporary-file cleanup for the earlier job.
    withVaultControlTransaction(vault.dataDir, () => {
      fsSync.writeFileSync(
        persistedPath,
        JSON.stringify({ ...newer, ownerPid: process.pid }),
      )
    })
    expect(getCloudRestoreJobState()).toEqual(newer)
    cleanup.release()
    await waitForFinished('success')
    expect(JSON.parse(await fs.readFile(persistedPath, 'utf8'))).toEqual({
      ...newer,
      ownerPid: process.pid,
    })
    expect(getCloudRestoreJobState()).toEqual(newer)
    expect(
      (await (await restoreRoute.GET(statusRequest())).json()).job,
    ).toEqual(newer)
  })
})
