import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as jobRoute from '@/app/api/cloud-backup/job/route'
import * as restoreRoute from '@/app/api/cloud-backup/restore-job/route'
import * as connectRoute from '@/app/api/drive-backup/connect/route'
import * as statusRoute from '@/app/api/drive-backup/status/route'
import { getCloudBackupJobState } from '@/lib/cloud-backup-job'
import { getCloudRestoreJobState } from '@/lib/cloud-restore-job'
import type { DriveBackupStatus } from '@/lib/drive-backup-shared'
import { LocalStorage } from '@/lib/storage/local'
import type { CreateKnifeInput } from '@/lib/storage/types'
import { getVaultControlDir } from '@/lib/vault-access'
import { tryBeginVaultOperation } from '@/lib/vault-operation'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

const refreshToken = 'test-drive-refresh-secret'
const accessToken = 'test-drive-access-secret'
const authCode = 'test-drive-auth-code'
const input: CreateKnifeInput = {
  name: 'Drive Knife',
  brand: 'Maker',
  bladeStyle: 'Drop Point',
  handleMaterial: 'G10',
  imageUrls: ['data:image/png;base64,aGVsbG8='],
  specs: { weight: '', overallLength: '', bladeLength: '', country: '' },
  customFields: {},
  description: '',
  sourceUrl: '',
  pinned: false,
  sold: false,
}

type FakeDrive = {
  folderId: string | null
  file: { id: string; bytes: Buffer; modifiedTime: string } | null
  refreshStatus: number
  uploads: number
  authServiceCalls: string[]
  codeChallenge: string
}

let vault: TempVault
let drive: FakeDrive

async function readBody(init: RequestInit | undefined): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of init?.body as unknown as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function installFakeServices() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const headers = new Headers(init?.headers)

      if (url.hostname === 'auth.bladevault.pro') {
        drive.authServiceCalls.push(url.pathname)
        const body = JSON.parse(String(init?.body)) as Record<string, string>
        if (url.pathname === '/auth/drive/token') {
          // Only the server that started sign-in knows the verifier.
          const challenge = createHash('sha256')
            .update(body.code_verifier)
            .digest('base64url')
          if (body.code !== authCode || challenge !== drive.codeChallenge) {
            return Response.json({ error: 'invalid_grant' }, { status: 400 })
          }
          return Response.json({
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: 3599,
            scope: 'https://www.googleapis.com/auth/drive.file',
          })
        }
        if (url.pathname === '/auth/drive/refresh') {
          if (
            drive.refreshStatus !== 200 ||
            body.refresh_token !== refreshToken
          )
            return Response.json(
              { error: 'invalid_grant' },
              {
                status: drive.refreshStatus === 200 ? 401 : drive.refreshStatus,
              },
            )
          return Response.json({ access_token: accessToken, expires_in: 3599 })
        }
      }

      if (url.hostname === 'oauth2.googleapis.com')
        return new Response(null, { status: 200 })

      if (url.hostname === 'upload.fake-drive.test' && method === 'PUT') {
        // The session address authorizes the upload by itself.
        expect(headers.get('authorization')).toBeNull()
        const bytes = await readBody(init)
        expect(Number(headers.get('content-length'))).toBe(bytes.length)
        drive.uploads += 1
        drive.file = {
          id: drive.file?.id ?? 'file-1',
          bytes,
          modifiedTime: new Date().toISOString(),
        }
        return Response.json({
          id: drive.file.id,
          ...(url.searchParams.get('size') === '1'
            ? { size: String(bytes.length) }
            : {}),
        })
      }

      if (url.hostname !== 'www.googleapis.com')
        throw new Error(`Unexpected request to ${url.origin}`)
      expect(headers.get('authorization')).toBe(`Bearer ${accessToken}`)

      if (url.pathname === '/drive/v3/files' && method === 'GET') {
        const query = url.searchParams.get('q') ?? ''
        expect(query).toContain('trashed=false')
        if (query.includes("mimeType='application/vnd.google-apps.folder'")) {
          return Response.json({
            files: drive.folderId ? [{ id: drive.folderId }] : [],
          })
        }
        return Response.json({
          files: drive.file
            ? [
                {
                  id: drive.file.id,
                  size: String(drive.file.bytes.length),
                  modifiedTime: drive.file.modifiedTime,
                },
              ]
            : [],
        })
      }
      if (url.pathname === '/drive/v3/files' && method === 'POST') {
        drive.folderId = 'folder-1'
        return Response.json({ id: drive.folderId })
      }
      if (url.pathname.startsWith('/upload/drive/v3/files')) {
        const metadata = JSON.parse(String(init?.body)) as {
          name?: string
          parents?: string[]
        }
        if (method === 'POST') {
          expect(metadata).toEqual({
            name: 'bladevault-data.tar.gz',
            parents: ['folder-1'],
          })
        } else {
          // An existing backup is replaced in place, never duplicated.
          expect(method).toBe('PATCH')
          expect(url.pathname).toBe(`/upload/drive/v3/files/${drive.file?.id}`)
        }
        // Drive leaves the size out of its reply unless it is requested.
        const fields = url.searchParams.get('fields')?.split(',') ?? []
        return new Response(null, {
          status: 200,
          headers: {
            Location: `https://upload.fake-drive.test/session?size=${fields.includes('size') ? '1' : '0'}`,
          },
        })
      }
      if (
        url.pathname === `/drive/v3/files/${drive.file?.id}` &&
        url.searchParams.get('alt') === 'media'
      ) {
        return new Response(new Uint8Array(drive.file!.bytes))
      }
      throw new Error(`Unexpected Drive request ${method} ${url.pathname}`)
    }),
  )
}

