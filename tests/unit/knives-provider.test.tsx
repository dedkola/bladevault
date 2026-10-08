// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  KnivesProvider,
  useKnives,
} from '@/components/providers/knives-provider'
import {
  IDLE_CLOUD_BACKUP_JOB,
  type CloudBackupJobState,
} from '@/lib/cloud-backup-shared'
import { SETTINGS_UPDATED_EVENT } from '@/lib/settings-shared'
import { createKnife } from '@/tests/fixtures/knife'

const { getCloudBackupJob, startCloudBackupArchive } = vi.hoisted(() => ({
  getCloudBackupJob: vi.fn(),
  startCloudBackupArchive: vi.fn(),
}))

vi.mock('@/lib/cloud-backup-client', () => ({
  canAttemptSilentCloudBackup: () => true,
  getCloudBackupJob,
  startCloudBackupArchive,
}))

vi.mock('@/lib/cloud-backup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cloud-backup')>()
  return {
    ...actual,
    getCloudAuthState: () => ({
      accessToken: 'access',
      sessionToken: 'session',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: '1', email: 'user@example.com', name: 'User' },
    }),
  }
})

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function ProviderConsumer({ page = 'Settings' }: { page?: string }) {
  const {
    addToCompare,
    cloudBackupJob,
    isLoading,
    scheduleVaultBackup,
    startVaultBackup,
    updateKnife,
  } = useKnives()

  return (
    <div>
      <h1>{page}</h1>
      <span>{isLoading ? 'loading' : 'ready'}</span>
      <span data-testid="backup-status">{cloudBackupJob.status}</span>
      <button onClick={() => void updateKnife('knife', { brand: 'Changed' })}>
        Edit
      </button>
      <button onClick={() => void updateKnife('knife', { pinned: true })}>
        Pin
      </button>
      <button onClick={() => void addToCompare('knife')}>Compare</button>
      <button onClick={scheduleVaultBackup}>Maintenance mutation</button>
      <button onClick={() => void startVaultBackup()}>Backup now</button>
    </div>
  )
}

async function renderProvider() {
  let rendered: ReturnType<typeof render> | undefined
  await act(async () => {
    rendered = render(
      <KnivesProvider>
        <ProviderConsumer />
      </KnivesProvider>,
    )
  })
  expect(screen.getByText('ready')).toBeInTheDocument()
  return rendered!
}

async function clickButton(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

async function advanceTime(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds)
  })
}

async function disableAutomaticBackup() {
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent(SETTINGS_UPDATED_EVENT, {
        detail: { cloudAutoBackupEnabled: false },
      }),
    )
  })
}

