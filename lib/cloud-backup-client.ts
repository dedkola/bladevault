'use client'

import {
  getCloudAuthState,
  getCloudRuntimeConfig,
  loadCloudRuntimeConfig,
  parseApiError,
} from '@/lib/cloud-backup'
import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'
import type { CloudBackupJobState } from '@/lib/cloud-backup-shared'

export function canAttemptSilentCloudBackup() {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return false
  }

  const authState = getCloudAuthState()
  if (!authState?.sessionToken) {
    return false
  }

  const config = getCloudRuntimeConfig()
  return Boolean(config.authUrl && config.backupUrl)
}

export function formatCloudBackupError(error: unknown, baseUrl: string) {
  const message = error instanceof Error ? error.message : 'Unknown error'

  if (message === 'Load failed' || message.includes('Failed to fetch')) {
    return `Could not reach Cloud Backup API at ${baseUrl}. Restart the frontend if you just updated it, and confirm the Backup API shown in settings is correct.`
  }

  return message
}

export async function startCloudBackupArchive(): Promise<{
  job: CloudBackupJobState
  started: boolean
}> {
  const nextConfig = await loadCloudRuntimeConfig()
  if (!nextConfig.backupUrl) {
    throw new Error('NEXT_PUBLIC_BLADEVAULT_BACKUP_URL is not configured.')
  }

  const sessionToken = getCloudAuthState()?.sessionToken
  if (!sessionToken) throw new Error('Sign in before starting a cloud backup.')

  const response = await fetch('/api/cloud-backup/job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionToken }),
  })

  if (!response.ok) {
    throw new Error(await parseApiError(response))
  }

  const data = await readJsonResponse<{
    job?: CloudBackupJobState
    started?: boolean
  }>(response)
  if (!data.job) throw new Error('Backup server did not return a job status.')
  return { job: data.job, started: data.started === true }
}

export async function getCloudBackupJob(): Promise<CloudBackupJobState> {
  const response = await fetch('/api/cloud-backup/job', { cache: 'no-store' })
  const data = await readJsonResponse<{
    job?: CloudBackupJobState
    error?: string
  }>(response)
  if (!response.ok || !data.job) {
    throw new Error(getApiErrorMessage(data, 'Failed to read backup status'))
  }

  return data.job
}
