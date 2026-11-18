// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IDLE_CLOUD_BACKUP_JOB,
  type CloudBackupJobState,
} from '@/lib/cloud-backup-shared'

const state = vi.hoisted(() => ({
  job: null as CloudBackupJobState | null,
}))

vi.mock('@/components/providers/knives-provider', () => ({
  useKnives: () => ({ cloudBackupJob: state.job }),
}))
vi.mock('@/components/providers/vault-restore-provider', () => ({
  useVaultRestore: () => ({ readOnly: false, job: { phase: null } }),
}))

import { BackupProgressNotice } from '@/components/vault-task-notice'

const running: CloudBackupJobState = {
  id: 'job-1',
  status: 'running',
  phase: 'preparing',
  message: null,
}

function renderWith(job: CloudBackupJobState) {
  state.job = job
  return render(<BackupProgressNotice />)
}

function finish(
  view: ReturnType<typeof render>,
  job: Partial<CloudBackupJobState>,
) {
  state.job = { ...running, phase: null, ...job }
  view.rerender(<BackupProgressNotice />)
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('BackupProgressNotice', () => {
  it('says the backup finished instead of vanishing, then hides', () => {
    const view = renderWith(running)
    expect(screen.getByRole('progressbar')).toBeInTheDocument()

    finish(view, { status: 'success' })
    expect(screen.getByText('Backed up to Google Drive.')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()

    act(() => vi.advanceTimersByTime(4_000))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('reports a failure with a link to the Inbox', () => {
    const view = renderWith(running)
    finish(view, {
      status: 'error',
      message: 'Google Drive upload failed (503).',
    })
    expect(
      screen.getByText(
        'Google Drive backup failed: Google Drive upload failed (503).',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Details' })).toHaveAttribute(
      'href',
      '/inbox?filter=system',
    )
  })

  it('shows nothing for a result it did not see running', () => {
    renderWith({ ...IDLE_CLOUD_BACKUP_JOB, status: 'success' })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('does not link to the Inbox when the backup never started', () => {
    const view = renderWith({ ...running, id: null })
    finish(view, { id: null, status: 'error', message: 'Not connected.' })
    expect(
      screen.getByText('Google Drive backup failed: Not connected.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
