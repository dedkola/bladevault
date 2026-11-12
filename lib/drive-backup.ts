import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { DEFAULT_CLOUD_AUTH_URL, normalizeCloudUrl } from '@/lib/cloud-backup'
import {
  DRIVE_BACKUP_FILE_NAME,
  DRIVE_BACKUP_FOLDER_NAME,
  type DriveBackupFile,
  type DriveBackupStatus,
} from '@/lib/drive-backup-shared'
import { getLocalDataDirPath } from '@/lib/local-db'
import { RestoreSizeLimitStream } from '@/lib/restore-size-limit-stream'
import { getVaultControlDir } from '@/lib/vault-access'

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder'
const CREDENTIALS_FILE = 'drive-credentials.json'
const PENDING_CONNECT_TTL_MS = 10 * 60 * 1000
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024 * 1024

type DriveCredentials = { refreshToken: string; connectedAt: string }
type PendingConnect = { verifier: string; dataDir: string; createdAt: number }
type CachedAccessToken = { token: string; expiresAt: number }
type DriveRuntime = {
  pending: Map<string, PendingConnect>
  accessTokens: Map<string, CachedAccessToken>
}

const RUNTIME_SYMBOL = Symbol.for('bladevault.drive-backup')

function runtime(): DriveRuntime {
  const scope = globalThis as typeof globalThis & {
    [RUNTIME_SYMBOL]?: DriveRuntime
  }
  return (scope[RUNTIME_SYMBOL] ??= {
    pending: new Map(),
    accessTokens: new Map(),
  })
}

export class DriveNotConnectedError extends Error {
  // True when Google stopped accepting a sign-in that this device still held.
  readonly revoked: boolean
  constructor(revoked = false) {
    super(
      revoked
        ? 'Google Drive access is no longer valid. Connect Google Drive again.'
        : 'Connect Google Drive before using it for backups.',
    )
    this.name = 'DriveNotConnectedError'
    this.revoked = revoked
  }
}

function getAuthUrl(): string {
  return normalizeCloudUrl(
    process.env.NEXT_PUBLIC_BLADEVAULT_AUTH_URL?.trim() ||
      DEFAULT_CLOUD_AUTH_URL,
  )
}

function credentialsPath(dataDir: string): string {
  return path.join(getVaultControlDir(dataDir), CREDENTIALS_FILE)
}

// Credentials live in the private control folder: it is excluded from backup
// archives and survives a restore, so a backup never carries Drive access.
async function readCredentials(
  dataDir: string,
): Promise<DriveCredentials | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(credentialsPath(dataDir), 'utf8'),
    ) as Partial<DriveCredentials>
    if (typeof parsed.refreshToken !== 'string' || !parsed.refreshToken)
      return null
    return {
      refreshToken: parsed.refreshToken,
      connectedAt:
        typeof parsed.connectedAt === 'string' ? parsed.connectedAt : '',
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (error instanceof SyntaxError) return null
    throw error
  }
}

async function writeCredentials(dataDir: string, value: DriveCredentials) {
  const filePath = credentialsPath(dataDir)
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(value), { mode: 0o600 })
    await fs.rename(temporaryPath, filePath)
  } finally {
    await fs.rm(temporaryPath, { force: true })
  }
}

async function removeCredentials(dataDir: string) {
  runtime().accessTokens.delete(dataDir)
  await fs.rm(credentialsPath(dataDir), { force: true })
}

export async function isDriveConnected(
  dataDir = getLocalDataDirPath(),
): Promise<boolean> {
  return (await readCredentials(dataDir)) !== null
}

// The auth service holds the Google client secret. It only finishes sign-in and
// refreshes access; backup data always travels directly to Google Drive.
async function postToAuthService(
  pathname: string,
  body: Record<string, string>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  let response: Response
  try {
    response = await fetch(new URL(pathname, getAuthUrl()), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    })
  } catch {
    throw new Error('Could not reach the BladeVault sign-in service.')
  }
  let data: Record<string, unknown> = {}
  try {
    data = (await response.json()) as Record<string, unknown>
  } catch {
    // The status code alone decides the outcome when no JSON body is returned.
  }
  return { status: response.status, data }
}

export function beginDriveConnect(clientOrigin: string): {
  startUrl: string
  state: string
  authOrigin: string
} {
  const pending = runtime().pending
  const now = Date.now()
  for (const [key, entry] of pending) {
    if (now - entry.createdAt > PENDING_CONNECT_TTL_MS) pending.delete(key)
  }
  const verifier = randomBytes(48).toString('base64url')
  const state = randomBytes(24).toString('base64url')
  pending.set(state, {
    verifier,
    dataDir: getLocalDataDirPath(),
    createdAt: now,
  })

  const authUrl = getAuthUrl()
  const startUrl = new URL('/auth/drive/start', authUrl)
  startUrl.searchParams.set('client_origin', clientOrigin)
  startUrl.searchParams.set('state', state)
  startUrl.searchParams.set(
    'code_challenge',
    createHash('sha256').update(verifier).digest('base64url'),
  )
  return {
    startUrl: startUrl.toString(),
    state,
    authOrigin: new URL(authUrl).origin,
  }
}

