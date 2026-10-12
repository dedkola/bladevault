// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createVaultFetchGuard,
  getCloudRestoreJob,
  getVaultStatus,
  startCloudRestore,
} from '@/lib/cloud-restore-client'
import { IDLE_CLOUD_RESTORE_JOB } from '@/lib/cloud-restore-shared'
import { VAULT_GENERATION_HEADER } from '@/lib/vault-access-shared'
import {
  INITIAL_VAULT_CLIENT_STATE,
  setVaultClientState,
  type VaultClientState,
} from '@/lib/vault-client-state'
import { getImageUrl } from '@/lib/data'

const { getCloudAuthState } = vi.hoisted(() => ({
  getCloudAuthState: vi.fn(),
}))
vi.mock('@/lib/cloud-backup', () => ({ getCloudAuthState }))

const idle: VaultClientState = {
  generation: 'vault-before',
  phase: 'idle',
  readOnly: false,
}
const runningJob = {
  ...IDLE_CLOUD_RESTORE_JOB,
  id: 'restore-1',
  status: 'running' as const,
  phase: 'downloading' as const,
}

describe('cloud restore client', () => {
  beforeEach(() => {
    getCloudAuthState.mockReset().mockReturnValue({ sessionToken: 'session' })
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    setVaultClientState(INITIAL_VAULT_CLIENT_STATE)
  })

  it.each([true, false])(
    'starts a server-owned restore and preserves started=%s',
    async (started) => {
      vi.mocked(fetch).mockResolvedValueOnce(
        Response.json({ job: runningJob, started }, { status: 202 }),
      )
      await expect(startCloudRestore()).resolves.toEqual({
        job: runningJob,
        started,
      })
      expect(fetch).toHaveBeenCalledExactlyOnceWith(
        '/api/cloud-backup/restore-job',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionToken: 'session' }),
          signal: expect.any(AbortSignal),
        },
      )
    },
  )

  it('requires sign-in before starting a restore', async () => {
    getCloudAuthState.mockReturnValue(null)
    await expect(startCloudRestore()).rejects.toThrow(
      'Sign in before restoring',
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('tags restore initiation with the generation shown in a stale browser tab', async () => {
    setVaultClientState({ ...idle, generation: 'previous-vault' })
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        { error: 'The vault was restored. Refresh first.' },
        { status: 409 },
      ),
    )
    await expect(startCloudRestore()).rejects.toThrow('Refresh first.')
    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect(new Headers(init?.headers).get(VAULT_GENERATION_HEADER)).toBe(
      'previous-vault',
    )
  })

  it('reads job and vault status without cached responses', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ job: runningJob }))
      .mockResolvedValueOnce(Response.json(idle))
    await expect(getCloudRestoreJob()).resolves.toEqual(runningJob)
    await expect(getVaultStatus()).resolves.toEqual(idle)
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/cloud-backup/restore-job', {
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    })
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/vault/status', {
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    })
  })

  it('surfaces server errors instead of treating them as restore success', async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      Response.json({ error: 'Backup is busy.' }, { status: 409 }),
    )
    await expect(startCloudRestore()).rejects.toThrow('Backup is busy.')
    await expect(getCloudRestoreJob()).rejects.toThrow('Backup is busy.')
    await expect(getVaultStatus()).rejects.toThrow('Backup is busy.')
  })

  it('adopts protected recovery status when the proxy temporarily cannot open the vault', async () => {
    setVaultClientState({ ...idle, appLockEnabled: true })
    const recovery = {
      ...idle,
      phase: 'switching',
      readOnly: true,
      recoveryRequired: true,
    }
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        {
          error: 'Vault recovery is required before continuing.',
          code: 'VAULT_RESTORE_BUSY',
          vault: recovery,
        },
        { status: 503 },
      ),
    )
    await expect(getVaultStatus()).resolves.toEqual({
      ...recovery,
      appLockEnabled: true,
    })
  })

  it('changes local image URLs after a vault generation change', () => {
    setVaultClientState(idle)
    const oldUrl = getImageUrl('knife/image-01.webp')
    setVaultClientState({ ...idle, generation: 'vault-after' })
    expect(getImageUrl('knife/image-01.webp')).not.toBe(oldUrl)
    expect(getImageUrl('knife/image-01.webp')).toBe(
      '/api/images/knife/image-01.webp?vault=vault-after',
    )
    expect(getImageUrl('https://example.com/image.webp')).toBe(
      'https://example.com/image.webp',
    )
  })
})

