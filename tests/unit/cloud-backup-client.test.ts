import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getCloudAuthState,
  loadCloudRuntimeConfig,
  refreshCloudBackupAccessToken,
} = vi.hoisted(() => ({
  getCloudAuthState: vi.fn(),
  loadCloudRuntimeConfig: vi.fn(),
  refreshCloudBackupAccessToken: vi.fn(),
}))

vi.mock('@/lib/cloud-backup', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/cloud-backup')>()
  return {
    ...original,
    getCloudAuthState,
    getCloudRuntimeConfig: vi.fn(),
    loadCloudRuntimeConfig,
    refreshCloudBackupAccessToken,
  }
})

import {
  getCloudBackupJob,
  startCloudBackupArchive,
} from '@/lib/cloud-backup-client'

const runningJob = {
  id: 'backup-1',
  status: 'running',
  phase: 'preparing',
  syncedAt: null,
  message: null,
}

describe('background cloud backup client', () => {
  beforeEach(() => {
    getCloudAuthState.mockReset().mockReturnValue({
      accessToken: 'expired-access-token',
      expiresAt: '2000-01-01T00:00:00.000Z',
      sessionToken: 'session-token',
    })
    loadCloudRuntimeConfig.mockReset().mockResolvedValue({
      authUrl: 'https://auth.example.com',
      backupUrl: 'https://backup.example.com',
    })
    refreshCloudBackupAccessToken.mockReset()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([true, false])(
    'submits a session token with an expired access token and preserves started=%s',
    async (started) => {
      const result = { job: runningJob, started }
      const response = new Response(JSON.stringify(result), {
        status: 202,
      })
      const blob = vi.spyOn(response, 'blob')
      vi.mocked(fetch).mockResolvedValueOnce(response)

      await expect(startCloudBackupArchive()).resolves.toEqual(result)

      expect(loadCloudRuntimeConfig).toHaveBeenCalledOnce()
      expect(refreshCloudBackupAccessToken).not.toHaveBeenCalled()
      expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/cloud-backup/job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken: 'session-token' }),
      })
      expect(blob).not.toHaveBeenCalled()
    },
  )

  it('reads the current job without refreshing credentials or caching status', async () => {
    const finishedJob = {
      ...runningJob,
      status: 'success',
      phase: null,
      syncedAt: '2026-10-08T11:00:00.000Z',
    }
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ job: finishedJob })),
    )

    await expect(getCloudBackupJob()).resolves.toEqual(finishedJob)

    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/cloud-backup/job', {
      cache: 'no-store',
    })
    expect(loadCloudRuntimeConfig).not.toHaveBeenCalled()
    expect(getCloudAuthState).not.toHaveBeenCalled()
    expect(refreshCloudBackupAccessToken).not.toHaveBeenCalled()
  })

  it('surfaces the server error when starting a job fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Cloud Backup is disconnected.' }), {
        status: 401,
      }),
    )

    await expect(startCloudBackupArchive()).rejects.toThrow(
      'Cloud Backup is disconnected.',
    )
  })

  it('surfaces the server error when checking the job fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Could not read backup status.' }), {
        status: 503,
      }),
    )

    await expect(getCloudBackupJob()).rejects.toThrow(
      'Could not read backup status.',
    )
  })

  it('requires sign-in before submitting a job without a session token', async () => {
    getCloudAuthState.mockReturnValueOnce(null)

    await expect(startCloudBackupArchive()).rejects.toThrow(
      'Sign in before starting a cloud backup.',
    )
    expect(fetch).not.toHaveBeenCalled()
    expect(refreshCloudBackupAccessToken).not.toHaveBeenCalled()
  })
})
