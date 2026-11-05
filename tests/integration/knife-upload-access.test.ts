import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { config } from '@/proxy'
import { GET as listKnives, POST } from '@/app/api/knives/route'
import { DELETE, GET as getKnife, PATCH } from '@/app/api/knives/[id]/route'
import { setAppLockPassword } from '@/lib/app-lock'
import { getLocalDb } from '@/lib/local-db'
import {
  acquireVaultRestore,
  getVaultGeneration,
  VAULT_GENERATION_HEADER,
  type VaultRestoreLease,
} from '@/lib/vault-access'
import { withUnproxiedVaultRequest } from '@/lib/vault-request-guard'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

describe('photo upload proxy matching', () => {
  it.each(['/api/knives', '/api/knives/knife-1', '/api/knives/knife-1/'])(
    'leaves %s bodies intact for the guarded route handler',
    (url) => {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false)
    },
  )

  it.each([
    '/api/knives/bulk',
    '/api/knives/bulk/pin',
    '/api/knives/knife-1/maintenance',
    '/api/knives/knife-1/screenshot',
    '/api/knives-other',
    '/collection/knife-1',
    '/api/settings',
  ])('keeps proxy access checks for %s', (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true)
  })
})

const params = { params: Promise.resolve({ id: 'knife-1' }) }
const routes = [
  { method: 'GET', path: '/api/knives', run: listKnives },
  {
    method: 'GET',
    path: '/api/knives/knife-1',
    run: (request: Request) => getKnife(request, params),
  },
  { method: 'POST', path: '/api/knives', run: POST },
  {
    method: 'PATCH',
    path: '/api/knives/knife-1',
    run: (request: Request) => PATCH(request, params),
  },
  {
    method: 'DELETE',
    path: '/api/knives/knife-1',
    run: (request: Request) => DELETE(request, params),
  },
]

describe('unproxied knife route access', () => {
  let vault: TempVault
  let lease: VaultRestoreLease | undefined

  beforeEach(async () => {
    vault = await createTempVault('bladevault-photo-access-')
  })

  afterEach(async () => {
    lease?.release()
    lease = undefined
    await vault.cleanup()
  })

  function requestFor(route: (typeof routes)[number], headers?: HeadersInit) {
    return new Request(`http://localhost${route.path}`, {
      method: route.method,
      headers,
      // Invalid JSON verifies that guards run before body parsing.
      ...(route.method !== 'GET' ? { body: '{' } : {}),
    })
  }

  it('preserves generation headers on knife reads and mutations', async () => {
    const generation = getVaultGeneration()
    const created = await POST(
      new Request('http://localhost/api/knives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Photo upload' }),
      }),
    )
    expect(created.status).toBe(200)
    const { knife } = await created.json()
    const context = { params: Promise.resolve({ id: knife.id }) }
    const url = `http://localhost/api/knives/${knife.id}`
    const responses = [
      created,
      await listKnives(new Request('http://localhost/api/knives')),
      await getKnife(new Request(url), context),
      await PATCH(
        new Request(url, {
          method: 'PATCH',
          body: JSON.stringify({ description: 'Updated' }),
        }),
        context,
      ),
      await DELETE(new Request(url, { method: 'DELETE' }), context),
    ]
    for (const response of responses) {
      expect(response.status).toBe(200)
      expect(response.headers.get(VAULT_GENERATION_HEADER)).toBe(generation)
    }
  })

  it('captures the response generation before asynchronous route work', async () => {
    const generation = getVaultGeneration()
    const response = await withUnproxiedVaultRequest(
      new Request('http://localhost/api/knives'),
      async () => {
        lease = acquireVaultRestore()
        await lease.beginSwitch()
        lease.finish(true)
        return Response.json({ knives: [] })
      },
    )
    expect(getVaultGeneration()).not.toBe(generation)
    expect(response.headers.get(VAULT_GENERATION_HEADER)).toBe(generation)
  })

  it.each(routes)(
    'blocks locked $method $path before reading the body',
    async (route) => {
      setAppLockPassword('photo-test')
      const request = requestFor(route)
      const response = await route.run(request)
      expect(response.status).toBe(401)
      expect(request.bodyUsed).toBe(false)
    },
  )

  it.each(routes)(
    'blocks $method $path while switching vaults',
    async (route) => {
      getLocalDb()
      lease = acquireVaultRestore()
      await lease.beginSwitch()
      const request = requestFor(route)
      const response = await route.run(request)
      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toMatchObject({
        code: 'VAULT_RESTORE_BUSY',
      })
      expect(request.bodyUsed).toBe(false)
    },
  )

  it.each(routes.filter((route) => route.method !== 'GET'))(
    'blocks stale $method $path before reading the body',
    async (route) => {
      const request = requestFor(route, {
        [VAULT_GENERATION_HEADER]: 'stale-generation',
      })
      const response = await route.run(request)
      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({
        code: 'VAULT_CHANGED',
      })
      expect(request.bodyUsed).toBe(false)
    },
  )

  it.each(routes.filter((route) => route.method !== 'GET'))(
    'blocks $method $path during restore preparation',
    async (route) => {
      getLocalDb()
      lease = acquireVaultRestore()
      const request = requestFor(route)
      const response = await route.run(request)
      expect(response.status).toBe(423)
      await expect(response.json()).resolves.toMatchObject({
        code: 'VAULT_RESTORE_BUSY',
      })
      expect(request.bodyUsed).toBe(false)
    },
  )
})
