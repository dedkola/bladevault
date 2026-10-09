export type CloudBackupJobState = {
  id: string | null
  status: 'idle' | 'running' | 'success' | 'error'
  phase: 'preparing' | 'uploading' | null
  syncedAt: string | null
  message: string | null
}

export const IDLE_CLOUD_BACKUP_JOB: CloudBackupJobState = {
  id: null,
  status: 'idle',
  phase: null,
  syncedAt: null,
  message: null,
}

export const BACKUP_UPLOAD_BYTES_PER_SECOND = 2 * 1024 * 1024
