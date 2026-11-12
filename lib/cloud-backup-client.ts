'use client'

import { parseApiError } from '@/lib/cloud-backup'
import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'
import type { CloudBackupJobState } from '@/lib/cloud-backup-shared'

// The local server holds the Google Drive sign-in, so the request needs no
// credentials from the browser.
export async function startCloudBackupArchive(): Promise<{
  job: CloudBackupJobState
  started: boolean
}> {
  const response = await fetch('/api/cloud-backup/job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
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
