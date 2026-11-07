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

  interface Window {
    bladevaultDesktop?: {
      selectDirectory: () => Promise<string | null>
      saveBackupFile: (defaultName: string) => Promise<boolean>
      getUpdateStatus: () => Promise<BladeVaultUpdateStatus>
      checkForUpdates: () => Promise<BladeVaultUpdateStatus>
      downloadUpdate: () => Promise<BladeVaultUpdateStatus>
      installUpdate: () => Promise<BladeVaultUpdateStatus>
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