function post(url: string, body: unknown) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function connect() {
  const begin = await connectRoute.POST(
    post('http://localhost/api/drive-backup/connect', {
      action: 'begin',
      clientOrigin: 'http://localhost:3000',
    }),
  )
  const started = (await begin.json()) as {
    startUrl: string
    state: string
    authOrigin: string
  }
  const startUrl = new URL(started.startUrl)
  drive.codeChallenge = startUrl.searchParams.get('code_challenge') ?? ''
  return { started, startUrl }
}

async function completeConnect(state: string, code = authCode) {
  return connectRoute.POST(
    post('http://localhost/api/drive-backup/connect', {
      action: 'complete',
      state,
      code,
    }),
  )
}

async function readStatus(): Promise<DriveBackupStatus> {
  const response = await statusRoute.GET(
    new Request('http://localhost/api/drive-backup/status'),
  )
  return (await response.json()) as DriveBackupStatus
}

const credentialsFile = () =>
  path.join(getVaultControlDir(vault.dataDir), 'drive-credentials.json')

beforeEach(async () => {
  vault = await createTempVault('bladevault-drive-')
  drive = {
    folderId: null,
    file: null,
    refreshStatus: 200,
    uploads: 0,
    authServiceCalls: [],
    codeChallenge: '',
  }
  installFakeServices()
})

afterEach(async () => {
  await vault.cleanup()
  vi.unstubAllGlobals()
})

