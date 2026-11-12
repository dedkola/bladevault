export const DRIVE_BACKUP_FILE_NAME = 'bladevault-data.tar.gz'
export const DRIVE_BACKUP_FOLDER_NAME = 'BladeVault'
export const DRIVE_AUTH_CODE_MESSAGE = 'bladevault-drive-auth-code'
export const DRIVE_AUTH_ERROR_MESSAGE = 'bladevault-drive-auth-error'

export type DriveAuthCodeMessage = {
  type: typeof DRIVE_AUTH_CODE_MESSAGE
  code: string
  state: string
}

export type DriveAuthErrorMessage = {
  type: typeof DRIVE_AUTH_ERROR_MESSAGE
  error: { message: string }
}

export type DriveBackupFile = {
  modifiedTime: string
  size: number
}

export type DriveBackupStatus = {
  // False where Google Drive backup cannot run, such as the static web target.
  available: boolean
  connected: boolean
  // The backup currently stored in Google Drive, when one exists.
  file: DriveBackupFile | null
  // Set when Google Drive could not be read; the connection itself is kept.
  message: string | null
}

export const DRIVE_BACKUP_UNAVAILABLE: DriveBackupStatus = {
  available: false,
  connected: false,
  file: null,
  message: null,
}
