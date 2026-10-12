// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  VaultRestoreProvider,
  useVaultRestore,
} from '@/components/providers/vault-restore-provider'
import {
  IDLE_CLOUD_RESTORE_JOB,
  type CloudRestoreJobState,
} from '@/lib/cloud-restore-shared'
import {
  getVaultClientState,
  INITIAL_VAULT_CLIENT_STATE,
  setVaultClientState,
  type VaultClientState,
} from '@/lib/vault-client-state'

const { getCloudRestoreJob, getVaultStatus, startCloudRestore } = vi.hoisted(
  () => ({
    getCloudRestoreJob: vi.fn(),
    getVaultStatus: vi.fn(),
    startCloudRestore: vi.fn(),
  }),
)
vi.mock('@/lib/cloud-restore-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cloud-restore-client')>()),
  getCloudRestoreJob,
  getVaultStatus,
  startCloudRestore,
}))

const idle: VaultClientState = {
  generation: 'vault-1',
  phase: 'idle',
  readOnly: false,
}
const running: CloudRestoreJobState = {
  ...IDLE_CLOUD_RESTORE_JOB,
  id: 'restore-1',
  status: 'running',
  phase: 'downloading',
}

function Consumer({ page = 'Settings' }: { page?: string }) {
  const { job, startRestore } = useVaultRestore()
  return (
    <div>
      <h1>{page}</h1>
      <span data-testid="job">
        {job.status}:{job.phase}
      </span>
      <span>{job.message}</span>
      <button onClick={() => void startRestore()}>Restore</button>
    </div>
  )
}

describe('global vault restore provider', () => {
  let serverStatus: VaultClientState
  let serverJob: CloudRestoreJobState
  beforeEach(() => {
    vi.useFakeTimers()
    setVaultClientState(INITIAL_VAULT_CLIENT_STATE)
    serverStatus = { ...idle }
    serverJob = { ...IDLE_CLOUD_RESTORE_JOB }
    getVaultStatus.mockReset().mockImplementation(async () => serverStatus)
    getCloudRestoreJob.mockReset().mockImplementation(async () => serverJob)
    startCloudRestore.mockReset().mockImplementation(async () => {
      serverStatus = { ...idle, phase: 'preparing', readOnly: true }
      serverJob = running
      return { job: running, started: true }
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ ok: true })),
    )
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    setVaultClientState(INITIAL_VAULT_CLIENT_STATE)
  })

  async function mount(initialStatus = idle) {
    let view!: ReturnType<typeof render>
    await act(async () => {
      view = render(
        <VaultRestoreProvider initialStatus={initialStatus}>
          <Consumer />
        </VaultRestoreProvider>,
      )
    })
    return view
  }

  it('keeps the restore and read-only state while navigating away from Settings', async () => {
    const view = await mount()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    })
    expect(startCloudRestore).toHaveBeenCalledOnce()
    expect(getVaultClientState().readOnly).toBe(true)
    expect(
      screen.getByText(/You can browse; editing is paused/),
    ).toBeInTheDocument()
    await act(async () => {
      view.rerender(
        <VaultRestoreProvider initialStatus={idle}>
          <Consumer page="Collection" />
        </VaultRestoreProvider>,
      )
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(
      screen.getByRole('heading', { name: 'Collection' }),
    ).toBeInTheDocument()
    expect(screen.getByTestId('job')).toHaveTextContent('running:downloading')
    expect(startCloudRestore).toHaveBeenCalledOnce()
  })

  it('adopts a running server restore after a reload', async () => {
    serverStatus = { ...idle, phase: 'preparing', readOnly: true }
    serverJob = running
    await mount(serverStatus)
    expect(screen.getByTestId('job')).toHaveTextContent('running:downloading')
    expect(
      screen.getByText(/You can browse; editing is paused/),
    ).toBeInTheDocument()
    expect(startCloudRestore).not.toHaveBeenCalled()
  })

  it('does not reset active restore protection when a server layout returns older initial props', async () => {
    const view = await mount()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    })
    getVaultStatus.mockReturnValue(new Promise(() => {}))
    await act(async () => {
      view.rerender(
        <VaultRestoreProvider initialStatus={{ ...idle }}>
          <Consumer page="Collection" />
        </VaultRestoreProvider>,
      )
    })
    expect(getVaultClientState().readOnly).toBe(true)
    expect(
      screen.getByText(/You can browse; editing is paused/),
    ).toBeInTheDocument()
  })

  it('makes the app inert only while the restored vault is being applied', async () => {
    serverStatus = { ...idle, phase: 'switching', readOnly: true }
    serverJob = { ...running, phase: 'applying' }
    await mount(serverStatus)
    expect(screen.getByText('Applying restored vault…')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Settings' }).closest('[inert]'),
    ).not.toBeNull()
  })

  it('shows a protected recovery state instead of an endless applying spinner', async () => {
    serverStatus = {
      ...idle,
      phase: 'switching',
      readOnly: true,
      recoveryRequired: true,
    }
    await mount(serverStatus)
    expect(
      screen.getByText(/Restart BladeVault to retry recovery/),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('Applying restored vault…'),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Settings' }).closest('[inert]'),
    ).not.toBeNull()
  })

  it('keeps start errors visible and resumes editing only after server confirmation', async () => {
    startCloudRestore.mockRejectedValue(new Error('Another backup is running.'))
    await mount()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    })
    expect(getVaultClientState().readOnly).toBe(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(screen.getByText('Another backup is running.')).toBeInTheDocument()
    expect(
      screen.queryByText(/You can browse; editing is paused/),
    ).not.toBeInTheDocument()
  })

  it('does not replace a successful restore status with a transient polling error', async () => {
    serverJob = {
      ...running,
      status: 'success',
      phase: null,
      generation: 'vault-1',
      restoredAt: '2026-10-11T10:00:00.000Z',
    }
    await mount()
    getVaultStatus.mockRejectedValue(new Error('App lock requires unlocking.'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(screen.getByTestId('job')).toHaveTextContent('success:')
  })
})
