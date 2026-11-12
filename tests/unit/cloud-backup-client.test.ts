import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getCloudBackupJob,
  startCloudBackupArchive,
} from '@/lib/cloud-backup-client'

const runningJob = {
  id: 'backup-1',
  status: 'running',
  phase: 'preparing',
  message: null,
}

describe('background cloud backup client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([true, false])(
    'starts a Google Drive job without browser credentials and preserves started=%s',
    async (started) => {
      const result = { job: runningJob, started }
      const response = new Response(JSON.stringify(result), {
        status: 202,
      })
      const blob = vi.spyOn(response, 'blob')
      vi.mocked(fetch).mockResolvedValueOnce(response)

      await expect(startCloudBackupArchive()).resolves.toEqual(result)

      expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/cloud-backup/job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(blob).not.toHaveBeenCalled()
    },
  )

  it('reads the current job without caching status', async () => {
    const finishedJob = { ...runningJob, status: 'success', phase: null }
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ job: finishedJob })),
    )

    await expect(getCloudBackupJob()).resolves.toEqual(finishedJob)

    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/cloud-backup/job', {
      cache: 'no-store',
    })
  })

  it('surfaces the server error when starting a job fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'Connect Google Drive before starting a backup.',
        }),
        { status: 400 },
      ),
    )

    await expect(startCloudBackupArchive()).rejects.toThrow(
      'Connect Google Drive before starting a backup.',
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
})