export async function completeDriveConnect(state: string, code: string) {
  const pending = runtime().pending
  const entry = pending.get(state)
  pending.delete(state)
  if (!entry || Date.now() - entry.createdAt > PENDING_CONNECT_TTL_MS) {
    throw new Error('Google sign-in expired. Please try again.')
  }
  if (entry.dataDir !== getLocalDataDirPath()) {
    throw new Error('The local data folder changed during Google sign-in.')
  }

  // The verifier never leaves this server until now, so a sign-in code that
  // reaches another party cannot be exchanged.
  const { status, data } = await postToAuthService('/auth/drive/token', {
    code,
    code_verifier: entry.verifier,
  })
  if (status !== 200) {
    throw new Error(`Google Drive sign-in failed (${status}).`)
  }
  const scope = typeof data.scope === 'string' ? data.scope.split(' ') : []
  if (!scope.includes(DRIVE_FILE_SCOPE)) {
    throw new Error(
      'Google Drive access was not granted. Connect again and allow access to BladeVault files.',
    )
  }
  if (typeof data.refresh_token !== 'string' || !data.refresh_token) {
    throw new Error('Google did not return long-term Drive access. Try again.')
  }

  await writeCredentials(entry.dataDir, {
    refreshToken: data.refresh_token,
    connectedAt: new Date().toISOString(),
  })
  if (typeof data.access_token === 'string' && data.access_token) {
    cacheAccessToken(entry.dataDir, data.access_token, data.expires_in)
  }
}

function cacheAccessToken(dataDir: string, token: string, expiresIn: unknown) {
  const seconds = typeof expiresIn === 'number' ? expiresIn : 0
  // Leave a margin so a token is never used in its final minute.
  if (seconds > 120) {
    runtime().accessTokens.set(dataDir, {
      token,
      expiresAt: Date.now() + (seconds - 60) * 1000,
    })
  }
}

async function getDriveAccessToken(
  dataDir: string,
  forceRefresh = false,
): Promise<string> {
  const cached = runtime().accessTokens.get(dataDir)
  if (!forceRefresh && cached && cached.expiresAt > Date.now())
    return cached.token

  const credentials = await readCredentials(dataDir)
  if (!credentials) throw new DriveNotConnectedError()
  const { status, data } = await postToAuthService('/auth/drive/refresh', {
    refresh_token: credentials.refreshToken,
  })
  if (status === 401) {
    // Google no longer accepts this sign-in: it was revoked or has expired.
    await removeCredentials(dataDir)
    throw new DriveNotConnectedError(true)
  }
  if (
    status !== 200 ||
    typeof data.access_token !== 'string' ||
    !data.access_token
  ) {
    throw new Error(`Google Drive sign-in could not be refreshed (${status}).`)
  }
  cacheAccessToken(dataDir, data.access_token, data.expires_in)
  return data.access_token
}

export async function disconnectDrive(dataDir = getLocalDataDirPath()) {
  const credentials = await readCredentials(dataDir)
  await removeCredentials(dataDir)
  if (!credentials) return
  try {
    // Best effort: the local sign-in is already gone if Google is unreachable.
    const response = await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: credentials.refreshToken }),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    })
    await response.body?.cancel()
  } catch {
    // Access can still be removed from the Google Account settings.
  }
}

async function driveRequest(
  token: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  return fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(60_000),
    ...init,
    headers,
  })
}

async function driveJson<T>(
  token: string,
  url: string,
  action: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await driveRequest(token, url, init)
  if (!response.ok) {
    // Do not surface Google's response body: it can echo account details.
    await response.body?.cancel()
    throw new Error(`Google Drive ${action} failed (${response.status}).`)
  }
  return (await response.json()) as T
}

type DriveFileRecord = { id: string; size?: string; modifiedTime?: string }

async function findDriveFile(
  token: string,
  query: string,
): Promise<DriveFileRecord | null> {
  const url = new URL(`${DRIVE_API}/files`)
  url.searchParams.set('q', `${query} and trashed=false`)
  url.searchParams.set('orderBy', 'modifiedTime desc')
  url.searchParams.set('pageSize', '1')
  url.searchParams.set('fields', 'files(id,size,modifiedTime)')
  const data = await driveJson<{ files?: DriveFileRecord[] }>(
    token,
    url.toString(),
    'lookup',
  )
  return data.files?.[0] ?? null
}

// BladeVault only sees Drive files it created, so the same Google account
// finds this backup from any device signed in through BladeVault.
function findBackupFile(token: string) {
  return findDriveFile(
    token,
    `name='${DRIVE_BACKUP_FILE_NAME}' and mimeType!='${FOLDER_MIME_TYPE}'`,
  )
}

