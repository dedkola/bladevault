'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  Database,
  Download,
  FolderOpen,
  Info,
  Loader2,
  Lock,
  LogOut,
  Palette,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Upload,
} from 'lucide-react'
import { FcGoogle } from 'react-icons/fc'
import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'
import {
  APP_THEMES,
  CUSTOM_FIELD_TYPES,
  SETTINGS_UPDATED_EVENT,
  type AppSettings,
  type AppTheme,
  type CardField,
  type CustomField,
  type CustomFieldType,
} from '@/lib/settings-shared'
import { getCardFieldGroups, getCardFieldLabel } from '@/lib/card-fields'
import {
  clearCloudAuthState,
  CloudAuthErrorMessage,
  CloudAuthState,
  CloudAuthSuccessMessage,
  CloudRuntimeConfig,
  CloudBackupSession,
  createCloudAuthHeaders,
  getCloudAuthState,
  getCloudRuntimeConfig,
  loadCloudRuntimeConfig,
  parseApiError,
  refreshCloudBackupAccessToken,
  setCloudAuthState,
} from '@/lib/cloud-backup'
import {
  formatCloudBackupError,
  uploadCloudBackupArchive,
} from '@/lib/cloud-backup-client'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  SettingsSection,
  SettingsRow,
  MonoValue,
} from '@/components/settings-panels'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import pkg from '@/package.json'
import { useDesktopUpdates } from '@/hooks/use-desktop-updates'
import { useKnives } from '@/components/providers/knives-provider'

type StatusTone = 'idle' | 'loading' | 'success' | 'error'
type LocalBackupManifest = {
  formatVersion: number
  bladeVaultVersion: string
  schemaVersion: number
  createdAt: string
  knifeCount: number
  imageCount: number
}
type SettingsTab =
  | 'general'
  | 'cloud-backup'
  | 'restore-database'
  | 'appearance'
  | 'fields'
  | 'about'

const settingsTabTriggerClassName =
  'flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors sm:w-full'

const settingsSecondaryButtonClassName =
  'border-[var(--bladevault-line)] bg-[var(--bladevault-surface-soft)] text-foreground hover:bg-[var(--bladevault-surface-hover)] hover:text-foreground dark:border-[#d3c097]/30 dark:bg-[#382f1d] dark:text-[var(--bladevault-gold)] dark:hover:bg-[#4a3f25] dark:hover:text-[var(--bladevault-gold)]'

const settingsPrimaryButtonClassName =
  'border-[var(--bladevault-gold)] bg-[var(--bladevault-gold)] text-[var(--bladevault-olive)] hover:bg-[var(--bladevault-title)] hover:text-[var(--bladevault-olive)]'

function StatusPill({
  status,
  message,
}: {
  status: StatusTone
  message?: string
}) {
  if (status === 'idle') return null

  if (status === 'loading') {
    return (
      <span className="inline-flex max-w-full items-start gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span className="min-w-0 break-words">{message || 'Working...'}</span>
      </span>
    )
  }

  if (status === 'success') {
    return (
      <span className="inline-flex max-w-full items-start gap-1.5 text-xs text-[var(--bladevault-local)] dark:text-[var(--bladevault-gold)]">
        <CheckCircle2 className="h-3.5 w-3.5" />
        <span className="min-w-0 break-words">{message || 'Done'}</span>
      </span>
    )
  }

  return (
    <span className="inline-flex max-w-full items-start gap-1.5 text-xs text-destructive">
      <AlertCircle className="h-3.5 w-3.5" />
      <span className="min-w-0 break-words">
        {message || 'Something went wrong'}
      </span>
    </span>
  )
}

function formatSyncTime(value: string) {
  if (!value) return 'Never'

  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value))
  } catch {
    return value
  }
}

function getBackupDownloadName(response: Response): string {
  const disposition = response.headers.get('content-disposition') || ''
  const match = disposition.match(/filename="([^"]+)"/i)
  return (
    match?.[1] ||
    `bladevault-backup-${new Date().toISOString().slice(0, 10)}.zip`
  )
}

async function saveBackupResponse(
  response: Response,
  filename: string,
): Promise<boolean> {
  const savePicker = (
    window as Window & {
      showSaveFilePicker?: (options: {
        suggestedName: string
        types: Array<{
          accept: Record<string, string[]>
          description: string
        }>
      }) => Promise<{
        createWritable: () => Promise<{
          close: () => Promise<void>
          write: (data: Blob) => Promise<void>
        }>
      }>
    }
  ).showSaveFilePicker

  if (savePicker) {
    try {
      const handle = await savePicker({
        suggestedName: filename,
        types: [
          {
            accept: { 'application/zip': ['.zip'] },
            description: 'ZIP archive',
          },
        ],
      })
      const writable = await handle.createWritable()
      if (!response.body) {
        throw new Error('Backup download returned an empty response.')
      }
      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        await writable.write(new Blob([value]))
      }
      await writable.close()
      return true
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        await response.body?.cancel()
        return false
      }
      throw error
    }
  }

  const downloadUrl = URL.createObjectURL(await response.blob())
  try {
    const link = document.createElement('a')
    link.href = downloadUrl
    link.download = filename
    document.body.append(link)
    link.click()
    link.remove()
    return true
  } finally {
    URL.revokeObjectURL(downloadUrl)
  }
}

