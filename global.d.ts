export {}

declare global {
  type BladeVaultUpdateStatus = {
    status:
      | 'idle'
      | 'checking'
      | 'available'
      | 'downloading'
      | 'downloaded'
      | 'installing'
      | 'not-available'
      | 'error'
    platform?: NodeJS.Platform
    version?: string
    currentVersion?: string
    percent?: number | null
    path?: string
    sha256?: string
    releaseUrl?: string
    downloadUrl?: string
    message?: string
  }

  type BladeVaultErrorReportingStatus = {
    available: boolean
    enabled: boolean
    usageMetrics: boolean
    restartRequired: boolean
  }

  type BladeVaultPriceNotificationStatus = {
    enabled: boolean
    supported: boolean
  }

  interface Window {
    bladevaultDesktop?: {
      claudeDesktop?: {
        connect: () => Promise<
          | {
              ok: true
              configPath: string
              backupPath: string | null
              changed: boolean
            }
          | { ok: false; error: string }
        >
      }
      errorReporting?: {
        get: () => Promise<BladeVaultErrorReportingStatus>
        set: (
          enabled: boolean,
          usageMetrics?: boolean,
        ) => Promise<BladeVaultErrorReportingStatus>
        restart: () => Promise<void>
      }
      selectDirectory: () => Promise<string | null>
      saveBackupFile: (defaultName: string) => Promise<boolean>
      getUpdateStatus: () => Promise<BladeVaultUpdateStatus>
      checkForUpdates: () => Promise<BladeVaultUpdateStatus>
      downloadUpdate: () => Promise<BladeVaultUpdateStatus>
      installUpdate: () => Promise<BladeVaultUpdateStatus>
      reloadWindow?: () => Promise<void>
      // Keep running in the tray after the last window closes.
      getBackgroundMode?: () => Promise<boolean>
      setBackgroundMode?: (enabled: boolean) => Promise<boolean>
      // Native notifications for price drops and restocks while hidden.
      getPriceNotifications?: () => Promise<BladeVaultPriceNotificationStatus>
      setPriceNotifications?: (
        enabled: boolean,
      ) => Promise<BladeVaultPriceNotificationStatus>
      scrapeBrowser?: {
        open: (
          url: string,
        ) => Promise<
          | { status: 'captured'; html: string; url: string }
          | { status: 'cancelled' }
        >
        capture: () => Promise<void>
        cancel: () => Promise<void>
        fetchImages: (urls: string[]) => Promise<(string | null)[]>
      }
      onUpdateStatus: (
        callback: (status: BladeVaultUpdateStatus) => void,
      ) => () => void
    }
  }
}
