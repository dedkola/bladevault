// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  KnivesProvider,
  useKnives,
} from '@/components/providers/knives-provider'
import { createKnife } from '@/tests/fixtures/knife'

const uploadCloudBackupArchive = vi.hoisted(() => vi.fn())

vi.mock('@/lib/cloud-backup-client', () => ({
  canAttemptSilentCloudBackup: () => true,
  uploadCloudBackupArchive,
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

function ProviderConsumer() {
  const { addToCompare, isLoading, scheduleVaultBackup, updateKnife } =
    useKnives()

  return (
    <div>
      <span>{isLoading ? 'loading' : 'ready'}</span>
      <button onClick={() => void updateKnife('knife', { brand: 'Changed' })}>
        Edit
      </button>
      <button onClick={() => void updateKnife('knife', { pinned: true })}>
        Pin
      </button>
      <button onClick={() => void addToCompare('knife')}>Compare</button>
      <button onClick={scheduleVaultBackup}>Maintenance mutation</button>
    </div>
  )
}

describe('KnivesProvider backup side effects', () => {
  beforeEach(() => {
    uploadCloudBackupArchive.mockReset()
    uploadCloudBackupArchive.mockResolvedValue({
      syncedAt: '2026-01-01T00:00:00.000Z',
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

  it('backs up content edits but not pin-only or compare mutations', async () => {
    const user = userEvent.setup()
    const scheduledBackupCallbacks: Array<() => void> = []
    const nativeSetTimeout = window.setTimeout.bind(window)
    const nativeClearTimeout = window.clearTimeout.bind(window)
    const backupTimerIdBase = 1_000_000_000

    vi.spyOn(window, 'setTimeout').mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (timeout === 30_000 && typeof handler === 'function') {
        scheduledBackupCallbacks.push(() => handler(...args))
        return backupTimerIdBase + scheduledBackupCallbacks.length
      }

      return nativeSetTimeout(handler, timeout, ...args)
    }) as typeof window.setTimeout)
    const clearTimeoutSpy = vi
      .spyOn(window, 'clearTimeout')
      .mockImplementation((timerId) => {
        if (Number(timerId) >= backupTimerIdBase) return
        nativeClearTimeout(timerId)
      })

    render(
      <KnivesProvider>
        <ProviderConsumer />
      </KnivesProvider>,
    )
    await screen.findByText('ready')

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await waitFor(() => expect(scheduledBackupCallbacks).toHaveLength(1))
    expect(uploadCloudBackupArchive).not.toHaveBeenCalled()

    await user.click(
      screen.getByRole('button', { name: 'Maintenance mutation' }),
    )
    await waitFor(() => expect(scheduledBackupCallbacks).toHaveLength(2))
    expect(clearTimeoutSpy).toHaveBeenCalledWith(backupTimerIdBase + 1)
    expect(uploadCloudBackupArchive).not.toHaveBeenCalled()

    await act(async () => {
      scheduledBackupCallbacks.at(-1)?.()
    })
    await waitFor(() =>
      expect(uploadCloudBackupArchive).toHaveBeenCalledTimes(1),
    )

    uploadCloudBackupArchive.mockClear()
    await user.click(screen.getByRole('button', { name: 'Pin' }))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/knives/knife',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    )
    await new Promise((resolve) => window.setTimeout(resolve, 20))
    expect(uploadCloudBackupArchive).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Compare' }))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/compare',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    await new Promise((resolve) => window.setTimeout(resolve, 20))
    expect(uploadCloudBackupArchive).not.toHaveBeenCalled()

    await user.click(
      screen.getByRole('button', { name: 'Maintenance mutation' }),
    )
    await waitFor(() => expect(scheduledBackupCallbacks).toHaveLength(3))
    expect(uploadCloudBackupArchive).not.toHaveBeenCalled()

    await act(async () => {
      scheduledBackupCallbacks.at(-1)?.()
    })
    await waitFor(() =>
      expect(uploadCloudBackupArchive).toHaveBeenCalledTimes(1),
    )
  })
})