describe('Google Drive backup', () => {
  it('connects through the sign-in service and keeps the Drive sign-in out of the browser', async () => {
    expect(await readStatus()).toEqual({
      available: true,
      connected: false,
      file: null,
      message: null,
    })

    const { started, startUrl } = await connect()
    expect(startUrl.origin + startUrl.pathname).toBe(
      'https://auth.bladevault.pro/auth/drive/start',
    )
    expect(startUrl.searchParams.get('client_origin')).toBe(
      'http://localhost:3000',
    )
    expect(startUrl.searchParams.get('state')).toBe(started.state)
    expect(started.authOrigin).toBe('https://auth.bladevault.pro')

    const response = await completeConnect(started.state)
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(JSON.parse(text)).toMatchObject({ connected: true, file: null })
    expect(text).not.toContain(refreshToken)
    expect(text).not.toContain(accessToken)

    const saved = await fs.stat(credentialsFile())
    expect(saved.mode & 0o777).toBe(0o600)

    // A sign-in can be completed only once.
    expect((await completeConnect(started.state)).status).toBe(400)
  })

  it('reports the connection alone without contacting Google', async () => {
    const readConnection = async () => {
      const response = await statusRoute.GET(
        new Request(
          'http://localhost/api/drive-backup/status?scope=connection',
        ),
      )
      return (await response.json()) as unknown
    }
    expect(await readConnection()).toEqual({ connected: false })

    const { started } = await connect()
    await completeConnect(started.state)
    drive.authServiceCalls = []
    const fetchCalls = vi.mocked(fetch).mock.calls.length

    expect(await readConnection()).toEqual({ connected: true })
    expect(drive.authServiceCalls).toEqual([])
    expect(vi.mocked(fetch).mock.calls.length).toBe(fetchCalls)
  })

  it('rejects a sign-in code that was not started by this server', async () => {
    const { started } = await connect()
    expect((await completeConnect('unknown-state')).status).toBe(400)
    expect((await completeConnect(started.state, 'stolen-code')).status).toBe(
      400,
    )
    expect((await readStatus()).connected).toBe(false)
  })

  it('refuses Drive backup and restore until Google Drive is connected', async () => {
    const backup = await jobRoute.POST(
      post('http://localhost/api/cloud-backup/job', {}),
    )
    expect(backup.status).toBe(400)
    const restore = await restoreRoute.POST(
      post('http://localhost/api/cloud-backup/restore-job', {}),
    )
    expect(restore.status).toBe(400)
    expect(drive.uploads).toBe(0)
  })

  it('backs up to one Drive file, replaces it in place, and restores it', async () => {
    const storage = new LocalStorage()
    const knife = await storage.createKnife(input)
    const { started } = await connect()
    await completeConnect(started.state)

    const first = await jobRoute.POST(
      post('http://localhost/api/cloud-backup/job', {}),
    )
    expect(first.status).toBe(202)
    expect((await first.json()).job).toMatchObject({ status: 'running' })
    await vi.waitFor(() =>
      expect(getCloudBackupJobState().status).toBe('success'),
    )
    expect(drive.folderId).toBe('folder-1')
    expect(drive.uploads).toBe(1)

    const status = await readStatus()
    expect(status.file).toEqual({
      modifiedTime: drive.file!.modifiedTime,
      size: drive.file!.bytes.length,
    })
    // The archive never carries the Drive sign-in.
    expect(drive.file!.bytes.includes(Buffer.from(refreshToken))).toBe(false)

    await jobRoute.POST(post('http://localhost/api/cloud-backup/job', {}))
    await vi.waitFor(() => expect(drive.uploads).toBe(2))
    await vi.waitFor(() =>
      expect(getCloudBackupJobState().status).toBe('success'),
    )
    expect(drive.file!.id).toBe('file-1')

    await storage.deleteKnife(knife.id)
    expect(await new LocalStorage().getAllKnives()).toHaveLength(0)

    const restore = await restoreRoute.POST(
      post('http://localhost/api/cloud-backup/restore-job', {}),
    )
    expect(restore.status).toBe(202)
    await vi.waitFor(() =>
      expect(getCloudRestoreJobState().status).toBe('success'),
    )
    const restored = await new LocalStorage().getAllKnives()
    expect(restored.map((item) => item.name)).toEqual(['Drive Knife'])

    // This device stays connected after the vault is replaced.
    expect((await readStatus()).connected).toBe(true)
    // Let the restore finish its cleanup before the vault is removed.
    await vi.waitFor(() => {
      const release = tryBeginVaultOperation()
      expect(release).toEqual(expect.any(Function))
      release!()
    })
  })

  it('disconnects when Google no longer accepts the sign-in', async () => {
    const { started } = await connect()
    await completeConnect(started.state)
    // Drop the access token cached at sign-in so a refresh is required.
    const disconnect = await connectRoute.DELETE(
      new Request('http://localhost/api/drive-backup/connect', {
        method: 'DELETE',
      }),
    )
    expect((await disconnect.json()).connected).toBe(false)
    await expect(fs.stat(credentialsFile())).rejects.toMatchObject({
      code: 'ENOENT',
    })

    const again = await connect()
    await completeConnect(again.started.state)
    drive.refreshStatus = 401
    const backup = await jobRoute.POST(
      post('http://localhost/api/cloud-backup/job', {}),
    )
    expect(backup.status).toBe(202)
    await vi.waitFor(() =>
      expect(getCloudBackupJobState().status).toBe('error'),
    )
    expect(getCloudBackupJobState().message).toBe(
      'Google Drive access is no longer valid. Connect Google Drive again.',
    )
    expect(await readStatus()).toMatchObject({ connected: false })
    expect(drive.uploads).toBe(0)
  })
})