describe('KnivesProvider background backup', () => {
  let serverJob: CloudBackupJobState

  beforeEach(() => {
    vi.useFakeTimers()
    serverJob = { ...IDLE_CLOUD_BACKUP_JOB }
    getCloudBackupJob.mockReset().mockImplementation(async () => serverJob)
    startCloudBackupArchive.mockReset().mockImplementation(async () => {
      serverJob = {
        ...IDLE_CLOUD_BACKUP_JOB,
        id: `backup-${startCloudBackupArchive.mock.calls.length}`,
        status: 'running',
        phase: 'preparing',
      }
      return { job: serverJob, started: true }
    })

    const knife = createKnife({ id: 'knife' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === '/api/settings') {
          return jsonResponse({
            settings: {
              cloudAutoBackupEnabled: true,
              pinnedItemsFirst: true,
              timeFormat: '12h',
              cardFields: ['bladeStyle', 'handleMaterial'],
              customFields: [],
            },
          })
        }
        if (url === '/api/cloud-backup/job') {
          return jsonResponse({ job: serverJob })
        }
        if (url === '/api/knives' && !init?.method) {
          return jsonResponse({ knives: [knife] })
        }
        if (url === '/api/compare' && !init?.method) {
          return jsonResponse({ compareIds: [] })
        }
        if (url === '/api/compare' && init?.method === 'POST') {
          return jsonResponse({ compareIds: ['knife'] })
        }
        if (url === '/api/knives/knife' && init?.method === 'PATCH') {
          const updates = JSON.parse(String(init.body)) as Record<
            string,
            unknown
          >
          return jsonResponse({ knife: { ...knife, ...updates } })
        }
        throw new Error(`Unexpected fetch: ${url} ${init?.method ?? 'GET'}`)
      }),
    )
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function finishServerJob() {
    serverJob = {
      ...serverJob,
      status: 'success',
      phase: null,
      syncedAt: '2026-10-08T11:00:00.000Z',
    }
  }

  it('coalesces content edits into one backup after 30 quiet seconds', async () => {
    await renderProvider()

    await clickButton('Edit')
    await advanceTime(20_000)
    await clickButton('Maintenance mutation')
    await advanceTime(29_999)
    expect(startCloudBackupArchive).not.toHaveBeenCalled()

    await advanceTime(1)
    expect(startCloudBackupArchive).toHaveBeenCalledOnce()
    expect(screen.getByTestId('backup-status')).toHaveTextContent('running')
  })

  it('does not schedule a backup for pin-only or comparison changes', async () => {
    await renderProvider()

    await clickButton('Pin')
    await clickButton('Compare')
    await advanceTime(60_000)

    expect(startCloudBackupArchive).not.toHaveBeenCalled()
  })

  it('finishes automatic backup without a success toast', async () => {
    await renderProvider()
    await clickButton('Edit')
    await advanceTime(30_000)
    expect(startCloudBackupArchive).toHaveBeenCalledOnce()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    finishServerJob()
    await advanceTime(5_000)

    expect(screen.getByTestId('backup-status')).toHaveTextContent('success')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('uses one job when a manual backup takes over a scheduled automatic backup', async () => {
    await renderProvider()
    await clickButton('Edit')
    await clickButton('Backup now')
    await clickButton('Backup now')
    expect(startCloudBackupArchive).toHaveBeenCalledOnce()

    finishServerJob()
    await advanceTime(5_000)
    await advanceTime(30_000)

    expect(startCloudBackupArchive).toHaveBeenCalledOnce()
  })

  it('does not duplicate a running automatic job when Backup now is selected', async () => {
    await renderProvider()
    await clickButton('Edit')
    await advanceTime(30_000)
    await clickButton('Backup now')

    expect(screen.getByTestId('backup-status')).toHaveTextContent('running')
    expect(startCloudBackupArchive).toHaveBeenCalledOnce()
  })

  it('keeps an accepted job running when the Settings child is replaced', async () => {
    const rendered = await renderProvider()
    await clickButton('Backup now')
    expect(screen.getByTestId('backup-status')).toHaveTextContent('running')

    await act(async () => {
      rendered.rerender(
        <KnivesProvider>
          <ProviderConsumer key="collection" page="Collection" />
        </KnivesProvider>,
      )
    })
    expect(
      screen.getByRole('heading', { name: 'Collection' }),
    ).toBeInTheDocument()
    expect(screen.getByTestId('backup-status')).toHaveTextContent('running')

    finishServerJob()
    await advanceTime(5_000)

    expect(screen.getByTestId('backup-status')).toHaveTextContent('success')
    expect(startCloudBackupArchive).toHaveBeenCalledOnce()
  })

  it('coalesces edits during a running job into one delayed follow-up backup', async () => {
    await renderProvider()
    await clickButton('Backup now')
    await clickButton('Edit')
    await clickButton('Maintenance mutation')
    await advanceTime(30_000)
    expect(startCloudBackupArchive).toHaveBeenCalledOnce()

    finishServerJob()
    await advanceTime(5_000)
    expect(screen.getByTestId('backup-status')).toHaveTextContent('success')
    expect(startCloudBackupArchive).toHaveBeenCalledOnce()
    await advanceTime(29_999)
    expect(startCloudBackupArchive).toHaveBeenCalledOnce()

    await advanceTime(1)
    expect(startCloudBackupArchive).toHaveBeenCalledTimes(2)
    await advanceTime(30_000)
    expect(startCloudBackupArchive).toHaveBeenCalledTimes(2)
  })

  it('backs up recent edits after joining an older job from another window', async () => {
    await renderProvider()
    startCloudBackupArchive.mockImplementationOnce(async () => {
      serverJob = {
        ...IDLE_CLOUD_BACKUP_JOB,
        id: 'other-window-backup',
        status: 'running',
        phase: 'uploading',
      }
      return { job: serverJob, started: false }
    })
    await clickButton('Edit')
    await advanceTime(30_000)
    expect(startCloudBackupArchive).toHaveBeenCalledOnce()
    expect(screen.getByTestId('backup-status')).toHaveTextContent('running')

    finishServerJob()
    await advanceTime(5_000)
    expect(screen.getByTestId('backup-status')).toHaveTextContent('success')
    await advanceTime(29_999)
    expect(startCloudBackupArchive).toHaveBeenCalledOnce()

    await advanceTime(1)
    expect(startCloudBackupArchive).toHaveBeenCalledTimes(2)
    finishServerJob()
    await advanceTime(60_000)
    expect(startCloudBackupArchive).toHaveBeenCalledTimes(2)
  })

  it('cancels a scheduled backup when automatic backup is disabled', async () => {
    await renderProvider()
    await clickButton('Edit')
    await disableAutomaticBackup()
    await advanceTime(60_000)

    expect(startCloudBackupArchive).not.toHaveBeenCalled()
  })

  it('discards a pending follow-up when automatic backup is disabled', async () => {
    await renderProvider()
    await clickButton('Backup now')
    await clickButton('Edit')
    await advanceTime(30_000)
    await disableAutomaticBackup()

    finishServerJob()
    await advanceTime(60_000)

    expect(screen.getByTestId('backup-status')).toHaveTextContent('success')
    expect(startCloudBackupArchive).toHaveBeenCalledOnce()
  })

  it('cancels queued browser idle work when automatic backup is disabled', async () => {
    const requestIdleCallback = vi.fn(() => 17)
    const cancelIdleCallback = vi.fn()
    vi.stubGlobal('requestIdleCallback', requestIdleCallback)
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback)
    await renderProvider()
    await clickButton('Edit')
    await advanceTime(30_000)

    expect(requestIdleCallback).toHaveBeenCalledOnce()
    expect(startCloudBackupArchive).not.toHaveBeenCalled()
    await disableAutomaticBackup()
    expect(cancelIdleCallback).toHaveBeenCalledWith(17)
    await advanceTime(60_000)

    expect(startCloudBackupArchive).not.toHaveBeenCalled()
  })
})
