export type CloudRestoreJobState = {
  id: string | null
  status: 'idle' | 'running' | 'success' | 'error'
  phase: 'downloading' | 'validating' | 'applying' | null
  message: string | null
  restoredAt: string | null
  generation: string | null
}

export const IDLE_CLOUD_RESTORE_JOB: CloudRestoreJobState = {
  id: null,
  status: 'idle',
  phase: null,
  message: null,
  restoredAt: null,
  generation: null,
}
