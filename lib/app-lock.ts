import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { getLocalDb, getLocalDbPath } from '@/lib/local-db'
import {
  getVaultAccessState,
  VaultAccessError,
  withVaultWriteSync,
} from '@/lib/vault-access'
import {
  APP_LOCK_COOKIE,
  APP_LOCK_HEADER,
  type AppLockStatus,
} from '@/lib/app-lock-shared'

const PASSWORD_KEY = 'app_lock_password'
const SECRET_KEY = 'app_lock_session_secret'
const SNAPSHOTS = Symbol.for('bladevault.app-lock-access-snapshots')

type LockSnapshot = {
  generation: string
  password: string
  secret: string
}

function getSnapshots() {
  const runtime = globalThis as typeof globalThis & {
    [SNAPSHOTS]?: Map<string, LockSnapshot>
  }
  return (runtime[SNAPSHOTS] ??= new Map())
}

function getLockSettings() {
  const access = getVaultAccessState()
  const databasePath = getLocalDbPath()
  if (access.phase === 'switching') {
    const snapshot = getSnapshots().get(databasePath)
    if (!snapshot || snapshot.generation !== access.generation)
      throw new VaultAccessError('VAULT_RESTORE_BUSY', access)
    return snapshot
  }
  const rows = getLocalDb()
    .prepare('SELECT key, value FROM settings WHERE key IN (?, ?)')
    .all(PASSWORD_KEY, SECRET_KEY) as Array<{ key: string; value: string }>
  const values = new Map(rows.map(({ key, value }) => [key, value]))
  const snapshot = {
    generation: access.generation,
    password: values.get(PASSWORD_KEY) || '',
    secret: values.get(SECRET_KEY) || '',
  }
  getSnapshots().set(databasePath, snapshot)
  return snapshot
}

export function captureAppLockAccessSnapshot(): void {
  getLockSettings()
}

export function isAppLockEnabled(): boolean {
  return Boolean(getLockSettings().password)
}

export function appLockPasswordMatches(password: string): boolean {
  return password === getLockSettings().password
}

export function invalidateAppLockSessions(): void {
  withVaultWriteSync(() => {
    getLocalDb()
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(SECRET_KEY, randomBytes(32).toString('base64url'))
  })
}

export function setAppLockPassword(password: string): void {
  return withVaultWriteSync(() => setAppLockPasswordInternal(password))
}

function setAppLockPasswordInternal(password: string): void {
  const database = getLocalDb()
  database.transaction(() => {
    if (password) {
      database
        .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .run(PASSWORD_KEY, password)
      invalidateAppLockSessions()
    } else {
      database
        .prepare('DELETE FROM settings WHERE key IN (?, ?)')
        .run(PASSWORD_KEY, SECRET_KEY)
    }
  })()
}

function signature(nonce: string): string {
  const { password, secret } = getLockSettings()
  // Node's timeOrigin belongs to the server process, including its route/proxy
  // bundles. A new process invalidates cookies without a session table.
  const key = JSON.stringify([
    password,
    secret,
    getLocalDbPath(),
    process.pid,
    performance.timeOrigin,
  ])
  return createHmac('sha256', key).update(nonce).digest('base64url')
}

export function createAppUnlockToken(): string {
  const nonce = randomBytes(32).toString('base64url')
  return `${nonce}.${signature(nonce)}`
}

export function isAppUnlocked(token?: string): boolean {
  if (!isAppLockEnabled()) return true
  if (!token || !/^[\w-]{43}\.[\w-]{43}$/.test(token)) return false
  const [nonce, actual] = token.split('.')
  const expected = signature(nonce)
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}

export function getAppUnlockCookie(request: Request): string | undefined {
  return request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${APP_LOCK_COOKIE}=`))
    ?.slice(APP_LOCK_COOKIE.length + 1)
}

export function getAppLockStatus(request: Request): AppLockStatus {
  return {
    enabled: isAppLockEnabled(),
    unlocked: isAppUnlocked(getAppUnlockCookie(request)),
  }
}

export function requireAppUnlock(request: Request): Response | null {
  if (isAppUnlocked(getAppUnlockCookie(request))) return null
  return Response.json(
    { error: 'Unlock BladeVault to continue.' },
    {
      status: 401,
      headers: { 'Cache-Control': 'no-store', [APP_LOCK_HEADER]: '1' },
    },
  )
}
