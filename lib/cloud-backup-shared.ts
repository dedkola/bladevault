// 'drive' stores the archive in the user's own Google Drive.
export type CloudBackupTarget = 'bladevault' | 'drive'

export type CloudBackupJobState = {
  id: string | null
  // Absent for the BladeVault cloud service.
  target?: CloudBackupTarget
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