describe('vault fetch guard', () => {
  let state: VaultClientState
  const origin = 'http://localhost'
  let originalFetch: ReturnType<typeof vi.fn<typeof fetch>>
  let onGenerationChange: ReturnType<typeof vi.fn<(generation: string) => void>>

  beforeEach(() => {
    state = { ...idle }
    originalFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true }))
    onGenerationChange = vi.fn<(generation: string) => void>()
  })

  function guard() {
    return createVaultFetchGuard(originalFetch, {
      origin,
      getState: () => state,
      onGenerationChange,
    })
  }

  it('allows browsing but blocks local mutations while restore is preparing', async () => {
    state = { ...state, phase: 'preparing', readOnly: true }
    const guarded = guard()
    expect((await guarded('/api/knives')).status).toBe(200)
    const blocked = await guarded('/api/knives/knife', { method: 'PATCH' })
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toMatchObject({
      error: expect.stringContaining('read-only'),
    })
    expect(originalFetch).toHaveBeenCalledOnce()
  })

  it('preserves request headers while tagging writes with the displayed vault generation', async () => {
    const request = new Request(`${origin}/api/knives/knife`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Example': 'existing' },
      body: '{}',
    })
    await guard()(request)
    const [, init] = originalFetch.mock.calls[0]
    const headers = new Headers(init?.headers)
    expect(headers.get(VAULT_GENERATION_HEADER)).toBe('vault-before')
    expect(headers.get('X-Example')).toBe('existing')
    expect(request.headers.has(VAULT_GENERATION_HEADER)).toBe(false)
  })

  it('keeps remote authentication and restore controls available', async () => {
    state = { ...state, phase: 'preparing', readOnly: true }
    const guarded = guard()
    const init = { method: 'POST' }
    for (const url of [
      'https://auth.example.com/api/auth/token',
      '/api/app-lock',
      '/api/cloud-backup/restore-job',
    ]) {
      expect((await guarded(url, init)).status).toBe(200)
    }
    expect(originalFetch).toHaveBeenNthCalledWith(
      1,
      'https://auth.example.com/api/auth/token',
      init,
    )
    expect(onGenerationChange).not.toHaveBeenCalled()
  })

  it('discards a late response from the previous vault without adopting its old generation', async () => {
    let finish!: (response: Response) => void
    originalFetch.mockReturnValue(
      new Promise<Response>((resolve) => {
        finish = resolve
      }),
    )
    const pending = guard()('/api/knives')
    state = { ...state, generation: 'vault-after' }
    finish(
      Response.json(
        { knives: ['old'] },
        { headers: { [VAULT_GENERATION_HEADER]: 'vault-before' } },
      ),
    )
    expect((await pending).status).toBe(409)
    expect(onGenerationChange).not.toHaveBeenCalled()
  })

  it('requests a refresh when the server rejects an old generation', async () => {
    originalFetch.mockResolvedValue(
      Response.json(
        { error: 'Vault changed.' },
        {
          status: 409,
          headers: { [VAULT_GENERATION_HEADER]: 'vault-after' },
        },
      ),
    )
    expect(
      (await guard()('/api/knives/knife', { method: 'PATCH' })).status,
    ).toBe(409)
    expect(onGenerationChange).toHaveBeenCalledExactlyOnceWith('vault-after')
  })

  it('stops generation callbacks when a layered fetch guard has been unmounted', async () => {
    let active = true
    let finish!: (response: Response) => void
    originalFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finish = resolve
      }),
    )
    const guarded = createVaultFetchGuard(originalFetch, {
      origin,
      getState: () => state,
      isActive: () => active,
      onGenerationChange,
    })
    const pending = guarded('/api/knives')
    active = false
    finish(
      Response.json(
        { knives: [] },
        { headers: { [VAULT_GENERATION_HEADER]: 'vault-after' } },
      ),
    )
    expect((await pending).status).toBe(200)
    state = { ...state, readOnly: true }
    expect(
      (await guarded('/api/knives/knife', { method: 'PATCH' })).status,
    ).toBe(200)
    expect(originalFetch).toHaveBeenCalledTimes(2)
    expect(onGenerationChange).not.toHaveBeenCalled()
  })
})