function applyThemePreference(theme: AppSettings['theme']) {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

function CardFieldsPreview({
  fields,
  customFields,
}: {
  fields: CardField[]
  customFields: CustomField[]
}) {
  const selectedLabels = fields.map((field) =>
    getCardFieldLabel(field, customFields),
  )
  const hiddenCount = Math.max(0, selectedLabels.length - 3)
  const optionalDetails = [
    ...selectedLabels.slice(0, 3),
    hiddenCount > 0 ? `+${hiddenCount} more` : '',
  ].filter(Boolean)

  return (
    <div className="mx-auto w-full max-w-[15rem]">
      <div className="overflow-hidden rounded-xl border border-[var(--bladevault-line)] bg-card shadow-sm">
        <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-white dark:bg-[#f4f1e8]">
          <div className="relative h-7 w-32 -rotate-[24deg]" aria-hidden="true">
            <div className="absolute right-0 top-0 h-7 w-14 rounded-r-md bg-[var(--bladevault-olive)] shadow-sm" />
            <div className="absolute left-0 top-1 h-5 w-[4.75rem] rounded-l-full border border-[#aaa59b] bg-gradient-to-b from-[#f0f0ed] to-[#c9c9c4] shadow-sm [clip-path:polygon(0_50%,18%_0,100%_0,100%_100%,18%_100%)]" />
          </div>
        </div>
        <div className="min-h-[6.6rem] border-t border-[var(--bladevault-line)]/50 bg-card px-3.5 py-3">
          <div className="mb-2 inline-flex rounded-full bg-secondary px-2.5 py-1 text-[9px] font-medium uppercase tracking-wide text-secondary-foreground">
            Brand
          </div>
          <div className="text-sm font-medium text-foreground">Model</div>
          {optionalDetails.length > 0 ? (
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {optionalDetails.join(' · ')}
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
        <Lock className="size-3" />
        Brand and model are always shown
      </div>
    </div>
  )
}

export default function SettingsView() {
  const searchParams = useSearchParams()
  const requestedTab =
    searchParams.get('tab') === 'cloud-backup' ? 'cloud-backup' : null
  const { update, checkForUpdates, downloadUpdate, installUpdate } =
    useDesktopUpdates()
  const { refreshVault } = useKnives()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [localDataPath, setLocalDataPath] = useState('')
  const [configuredLocalDataPath, setConfiguredLocalDataPath] = useState('')
  const [defaultLocalDataPath, setDefaultLocalDataPath] = useState('')
  const [pendingLocalDataPath, setPendingLocalDataPath] = useState('')
  const [moveExistingLocalData, setMoveExistingLocalData] = useState(true)
  const [dataDirManagedByEnv, setDataDirManagedByEnv] = useState(false)
  const [dockerHostDataMountPath, setDockerHostDataMountPath] = useState('')
  const [isContainerized, setIsContainerized] = useState(false)
  const [cloudSession, setCloudSession] = useState<CloudBackupSession | null>(
    null,
  )
  const [cloudConfig, setCloudConfig] = useState<CloudRuntimeConfig>(() =>
    getCloudRuntimeConfig(),
  )
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [authStatus, setAuthStatus] = useState<StatusTone>('idle')
  const [authMessage, setAuthMessage] = useState('')
  const [backupStatus, setBackupStatus] = useState<StatusTone>('idle')
  const [backupMessage, setBackupMessage] = useState('')
  const [restoreStatus, setRestoreStatus] = useState<StatusTone>('idle')
  const [restoreMessage, setRestoreMessage] = useState('')
  const [localBackupStatus, setLocalBackupStatus] = useState<StatusTone>('idle')
  const [localBackupMessage, setLocalBackupMessage] = useState('')
  const [localDataStatus, setLocalDataStatus] = useState<StatusTone>('idle')
  const [localDataMessage, setLocalDataMessage] = useState('')
  const [loadAttemptKey, setLoadAttemptKey] = useState(0)
  const [activeTab, setActiveTab] = useState<SettingsTab>(
    () => requestedTab ?? 'general',
  )
  const [newFieldName, setNewFieldName] = useState('')
  const [newFieldType, setNewFieldType] = useState<CustomFieldType>('text')
  const [isSavingCardFields, setIsSavingCardFields] = useState(false)
  const localRestoreInputRef = useRef<HTMLInputElement>(null)

  const updateMessage =
    update.status === 'checking'
      ? 'Checking GitHub for a newer release...'
      : update.status === 'downloading'
        ? `Downloading update${update.percent != null ? ` (${update.percent}%)` : '...'}`
        : update.status === 'downloaded'
          ? update.platform === 'darwin'
            ? 'DMG opened. Quit BladeVault and replace the app in Applications.'
            : 'Update downloaded. Restart BladeVault to install.'
          : update.status === 'not-available'
            ? 'BladeVault is up to date.'
            : update.status === 'error'
              ? update.message || 'Could not check for updates.'
              : ''

  const updateTone =
    update.status === 'error'
      ? 'error'
      : update.status === 'checking' || update.status === 'downloading'
        ? 'loading'
        : update.status === 'downloaded' || update.status === 'not-available'
          ? 'success'
          : 'idle'

  const handleUpdateAction = async () => {
    if (update.status === 'downloaded' && update.platform === 'win32') {
      await installUpdate()
      return
    }

    if (update.status === 'available') {
      await downloadUpdate()
      return
    }

    await checkForUpdates()
  }

  const authUrl = cloudConfig.authUrl
  const backupUrl = cloudConfig.backupUrl
  const cloudConfigError = [
    !authUrl ? 'NEXT_PUBLIC_BLADEVAULT_AUTH_URL is not configured.' : null,
    !backupUrl ? 'NEXT_PUBLIC_BLADEVAULT_BACKUP_URL is not configured.' : null,
  ]
    .filter(Boolean)
    .join(' ')
  const canChooseLocalDataFolder =
    typeof window !== 'undefined' &&
    Boolean(window.bladevaultDesktop?.selectDirectory)
  const normalizedPendingLocalDataPath = pendingLocalDataPath.trim()
  const isLocalDataFolderDirty =
    normalizedPendingLocalDataPath !== '' &&
    normalizedPendingLocalDataPath !== localDataPath

  useEffect(() => {
    const openCloudBackup = () => setActiveTab('cloud-backup')

    window.addEventListener(
      'bladevault:open-cloud-backup-settings',
      openCloudBackup,
    )
    return () =>
      window.removeEventListener(
        'bladevault:open-cloud-backup-settings',
        openCloudBackup,
      )
  }, [])

  const tabs = useMemo(
    () => [
      { id: 'general' as const, label: 'Local storage', icon: Database },
      { id: 'cloud-backup' as const, label: 'Cloud Backup', icon: Cloud },
      {
        id: 'restore-database' as const,
        label: 'Backup & Restore',
        icon: Download,
      },
      { id: 'appearance' as const, label: 'Appearance', icon: Palette },
      {
        id: 'fields' as const,
        label: 'Custom Fields',
        icon: SlidersHorizontal,
      },
      { id: 'about' as const, label: 'About', icon: Info },
    ],
    [],
  )

  const refreshCloudConfig = useCallback(async (force = false) => {
    const nextConfig = await loadCloudRuntimeConfig(force)
    setCloudConfig(nextConfig)
    return nextConfig
  }, [])

  const refreshCloudSession = useCallback(
    async (cancellation?: { cancelled: boolean }) => {
      const state = getCloudAuthState()
      if (!state?.sessionToken) {
        if (!cancellation?.cancelled) {
          setCloudSession(null)
        }
        return
      }

      try {
        const nextConfig = await refreshCloudConfig()
        if (!nextConfig.authUrl) {
          throw new Error('NEXT_PUBLIC_BLADEVAULT_AUTH_URL is not configured.')
        }

        const controller = new AbortController()
        const timeout = window.setTimeout(() => controller.abort(), 8000)
        const response = await fetch(`${nextConfig.authUrl}/api/me`, {
          headers: createCloudAuthHeaders(),
          signal: controller.signal,
        }).finally(() => {
          window.clearTimeout(timeout)
        })

        if (!response.ok) {
          throw new Error(await parseApiError(response))
        }

        const data = await readJsonResponse<CloudBackupSession | null>(response)
        if (cancellation?.cancelled) return

        if (data?.user && data?.session) {
          const existingState = getCloudAuthState()
          if (existingState) {
            setCloudAuthState({
              ...existingState,
              sessionToken: data.session.token,
              expiresAt: data.session.expiresAt,
              user: data.user,
            })
          }
          setCloudSession(data)
        } else {
          setCloudSession(null)
        }
      } catch {
        if (!cancellation?.cancelled) {
          setCloudSession(null)
        }
      }
    },
    [refreshCloudConfig],
  )

  useEffect(() => {
    const cancellation = { cancelled: false }

    async function load() {
      setIsLoading(true)
      setLoadError(null)
      setLocalDataStatus('idle')
      setLocalDataMessage('')

      try {
        const [response, nextCloudConfig] = await Promise.all([
          fetch('/api/settings', { cache: 'no-store' }),
          refreshCloudConfig(true),
        ])
        const data = await readJsonResponse<{
          configuredLocalDataPath?: string | null
          dataDirManagedByEnv?: boolean
          defaultLocalDataPath?: string
          error?: string
          settings?: AppSettings
          localDataPath?: string
          dockerHostDataMountPath?: string | null
          isContainerized?: boolean
        }>(response)
        if (!response.ok) {
          throw new Error(getApiErrorMessage(data, 'Failed to load settings'))
        }

        const nextSettings = data.settings
        if (!nextSettings) {
          throw new Error('BladeVault did not return settings data.')
        }

        if (cancellation.cancelled) return
        setSettings(nextSettings)
        setLocalDataPath(data.localDataPath || '')
        setConfiguredLocalDataPath(data.configuredLocalDataPath || '')
        setDefaultLocalDataPath(data.defaultLocalDataPath || '')
        setPendingLocalDataPath(data.localDataPath || '')
        setDataDirManagedByEnv(Boolean(data.dataDirManagedByEnv))
        setDockerHostDataMountPath(data.dockerHostDataMountPath || '')
        setIsContainerized(Boolean(data.isContainerized))
        setCloudConfig(nextCloudConfig)
        void refreshCloudSession(cancellation)
      } catch (error) {
        if (!cancellation.cancelled) {
          setLoadError(
            error instanceof Error ? error.message : 'Failed to load settings',
          )
        }
      } finally {
        if (!cancellation.cancelled) {
          setIsLoading(false)
        }
      }
    }

    load()
    return () => {
      cancellation.cancelled = true
    }
  }, [loadAttemptKey, refreshCloudConfig, refreshCloudSession])

  const saveSettings = useCallback(async (updates: Partial<AppSettings>) => {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })

    const data = await readJsonResponse<{
      error?: string
      settings?: AppSettings
    }>(response)
    if (!response.ok) {
      throw new Error(getApiErrorMessage(data, 'Failed to save settings'))
    }

    const nextSettings = data.settings
    if (!nextSettings) {
      throw new Error('BladeVault did not return settings data.')
    }
    setSettings(nextSettings)
    applyThemePreference(nextSettings.theme)

    window.dispatchEvent(
      new CustomEvent<Partial<AppSettings>>(SETTINGS_UPDATED_EVENT, {
        detail: nextSettings,
      }),
    )

    return nextSettings
  }, [])

  const refreshRestoredSettings = useCallback(async () => {
    try {
      const response = await fetch('/api/settings', { cache: 'no-store' })
      const data = await readJsonResponse<{
        error?: string
        settings?: AppSettings
      }>(response)
      if (!response.ok || !data.settings) {
        throw new Error(
          getApiErrorMessage(data, 'Failed to refresh restored settings'),
        )
      }

      setSettings(data.settings)
      applyThemePreference(data.settings.theme)
      window.dispatchEvent(
        new CustomEvent<Partial<AppSettings>>(SETTINGS_UPDATED_EVENT, {
          detail: data.settings,
        }),
      )
    } catch {
      setLoadAttemptKey((current) => current + 1)
      window.dispatchEvent(new Event(SETTINGS_UPDATED_EVENT))
    }
  }, [])

  const handleChooseLocalDataFolder = async () => {
    const nextPath = await window.bladevaultDesktop?.selectDirectory()
    if (!nextPath) {
      return
    }

    setPendingLocalDataPath(nextPath)
    setLocalDataStatus('idle')
    setLocalDataMessage('')
  }

  const handleSaveLocalDataFolder = async () => {
    setLocalDataStatus('loading')
    setLocalDataMessage(
      moveExistingLocalData
        ? 'Moving your local vault to the new folder...'
        : 'Updating your local data folder...',
    )

    try {
      const response = await fetch('/api/settings/local-data-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          moveExistingData: moveExistingLocalData,
          path: normalizedPendingLocalDataPath,
        }),
      })

      const data = await readJsonResponse<{
        configuredLocalDataPath?: string | null
        defaultLocalDataPath?: string
        dockerHostDataMountPath?: string | null
        error?: string
        isContainerized?: boolean
        localDataPath?: string
        message?: string
        settings?: AppSettings
        warning?: string
      }>(response)
      if (!response.ok) {
        throw new Error(
          getApiErrorMessage(data, 'Failed to update local data folder'),
        )
      }

      const nextSettings = data.settings
      if (!nextSettings) {
        throw new Error('BladeVault did not return settings data.')
      }

      setSettings(nextSettings)
      setLocalDataPath(data.localDataPath || normalizedPendingLocalDataPath)
      setConfiguredLocalDataPath(data.configuredLocalDataPath || '')
      setDefaultLocalDataPath(data.defaultLocalDataPath || '')
      setPendingLocalDataPath(
        data.localDataPath || normalizedPendingLocalDataPath,
      )
      setDockerHostDataMountPath(data.dockerHostDataMountPath || '')
      setIsContainerized(Boolean(data.isContainerized))
      applyThemePreference(nextSettings.theme)
      window.dispatchEvent(
        new CustomEvent<Partial<AppSettings>>(SETTINGS_UPDATED_EVENT, {
          detail: nextSettings,
        }),
      )

      setLocalDataStatus('success')
      setLocalDataMessage(
        data.warning ||
          `${data.message || 'Local data folder updated.'} Reloading your vault...`,
      )
      window.setTimeout(() => window.location.reload(), 700)
    } catch (error) {
      setLocalDataStatus('error')
      setLocalDataMessage(
        error instanceof Error
          ? error.message
          : 'Failed to update local data folder',
      )
    }
  }

  const handleGoogleSignIn = async () => {
    if (!settings) return

    setAuthStatus('loading')
    setAuthMessage('Opening Google sign-in...')

    try {
      const nextConfig = await refreshCloudConfig()
      const nextAuthOrigin = nextConfig.authUrl
        ? new URL(nextConfig.authUrl).origin
        : ''
      if (!nextConfig.authUrl || !nextAuthOrigin) {
        throw new Error('NEXT_PUBLIC_BLADEVAULT_AUTH_URL is not configured.')
      }

      const clientOrigin =
        typeof window !== 'undefined' ? window.location.origin : '/'
      const startUrl = new URL('/auth/popup/start', nextConfig.authUrl)
      startUrl.searchParams.set('client_origin', clientOrigin)

      const popup = window.open(
        startUrl.toString(),
        'bladevault-google-auth',
        'width=500,height=640,menubar=no,toolbar=no',
      )

      if (!popup) {
        throw new Error('Popup was blocked. Allow popups and try again.')
      }

      const result = await new Promise<CloudAuthSuccessMessage>(
        (resolve, reject) => {
          let settled = false

          const cleanup = () => {
            if (settled) return
            settled = true
            window.removeEventListener('message', onMessage)
            window.clearInterval(closedPoll)
            window.clearTimeout(timeout)
          }

          const onMessage = (event: MessageEvent) => {
            if (event.origin !== nextAuthOrigin) return
            const data = event.data as
              CloudAuthSuccessMessage | CloudAuthErrorMessage
            if (!data || typeof data !== 'object' || !('type' in data)) return

            if (data.type === 'bladevault-auth-error') {
              cleanup()
              reject(new Error(data.error.message || 'Google sign-in failed.'))
              return
            }
            if (data.type !== 'bladevault-auth-success') return

            cleanup()
            resolve(data)
          }

          const closedPoll = window.setInterval(() => {
            if (popup.closed) {
              cleanup()
              reject(new Error('Google sign-in was closed before completion.'))
            }
          }, 500)

          const timeout = window.setTimeout(
            () => {
              cleanup()
              try {
                popup.close()
              } catch {
                // ignore
              }
              reject(new Error('Google sign-in timed out. Please try again.'))
            },
            5 * 60 * 1000,
          )

          window.addEventListener('message', onMessage)
        },
      )

      const nextAuthState: CloudAuthState = {
        accessToken: result.accessToken,
        sessionToken: result.sessionToken,
        expiresAt: result.expiresAt,
        user: result.user,
      }
      setCloudAuthState(nextAuthState)
      await refreshCloudSession()
      setAuthStatus('success')
      setAuthMessage('Signed in. Cloud backup is ready.')
    } catch (error) {
      setAuthStatus('error')
      setAuthMessage(
        formatCloudBackupError(error, getCloudRuntimeConfig().authUrl),
      )
    }
  }

  const handleLogout = async () => {
    if (!settings) return

    try {
      const nextConfig = await refreshCloudConfig()
      if (!nextConfig.authUrl) {
        throw new Error('NEXT_PUBLIC_BLADEVAULT_AUTH_URL is not configured.')
      }

      const response = await fetch(`${nextConfig.authUrl}/api/auth/sign-out`, {
        method: 'POST',
        headers: createCloudAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({}),
      })

      if (!response.ok) {
        throw new Error(await parseApiError(response))
      }

      setCloudSession(null)
      clearCloudAuthState()
    } catch {
      // Leave the current session intact when remote sign-out fails.
    }
  }

  const handleBackup = async () => {
    if (!settings) return

    setBackupStatus('loading')
    setBackupMessage('Uploading your local data folder...')

    try {
      const { syncedAt } = await uploadCloudBackupArchive()
      setSettings((prev) =>
        prev ? { ...prev, cloudBackupLastSyncedAt: syncedAt } : prev,
      )
      setBackupStatus('success')
      setBackupMessage('Cloud backup is up to date.')
    } catch (error) {
      setBackupStatus('error')
      setBackupMessage(
        formatCloudBackupError(error, getCloudRuntimeConfig().backupUrl),
      )
    }
  }

  const handleRestore = async () => {
    if (!settings) return
    if (
      !window.confirm(
        'Restore the latest cloud backup and replace the local database on this device?',
      )
    ) {
      return
    }

    setRestoreStatus('loading')
    setRestoreMessage('Downloading your cloud backup...')

    try {
      const nextConfig = await refreshCloudConfig()
      if (!nextConfig.backupUrl) {
        throw new Error('NEXT_PUBLIC_BLADEVAULT_BACKUP_URL is not configured.')
      }

      const accessToken = await refreshCloudBackupAccessToken()

      const importResponse = await fetch('/api/cloud-backup/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          backupUrl: nextConfig.backupUrl,
          accessToken,
        }),
      })

      const importData = await readJsonResponse<{ error?: string }>(
        importResponse,
      )
      if (!importResponse.ok) {
        throw new Error(
          getApiErrorMessage(
            importData,
            'Failed to restore cloud backup locally',
          ),
        )
      }

      await refreshVault()
      await refreshRestoredSettings()
      setRestoreStatus('success')
      setRestoreMessage('Cloud backup restored successfully.')
    } catch (error) {
      setRestoreStatus('error')
      setRestoreMessage(
        formatCloudBackupError(error, getCloudRuntimeConfig().backupUrl),
      )
    }
  }

  const handleLocalBackupDownload = async () => {
    setLocalBackupStatus('loading')
    setLocalBackupMessage('Creating a full local backup...')

    try {
      const desktopSave = window.bladevaultDesktop?.saveBackupFile
      if (desktopSave) {
        const filename = `bladevault-backup-${new Date().toISOString().slice(0, 10)}.zip`
        const saved = await desktopSave(filename)
        if (!saved) {
          setLocalBackupStatus('idle')
          setLocalBackupMessage('')
          return
        }
        setLocalBackupStatus('success')
        setLocalBackupMessage('Full local backup saved successfully.')
        return
      }

      const response = await fetch('/api/local-backup/archive', {
        cache: 'no-store',
      })
      if (!response.ok) {
        const data = await readJsonResponse<{ error?: string }>(response)
        throw new Error(
          getApiErrorMessage(data, 'Failed to create local backup'),
        )
      }

      const filename = getBackupDownloadName(response)
      const saved = await saveBackupResponse(response, filename)
      if (!saved) {
        setLocalBackupStatus('idle')
        setLocalBackupMessage('')
        return
      }

      setLocalBackupStatus('success')
      setLocalBackupMessage('Full local backup saved successfully.')
    } catch (error) {
      setLocalBackupStatus('error')
      setLocalBackupMessage(
        error instanceof Error
          ? error.message
          : 'Failed to create local backup',
      )
    }
  }

  const handleLocalRestoreFile = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    setLocalBackupStatus('loading')
    setLocalBackupMessage('Validating the selected backup...')

    try {
      const inspectResponse = await fetch('/api/local-backup/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      })
      const inspectData = await readJsonResponse<{
        error?: string
        manifest?: LocalBackupManifest
      }>(inspectResponse)
      if (!inspectResponse.ok || !inspectData.manifest) {
        throw new Error(
          getApiErrorMessage(inspectData, 'Selected backup is invalid'),
        )
      }

      const manifest = inspectData.manifest
      const createdAt = formatSyncTime(manifest.createdAt)
      const confirmed = window.confirm(
        `Restore ${manifest.knifeCount} knives and ${manifest.imageCount} images from the backup created ${createdAt}?\n\nThis replaces the current local database and images. BladeVault will keep a safety copy of the current data.`,
      )
      if (!confirmed) {
        setLocalBackupStatus('idle')
        setLocalBackupMessage('')
        return
      }

      setLocalBackupMessage('Restoring the local backup...')
      const restoreResponse = await fetch('/api/local-backup/archive', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      })
      const restoreData = await readJsonResponse<{
        error?: string
        manifest?: LocalBackupManifest
      }>(restoreResponse)
      if (!restoreResponse.ok) {
        throw new Error(
          getApiErrorMessage(restoreData, 'Failed to restore local backup'),
        )
      }

      await refreshVault()
      await refreshRestoredSettings()
      setLocalBackupStatus('success')
      setLocalBackupMessage(
        `Local backup restored successfully (${manifest.knifeCount} knives and ${manifest.imageCount} images).`,
      )
    } catch (error) {
      setLocalBackupStatus('error')
      setLocalBackupMessage(
        error instanceof Error
          ? error.message
          : 'Failed to restore local backup',
      )
    }
  }

  const handleAutoBackupToggle = async (checked: boolean) => {
    if (!settings) return

    try {
      await saveSettings({ cloudAutoBackupEnabled: checked })
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : 'Failed to save settings',
      )
    }
  }

  const handleThemeChange = async (value: string | null) => {
    const theme = value as AppTheme
    if (!theme || !APP_THEMES.includes(theme)) return

    try {
      await saveSettings({ theme })
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : 'Failed to save settings',
      )
    }
  }

  const handlePinnedItemsFirstToggle = async (checked: boolean) => {
    if (!settings) return

    try {
      await saveSettings({ pinnedItemsFirst: checked })
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : 'Failed to save settings',
      )
    }
  }

  const handleCardFieldToggle = async (field: CardField, checked: boolean) => {
    if (!settings) return

    const nextFields = checked
      ? [...settings.cardFields.filter((item) => item !== field), field]
      : settings.cardFields.filter((item) => item !== field)

    try {
      setIsSavingCardFields(true)
      await saveSettings({ cardFields: nextFields })
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : 'Failed to save settings',
      )
    } finally {
      setIsSavingCardFields(false)
    }
  }

  const handleAddField = () => {
    const name = newFieldName.trim()
    if (!name) return

    void handleUpdateCustomFields((fields) => [
      ...fields,
      {
        id: generateFieldId(name, fields),
        name,
        type: newFieldType,
      },
    ])
    setNewFieldName('')
    setNewFieldType('text')
  }

  const handleUpdateCustomFields = async (
    updater: (fields: CustomField[]) => CustomField[],
  ) => {
    if (!settings) return

    const nextCustomFields = updater(settings.customFields)
    if (
      JSON.stringify(nextCustomFields) === JSON.stringify(settings.customFields)
    ) {
      return
    }

    const customFieldIds = new Set(nextCustomFields.map((field) => field.id))
    const nextCardFields = settings.cardFields.filter(
      (field) =>
        !field.startsWith('custom:') ||
        customFieldIds.has(field.slice('custom:'.length)),
    )

    try {
      await saveSettings({
        customFields: nextCustomFields,
        cardFields: nextCardFields,
      })
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : 'Failed to save settings',
      )
    }
  }

  const generateFieldId = (name: string, existing: CustomField[]): string => {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 64) || `field-${Date.now()}`
    const ids = new Set(existing.map((field) => field.id))
    if (!ids.has(base)) return base
    let counter = 2
    while (ids.has(`${base}-${counter}`)) {
      counter += 1
    }
    return `${base}-${counter}`
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : !settings ? (
        <div className="flex flex-col gap-4 py-6">
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{loadError || 'Failed to load settings.'}</span>
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button
              size="sm"
              className={`${settingsPrimaryButtonClassName} rounded-lg`}
              onClick={() => setLoadAttemptKey((current) => current + 1)}
            >
              Retry
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border border-[var(--bladevault-line)] bg-background sm:flex-row">
          {/* Sidebar */}
          <aside className="flex w-full shrink-0 border-b border-[var(--bladevault-line)] bg-background sm:w-56 sm:flex-col sm:border-r sm:border-b-0">
            <nav className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto p-2 sm:min-h-0 sm:flex-col sm:overflow-x-hidden sm:overflow-y-auto">
              {tabs.map((tab) => {
                const isActive = tab.id === activeTab
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={cn(
                      settingsTabTriggerClassName,
                      isActive
                        ? 'bg-[var(--bladevault-olive)] font-medium text-[var(--bladevault-gold)]'
                        : 'text-muted-foreground hover:bg-[var(--bladevault-surface-hover)] hover:text-foreground',
                    )}
                  >
                    <tab.icon className="h-4 w-4 shrink-0" />
                    <span className="flex-1">{tab.label}</span>
                    {tab.id === 'cloud-backup' ? (
                      <span
                        className={cn(
                          'flex h-4 shrink-0 items-center rounded-full border px-1.5 text-[10px] font-semibold uppercase tracking-[0.14em]',
                          isActive
                            ? 'border-[var(--bladevault-gold)] bg-[var(--bladevault-gold)] text-[var(--bladevault-olive)]'
                            : 'border-[var(--bladevault-line)] bg-[var(--bladevault-surface-soft)] text-[var(--bladevault-olive)] dark:border-[var(--bladevault-gold)] dark:bg-[var(--bladevault-gold)] dark:text-[var(--bladevault-olive)]',
                        )}
                      >
                        Beta
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </nav>
          </aside>

          {/* Main content */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
            <div className="min-h-0 flex-1 overflow-y-auto bg-background p-4 sm:p-5">
              {activeTab === 'general' && (
                <div className="mx-auto max-w-3xl space-y-3">
                  <SettingsSection>
                    <SettingsRow
                      label="Current data folder"
                      description="The active vault used by BladeVault right now."
                    >
                      <MonoValue>{localDataPath || 'Unavailable'}</MonoValue>
                    </SettingsRow>

                    <SettingsRow
                      label="Change local data folder"
                      description="Change where images and the database are stored."
                    >
                      <div className="flex w-full gap-2 sm:w-auto">
                        <Input
                          value={pendingLocalDataPath}
                          onChange={(event) => {
                            setPendingLocalDataPath(event.target.value)
                            setLocalDataStatus('idle')
                            setLocalDataMessage('')
                          }}
                          placeholder={
                            defaultLocalDataPath || '/Users/you/BladeVault/data'
                          }
                          disabled={dataDirManagedByEnv}
                          className="h-8 min-w-[10rem] rounded-lg border-[var(--bladevault-line)] bg-background font-mono text-xs shadow-none dark:border-[#d3c097]/30"
                        />
                        {canChooseLocalDataFolder ? (
                          <Button
                            type="button"
                            variant="outline"
                            className={`${settingsSecondaryButtonClassName} h-8 rounded-lg`}
                            onClick={handleChooseLocalDataFolder}
                            disabled={dataDirManagedByEnv}
                          >
                            <FolderOpen className="h-3.5 w-3.5" />
                            Choose
                          </Button>
                        ) : null}
                      </div>
                    </SettingsRow>

                    <SettingsRow
                      label="Move existing data"
                      description="Copy your current vault into the new folder."
                    >
                      <Checkbox
                        checked={moveExistingLocalData}
                        onCheckedChange={(checked) =>
                          setMoveExistingLocalData(checked === true)
                        }
                        disabled={dataDirManagedByEnv}
                        aria-label="Move existing local data"
                      />
                    </SettingsRow>

                    {configuredLocalDataPath ? (
                      <SettingsRow
                        label="Launch folder"
                        description="Path saved in settings for the next launch."
                      >
                        <MonoValue>{configuredLocalDataPath}</MonoValue>
                      </SettingsRow>
                    ) : null}

                    {dataDirManagedByEnv ? (
                      <SettingsRow
                        label="Data directory source"
                        description="This folder is controlled by BLADEVAULT_DATA_DIR."
                      >
                        <MonoValue>{localDataPath || 'Unavailable'}</MonoValue>
                      </SettingsRow>
                    ) : null}

                    {dockerHostDataMountPath ? (
                      <SettingsRow
                        label="Docker host mount"
                        description="The host path mounted into the container."
                      >
                        <MonoValue>{dockerHostDataMountPath}</MonoValue>
                      </SettingsRow>
                    ) : null}

                    {isContainerized && !dockerHostDataMountPath ? (
                      <SettingsRow
                        label="Docker host mount"
                        description="Host folder is unavailable in this container."
                      />
                    ) : null}

                    <div className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <StatusPill
                        status={localDataStatus}
                        message={localDataMessage}
                      />
                      <Button
                        type="button"
                        size="sm"
                        className={`${settingsPrimaryButtonClassName} rounded-lg sm:self-auto`}
                        onClick={handleSaveLocalDataFolder}
                        disabled={
                          dataDirManagedByEnv ||
                          !normalizedPendingLocalDataPath ||
                          !isLocalDataFolderDirty
                        }
                      >
                        {localDataStatus === 'loading' ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : null}
                        Save Folder
                      </Button>
                    </div>
                  </SettingsSection>
                </div>
              )}

              {activeTab === 'cloud-backup' && (
                <div className="mx-auto max-w-2xl space-y-3">
                  <SettingsSection title="Account">
                    {cloudSession ? (
                      <SettingsRow
                        label={cloudSession.user.email}
                        description="Cloud backup account"
                      >
                        <Button
                          variant="outline"
                          size="sm"
                          className={`${settingsSecondaryButtonClassName} h-8 rounded-lg`}
                          onClick={handleLogout}
                        >
                          <LogOut className="h-3.5 w-3.5" />
                          Sign Out
                        </Button>
                      </SettingsRow>
                    ) : (
                      <>
                        {cloudConfigError ? (
                          <div className="py-3">
                            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm text-destructive">
                              {cloudConfigError}
                            </div>
                          </div>
                        ) : null}

                        <SettingsRow
                          label="No account connected"
                          description="Sign in to back up this vault to the cloud."
                        >
                          <Button
                            size="sm"
                            className={`${settingsPrimaryButtonClassName} h-8 rounded-lg`}
                            onClick={handleGoogleSignIn}
                            disabled={Boolean(cloudConfigError)}
                          >
                            <FcGoogle className="h-4 w-4" />
                            Continue With Google
                          </Button>
                        </SettingsRow>

                        {authStatus !== 'idle' ? (
                          <div className="py-3">
                            <StatusPill
                              status={authStatus}
                              message={authMessage}
                            />
                          </div>
                        ) : null}
                      </>
                    )}
                  </SettingsSection>

                  <SettingsSection title="Backup">
                    <SettingsRow
                      label="Back up now"
                      description="Upload this device's local vault to the cloud."
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        className={`${settingsSecondaryButtonClassName} h-8 rounded-lg`}
                        onClick={handleBackup}
                        disabled={!cloudSession || backupStatus === 'loading'}
                      >
                        {backupStatus === 'loading' ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Upload className="h-3.5 w-3.5" />
                        )}
                        Backup
                      </Button>
                    </SettingsRow>

                    <SettingsRow
                      label="Automatic backup"
                      description="Upload changes automatically after edits."
                    >
                      <Checkbox
                        checked={settings.cloudAutoBackupEnabled}
                        onCheckedChange={(checked) =>
                          handleAutoBackupToggle(checked === true)
                        }
                        disabled={!cloudSession}
                        aria-label="Enable automatic backup"
                      />
                    </SettingsRow>
                  </SettingsSection>

                  <SettingsSection title="Status">
                    <SettingsRow
                      label="Cloud connection"
                      description={`Last backup: ${formatSyncTime(
                        settings.cloudBackupLastSyncedAt,
                      )}`}
                    >
                      {cloudSession ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--bladevault-local)] dark:text-[var(--bladevault-gold)]">
                          <ShieldCheck className="h-3.5 w-3.5" />
                          Connected
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Not connected
                        </span>
                      )}
                    </SettingsRow>

                    {backupStatus !== 'idle' ? (
                      <div className="py-3">
                        <StatusPill
                          status={backupStatus}
                          message={backupMessage}
                        />
                      </div>
                    ) : null}
                  </SettingsSection>
                </div>
              )}

              {activeTab === 'restore-database' && (
                <div className="mx-auto max-w-3xl space-y-3">
                  <SettingsSection
                    title="Local backup"
                    description="Create or restore a portable ZIP on this device. No cloud account is required."
                  >
                    <SettingsRow
                      label="Download full backup"
                      description="Save the database, collection settings, history, compare list, and local images in one ZIP file."
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        className={`${settingsSecondaryButtonClassName} h-8 rounded-lg`}
                        onClick={handleLocalBackupDownload}
                        disabled={localBackupStatus === 'loading'}
                      >
                        {localBackupStatus === 'loading' ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                        Download ZIP
                      </Button>
                    </SettingsRow>

                    <SettingsRow
                      label="Restore from local ZIP"
                      description="Validate a BladeVault backup, review its contents, then replace this device's local database and images."
                    >
                      <input
                        ref={localRestoreInputRef}
                        type="file"
                        accept=".zip,application/zip"
                        className="hidden"
                        onChange={handleLocalRestoreFile}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        className={`${settingsSecondaryButtonClassName} h-8 rounded-lg`}
                        onClick={() => localRestoreInputRef.current?.click()}
                        disabled={localBackupStatus === 'loading'}
                      >
                        <Upload className="h-3.5 w-3.5" />
                        Choose ZIP
                      </Button>
                    </SettingsRow>

                    <div className="py-3">
                      <StatusPill
                        status={localBackupStatus}
                        message={localBackupMessage}
                      />
                    </div>
                  </SettingsSection>

                  <SettingsSection
                    title="Cloud restore"
                    description="The existing cloud backup restore remains separate from local ZIP backups."
                  >
                    {!cloudSession ? (
                      <div className="py-3 text-sm text-muted-foreground">
                        Sign in under Cloud Backup before restoring from the
                        cloud.
                      </div>
                    ) : null}
                    <SettingsRow
                      label="Restore from cloud"
                      description="Restore the latest cloud backup to this device. This replaces the local data."
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        className={`${settingsSecondaryButtonClassName} h-8 rounded-lg`}
                        onClick={handleRestore}
                        disabled={!cloudSession || restoreStatus === 'loading'}
                      >
                        {restoreStatus === 'loading' ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                        Restore
                      </Button>
                    </SettingsRow>

                    <div className="py-3">
                      <StatusPill
                        status={restoreStatus}
                        message={restoreMessage}
                      />
                    </div>
                  </SettingsSection>
                </div>
              )}

              {activeTab === 'appearance' && (
                <div className="mx-auto max-w-3xl space-y-3">
                  <SettingsSection title="Theme">
                    <SettingsRow
                      label="Appearance"
                      description="Choose how BladeVault looks on this device."
                    >
                      <Select
                        value={settings.theme}
                        onValueChange={handleThemeChange}
                      >
                        <SelectTrigger
                          size="sm"
                          className="h-8 min-w-[8rem] rounded-lg border-[var(--bladevault-line)] bg-[var(--bladevault-surface-soft)]"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {APP_THEMES.map((theme) => (
                            <SelectItem
                              key={theme}
                              value={theme}
                              className="text-sm capitalize"
                            >
                              {theme}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </SettingsRow>
                  </SettingsSection>
                  <SettingsSection title="Collection">
                    <SettingsRow
                      label="Keep pinned knives first"
                      description="Place pinned knives before other items in the Dashboard, Collection, and Compare views."
                    >
                      <Checkbox
                        checked={settings.pinnedItemsFirst}
                        onCheckedChange={(checked) =>
                          handlePinnedItemsFirstToggle(checked === true)
                        }
                      />
                    </SettingsRow>
                  </SettingsSection>
                  <SettingsSection
                    title="Card fields"
                    description="Choose any structured or custom details to show on knife cards."
                  >
                    <div className="grid gap-5 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-start">
                      <CardFieldsPreview
                        fields={settings.cardFields}
                        customFields={settings.customFields}
                      />
                      <div
                        className="max-h-[28rem] overflow-y-auto rounded-lg border border-[var(--bladevault-line)]/70 bg-background"
                        aria-busy={isSavingCardFields}
                      >
                        <div className="flex items-center justify-between gap-3 border-b border-[var(--bladevault-line)]/60 px-3 py-2.5">
                          <div>
                            <div className="text-sm font-medium text-foreground">
                              Brand
                            </div>
                            <div className="text-xs text-muted-foreground">
                              Always shown
                            </div>
                          </div>
                          <Lock className="size-3.5 text-muted-foreground" />
                        </div>
                        <div className="flex items-center justify-between gap-3 border-b border-[var(--bladevault-line)]/60 px-3 py-2.5">
                          <div>
                            <div className="text-sm font-medium text-foreground">
                              Model
                            </div>
                            <div className="text-xs text-muted-foreground">
                              Always shown
                            </div>
                          </div>
                          <Lock className="size-3.5 text-muted-foreground" />
                        </div>
                        {getCardFieldGroups(settings.customFields).map(
                          (group) => (
                            <div key={group.label}>
                              <div className="sticky top-0 z-10 border-b border-[var(--bladevault-line)]/60 bg-[var(--bladevault-surface-soft)] px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                                {group.label}
                              </div>
                              {group.fields.map((field) => (
                                <label
                                  key={field.key}
                                  className="flex cursor-pointer items-center justify-between gap-3 border-b border-[var(--bladevault-line)]/60 px-3 py-3 last:border-b-0"
                                >
                                  <span className="text-sm font-medium text-foreground">
                                    {field.label}
                                  </span>
                                  <Checkbox
                                    checked={settings.cardFields.includes(
                                      field.key,
                                    )}
                                    disabled={isSavingCardFields}
                                    onCheckedChange={(checked) =>
                                      handleCardFieldToggle(
                                        field.key,
                                        checked === true,
                                      )
                                    }
                                    aria-label={`Show ${field.label} on cards`}
                                  />
                                </label>
                              ))}
                            </div>
                          ),
                        )}
                      </div>
                    </div>
                  </SettingsSection>
                </div>
              )}

              {activeTab === 'fields' && (
                <div className="mx-auto max-w-3xl space-y-3">
                  <SettingsSection
                    title="Custom Fields"
                    description="Define extra fields that apply to every knife. They appear in the add/edit form and as collection filters."
                  >
                    {settings.customFields.length === 0 ? (
                      <div className="py-3 text-sm text-muted-foreground">
                        No custom fields yet. Add one below to use it across
                        your library.
                      </div>
                    ) : (
                      <div className="divide-y divide-[var(--bladevault-line)]/60">
                        {settings.customFields.map((field, index) => (
                          <div
                            key={field.id}
                            className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center"
                          >
                            <Input
                              value={field.name}
                              onChange={(event) => {
                                const value = event.target.value
                                void handleUpdateCustomFields((fields) =>
                                  fields.map((item, itemIndex) =>
                                    itemIndex === index
                                      ? { ...item, name: value }
                                      : item,
                                  ),
                                )
                              }}
                              placeholder="Field name"
                              className="h-8 flex-1 rounded-lg border-[var(--bladevault-line)] bg-background text-sm shadow-none dark:border-[#d3c097]/30"
                            />
                            <Select
                              value={field.type}
                              onValueChange={(value) => {
                                const type = value as CustomFieldType
                                if (!CUSTOM_FIELD_TYPES.includes(type)) return
                                void handleUpdateCustomFields((fields) =>
                                  fields.map((item, itemIndex) =>
                                    itemIndex === index
                                      ? { ...item, type }
                                      : item,
                                  ),
                                )
                              }}
                            >
                              <SelectTrigger
                                size="sm"
                                className="h-8 w-full rounded-lg border-[var(--bladevault-line)] bg-[var(--bladevault-surface-soft)] sm:w-28"
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {CUSTOM_FIELD_TYPES.map((type) => (
                                  <SelectItem
                                    key={type}
                                    value={type}
                                    className="text-sm capitalize"
                                  >
                                    {type}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon-sm"
                              className={`${settingsSecondaryButtonClassName} h-8 w-8 shrink-0 self-end rounded-lg sm:self-auto`}
                              onClick={() =>
                                void handleUpdateCustomFields((fields) =>
                                  fields.filter(
                                    (_, itemIndex) => itemIndex !== index,
                                  ),
                                )
                              }
                              aria-label={`Delete ${field.name} field`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="border-t border-[var(--bladevault-line)]/60 py-3">
                      <div className="mb-2 text-xs text-muted-foreground">
                        Add a field to show on every knife.
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <Input
                          value={newFieldName}
                          onChange={(event) =>
                            setNewFieldName(event.target.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              handleAddField()
                            }
                          }}
                          placeholder="New field name, e.g. Sold or Sell price"
                          className="h-8 flex-1 rounded-lg border-[var(--bladevault-line)] bg-background text-sm shadow-none dark:border-[#d3c097]/30"
                        />
                        <Select
                          value={newFieldType}
                          onValueChange={(value) => {
                            const type = value as CustomFieldType
                            if (CUSTOM_FIELD_TYPES.includes(type)) {
                              setNewFieldType(type)
                            }
                          }}
                        >
                          <SelectTrigger
                            size="sm"
                            className="h-8 w-full rounded-lg border-[var(--bladevault-line)] bg-[var(--bladevault-surface-soft)] sm:w-28"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {CUSTOM_FIELD_TYPES.map((type) => (
                              <SelectItem
                                key={type}
                                value={type}
                                className="text-sm capitalize"
                              >
                                {type}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          type="button"
                          size="sm"
                          className={`${settingsPrimaryButtonClassName} h-8 rounded-lg sm:self-auto`}
                          onClick={handleAddField}
                          disabled={!newFieldName.trim()}
                        >
                          Add
                        </Button>
                      </div>
                    </div>
                  </SettingsSection>
                </div>
              )}

              {activeTab === 'about' && (
                <div className="mx-auto max-w-3xl space-y-3">
                  <SettingsSection title="BladeVault">
                    <SettingsRow label="Version" description={pkg.version}>
                      <Button
                        size="sm"
                        className={`${settingsSecondaryButtonClassName} rounded-lg`}
                        onClick={handleUpdateAction}
                        disabled={
                          update.status === 'checking' ||
                          update.status === 'downloading'
                        }
                      >
                        {update.status === 'checking' ||
                        update.status === 'downloading' ? (
                          <Loader2 className="animate-spin" />
                        ) : update.status === 'available' ? (
                          <Download />
                        ) : update.status === 'downloaded' &&
                          update.platform === 'win32' ? (
                          <RefreshCw />
                        ) : (
                          <RefreshCw />
                        )}
                        {update.status === 'available'
                          ? 'Download update'
                          : update.status === 'downloaded' &&
                              update.platform === 'win32'
                            ? 'Restart to update'
                            : 'Check for updates'}
                      </Button>
                    </SettingsRow>
                    <SettingsRow label="Update status">
                      <StatusPill status={updateTone} message={updateMessage} />
                    </SettingsRow>
                    <SettingsRow
                      label="Repository"
                      description={pkg.repository?.url}
                    >
                      <a
                        href={pkg.repository?.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-8 items-center rounded-lg border border-[var(--bladevault-line)] bg-[var(--bladevault-surface-soft)] px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-[var(--bladevault-surface-hover)]"
                      >
                        View on GitHub
                      </a>
                    </SettingsRow>
                    <SettingsRow label="License" description="MIT" />
                  </SettingsSection>
                </div>
              )}
            </div>

            {loadError ? (
              <div className="mx-4 mb-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs text-destructive sm:mx-5">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{loadError}</span>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