async function ensureBackupFolder(token: string): Promise<string> {
  const existing = await findDriveFile(
    token,
    `name='${DRIVE_BACKUP_FOLDER_NAME}' and mimeType='${FOLDER_MIME_TYPE}'`,
  )
  if (existing) return existing.id
  const created = await driveJson<{ id: string }>(
    token,
    `${DRIVE_API}/files?fields=id`,
    'folder setup',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: DRIVE_BACKUP_FOLDER_NAME,
        mimeType: FOLDER_MIME_TYPE,
      }),
    },
  )
  return created.id
}

function toBackupFile(record: DriveFileRecord | null): DriveBackupFile | null {
  if (!record?.modifiedTime) return null
  return {
    modifiedTime: record.modifiedTime,
    size: Number(record.size ?? 0) || 0,
  }
}

export async function getDriveBackupStatus(
  dataDir = getLocalDataDirPath(),
): Promise<DriveBackupStatus> {
  if (!(await isDriveConnected(dataDir))) {
    return { available: true, connected: false, file: null, message: null }
  }
  try {
    const token = await getDriveAccessToken(dataDir)
    return {
      available: true,
      connected: true,
      file: toBackupFile(await findBackupFile(token)),
      message: null,
    }
  } catch (error) {
    if (error instanceof DriveNotConnectedError) {
      return {
        available: true,
        connected: false,
        file: null,
        // A disconnect that overlaps this read needs no explanation.
        message: error.revoked ? error.message : null,
      }
    }
    return {
      available: true,
      connected: true,
      file: null,
      message:
        error instanceof Error ? error.message : 'Could not read Google Drive.',
    }
  }
}

export async function uploadDriveBackup(
  archivePath: string,
  dataDir = getLocalDataDirPath(),
) {
  const token = await getDriveAccessToken(dataDir, true)
  const { size } = await fs.stat(archivePath)
  const existing = await findBackupFile(token)
  // Drive reports the stored size only when it is requested; the size confirms
  // the whole archive arrived.
  // Replacing the same file keeps one backup in Drive. Drive retains the
  // previous version for a while without counting it against storage.
  const session = await driveRequest(
    token,
    existing
      ? `${DRIVE_UPLOAD_API}/files/${existing.id}?uploadType=resumable&fields=id,size`
      : `${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=id,size`,
    {
      method: existing ? 'PATCH' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'application/gzip',
        'X-Upload-Content-Length': String(size),
      },
      body: JSON.stringify(
        existing
          ? {}
          : {
              name: DRIVE_BACKUP_FILE_NAME,
              parents: [await ensureBackupFolder(token)],
            },
      ),
    },
  )
  const sessionUrl = session.headers.get('Location')
  await session.body?.cancel()
  if (!session.ok || !sessionUrl) {
    throw new Error(
      session.status === 403
        ? 'Google Drive refused the backup. Your Drive storage may be full.'
        : `Google Drive upload could not start (${session.status}).`,
    )
  }

  const signal = AbortSignal.timeout(24 * 60 * 60 * 1000)
  const source = createReadStream(archivePath, { highWaterMark: 64 * 1024 })
  const body = new PassThrough({ highWaterMark: 64 * 1024 })
  const transfer = pipeline(source, body, { signal })
  // Attach a handler immediately: the disk stream can fail before fetch settles.
  void transfer.catch(() => {})
  try {
    // The session URL itself authorizes this upload; no token is attached.
    const response = await fetch(sessionUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Length': String(size),
      },
      body: body as unknown as BodyInit,
      duplex: 'half',
      signal,
    } as RequestInit & { duplex: 'half' })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(
        response.status === 403
          ? 'Google Drive refused the backup. Your Drive storage may be full.'
          : `Google Drive upload failed (${response.status}).`,
      )
    }
    const saved = (await response.json()) as { size?: string }
    await transfer
    if (Number(saved.size) !== size) {
      throw new Error('Google Drive stored an incomplete backup. Try again.')
    }
  } finally {
    source.destroy()
    body.destroy()
    await transfer.catch(() => {})
  }
}

export async function downloadDriveBackup(
  archivePath: string,
  dataDir = getLocalDataDirPath(),
) {
  const token = await getDriveAccessToken(dataDir, true)
  const file = await findBackupFile(token)
  if (!file) throw new Error('There is no Google Drive backup to restore.')
  if (Number(file.size ?? 0) > MAX_ARCHIVE_BYTES) {
    throw new Error('Backup archive exceeds the supported restore size.')
  }
  const signal = AbortSignal.timeout(12 * 60 * 60 * 1000)
  const response = await driveRequest(
    token,
    `${DRIVE_API}/files/${file.id}?alt=media`,
    { signal },
  )
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Google Drive download failed (${response.status}).`)
  }
  if (!response.body)
    throw new Error('Google Drive returned an empty response body.')
  await pipeline(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    new RestoreSizeLimitStream(MAX_ARCHIVE_BYTES),
    createWriteStream(archivePath, { mode: 0o600 }),
    { signal },
  )
}
