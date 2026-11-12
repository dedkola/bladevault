// A backup job archives the vault and uploads it to the user's Google Drive.
export type CloudBackupJobState = {
  id: string | null
  status: 'idle' | 'running' | 'success' | 'error'
  phase: 'preparing' | 'uploading' | null
  message: string | null
}

export const IDLE_CLOUD_BACKUP_JOB: CloudBackupJobState = {
  id: null,
  status: 'idle',
  phase: null,
  message: null,
}
