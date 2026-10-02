import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { performance } from 'node:perf_hooks'
import { GET as status, POST as update } from '@/app/api/app-lock/route'
import { GET as settings } from '@/app/api/settings/route'
import { GET as knives, POST as addKnife } from '@/app/api/knives/route'
import { GET as comparisons } from '@/app/api/comparisons/route'
import { GET as backup } from '@/app/api/local-backup/archive/route'
import { GET as images } from '@/app/api/images/[...path]/route'
import { POST as scrape } from '@/app/api/scrape/route'
import { GET as mcpSettings } from '@/app/api/settings/mcp/route'
import { closeLocalDb, getLocalDb } from '@/lib/local-db'
import {
  createAppUnlockToken,
  isAppUnlocked,
  setAppLockPassword,
} from '@/lib/app-lock'
import {
  APP_LOCK_COOKIE,
  APP_LOCK_HEADER,
  getUnlockDestination,
} from '@/lib/app-lock-shared'
import { replaceLocalDataFromDirectory } from '@/lib/local-data-restore'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'
import fs from 'node:fs/promises'
import path from 'node:path'

vi.mock('node:perf_hooks', () => ({ performance: { timeOrigin: 100 } }))

let vault: TempVault
beforeEach(async () => {
  vault = await createTempVault('bladevault-app-lock-')
  Object.assign(performance, { timeOrigin: 100 })
})
afterEach(async () => {
  await vault.cleanup()
})

function request(body?: object, cookie?: string) {
  return new Request('http://localhost/api/app-lock', {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

function cookieOf(response: Response): string {
  return response.headers.get('set-cookie')!.split(';')[0]
}

describe('local App lock', () => {
  it('accepts the browser Host when Next uses an internal server URL', async () => {
    const response = await update(
      new Request('http://localhost:3000/api/app-lock', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:3297',
          origin: 'http://127.0.0.1:3297',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'set-password',
          password: 'test',
          confirmPassword: 'test',
        }),
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).not.toContain('Secure')
  })
  it('defaults to unlocked and persists a password without exposing it in settings', async () => {
    expect(await (await status(request())).json()).toEqual({
      enabled: false,
      unlocked: true,
    })
    const response = await update(
      request({
        action: 'set-password',
        password: 'local test',
        confirmPassword: 'local test',
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
    expect(response.headers.get('set-cookie')).not.toContain('Expires=')
    closeLocalDb()
    expect(await (await status(request())).json()).toEqual({
      enabled: true,
      unlocked: false,
    })
    const unlocked = cookieOf(response)
    expect(await (await status(request(undefined, unlocked))).json()).toEqual({
      enabled: true,
      unlocked: true,
    })
    const result = await settings(request(undefined, unlocked))
    expect(result.status).toBe(200)
    expect(await result.text()).not.toContain('local test')
  })

  it('blocks direct reads, downloads and mutations before handlers run', async () => {
    setAppLockPassword('test')
    const blocked = await Promise.all([
      settings(request()),
      knives(request()),
      comparisons(request()),
      backup(request()),
      mcpSettings(request()),
      addKnife(request({ name: 'Must not be created' })),
      scrape(request({ url: 'https://example.com' })),
      images(request(), { params: Promise.resolve({ path: ['missing.png'] }) }),
    ])
    for (const response of blocked) {
      expect(response.status).toBe(401)
      expect(response.headers.get(APP_LOCK_HEADER)).toBe('1')
    }
    expect(
      getLocalDb().prepare('SELECT COUNT(*) AS total FROM knives').get(),
    ).toEqual({ total: 0 })
  })

  it('rejects wrong passwords, mismatched confirmation, and changes without an unlocked session', async () => {
    expect(
      (
        await update(
          request({
            action: 'set-password',
            password: 'test',
            confirmPassword: 'different',
          }),
        )
      ).status,
    ).toBe(400)
    setAppLockPassword('test')
    expect(
      (await update(request({ action: 'unlock', password: 'wrong' }))).status,
    ).toBe(401)
    expect(
      (await update(request({ action: 'disable', currentPassword: 'test' })))
        .status,
    ).toBe(401)
    const unlocked = cookieOf(
      await update(request({ action: 'unlock', password: 'test' })),
    )
    expect(
      (
        await update(
          request({ action: 'disable', currentPassword: 'wrong' }, unlocked),
        )
      ).status,
    ).toBe(401)
  })

  it('changes the password, invalidates older sessions, and disables with the current password', async () => {
    setAppLockPassword('first')
    const first = cookieOf(
      await update(request({ action: 'unlock', password: 'first' })),
    )
    const changed = await update(
      request(
        {
          action: 'set-password',
          currentPassword: 'first',
          password: 'second',
          confirmPassword: 'second',
        },
        first,
      ),
    )
    expect(changed.status).toBe(200)
    expect(
      await (await status(request(undefined, first))).json(),
    ).toMatchObject({ unlocked: false })
    expect(
      (await update(request({ action: 'unlock', password: 'first' }))).status,
    ).toBe(401)
    const second = cookieOf(changed)
    const disabled = await update(
      request({ action: 'disable', currentPassword: 'second' }, second),
    )
    expect(await disabled.json()).toEqual({ enabled: false, unlocked: true })
    expect((await knives(request())).status).toBe(200)
  })

  it('clears the cookie on Lock now, rejects tampering, and expires sessions on server restart', async () => {
    setAppLockPassword('test')
    const token = createAppUnlockToken()
    expect(isAppUnlocked(token)).toBe(true)
    expect(
      isAppUnlocked(`${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`),
    ).toBe(false)
    const locked = await update(
      request({ action: 'lock' }, `${APP_LOCK_COOKIE}=${token}`),
    )
    expect(locked.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(await locked.json()).toEqual({ enabled: true, unlocked: false })
    Object.assign(performance, { timeOrigin: 200 })
    expect(isAppUnlocked(token)).toBe(false)
    expect(isAppUnlocked(createAppUnlockToken())).toBe(true)
  })

  it('supports manual SQLite password replacement and removal', async () => {
    setAppLockPassword('first')
    const token = createAppUnlockToken()
    getLocalDb()
      .prepare('UPDATE settings SET value = ? WHERE key = ?')
      .run('replacement', 'app_lock_password')
    expect(isAppUnlocked(token)).toBe(false)
    expect(
      (await update(request({ action: 'unlock', password: 'replacement' })))
        .status,
    ).toBe(200)
    getLocalDb()
      .prepare('DELETE FROM settings WHERE key = ?')
      .run('app_lock_password')
    expect(isAppUnlocked()).toBe(true)
  })

  it('restores the backup password and invalidates sessions even for the same vault snapshot', async () => {
    setAppLockPassword('backed-up')
    const token = createAppUnlockToken()
    const source = `${vault.dataDir}-snapshot`
    await fs.mkdir(source)
    await getLocalDb().backup(path.join(source, 'bladevault.sqlite'))
    try {
      await replaceLocalDataFromDirectory(source)
    } finally {
      await fs.rm(source, { recursive: true, force: true })
    }
    expect(isAppUnlocked(token)).toBe(false)
    expect(
      (await update(request({ action: 'unlock', password: 'backed-up' })))
        .status,
    ).toBe(200)
  })

  it('keeps unlock destinations inside the app', () => {
    expect(getUnlockDestination('/collection?sort=brand')).toBe(
      '/collection?sort=brand',
    )
    for (const value of [
      'https://example.com',
      '//example.com',
      '/\\example.com',
      '/unlock?next=/unlock',
    ])
      expect(getUnlockDestination(value)).toBe('/')
  })
})
