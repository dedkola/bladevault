'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  Copy,
  Database,
  Download,
  FolderOpen,
  ImageIcon,
  Info,
  Loader2,
  Lock,
  LogOut,
  Palette,
  Pin,
  Plug,
  Printer,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  Upload,
} from 'lucide-react'
import { CompareIcon } from '@/components/icons/compare-icon'
import { FcGoogle } from 'react-icons/fc'
import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'
import {
  APP_THEMES,
  CUSTOM_FIELD_TYPES,
  DEFAULT_SETTINGS,
  SETTINGS_UPDATED_EVENT,
  applyThemeStyleToElement,
  applyThemeModeToElement,
  hasFixedColorMode,
  START_PAGES,
  THEME_STYLES,
  TIME_FORMATS,
  DIMENSION_UNITS,
  type AppSettings,
  type AppTheme,
  type CardField,
  type CustomField,
  type CustomFieldType,
  type ThemeStyle,
  type TimeFormat,
  type DimensionUnit,
  type StartPage,
} from '@/lib/settings-shared'
import { getHourCycle } from '@/lib/time-format'
import { getCardFieldGroups, getCardFieldLabel } from '@/lib/card-fields'
import {
  connectDriveBackup,
  disconnectDriveBackup,
  getDriveBackupStatus,
} from '@/lib/drive-backup-client'
import type { DriveBackupStatus } from '@/lib/drive-backup-shared'
import { ScreenshotBackfill } from '@/components/screenshot-backfill'
import { AppLockSettings } from '@/components/app-lock-settings'
import { DesktopErrorReportingSettings } from '@/components/desktop-error-reporting-settings'
import { ServerErrorReportingSettings } from '@/components/server-error-reporting-settings'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { KnifeCardDetails } from '@/components/knife-card-details'
import { formatDimension, formatWeight } from '@/lib/measurements'
import {
  SettingsSection,
  SettingsRow,
  SettingsSwitch,
  SegmentedControl,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import pkg from '@/package.json'
import { useDesktopUpdates } from '@/hooks/use-desktop-updates'
import { useKnives } from '@/components/providers/knives-provider'
import { useVaultRestore } from '@/components/providers/vault-restore-provider'
import './settings-view.css'

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
  'app-lock' | 'general' | 'backup' | 'appearance' | 'fields' | 'mcp' | 'about'

type McpRuntimeStatus = {
  enabled: boolean
  writeEnabled: boolean
  controls: {
    enabledManagedByEnvironment: boolean
    writeEnabledManagedByEnvironment: boolean
  }
  http: {
    path: string
    authConfigured: boolean
    authToken: string
    authManagedByEnvironment: boolean
    authRequiredForRemote: boolean
  }
  tools: { read: number; write: number; total: number }
  activity: {
    lastActivityAt: string | null
    httpRequestsSinceStart: number
    toolCallsSinceStart: number
    lastTransport: 'http' | 'stdio' | null
  }
  stats: {
    knifeCount: number
    writeOperationCount: number
    changedKnifeCount: number
    lastWriteAt: string | null
  }
}

const settingsTabTriggerClassName =
  'flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors xl:w-full'

const settingsSecondaryButtonClassName =
  'border-border bg-[var(--bladevault-surface-soft)] text-foreground hover:bg-[var(--bladevault-surface-hover)] hover:text-foreground dark:border-input dark:bg-[var(--bladevault-surface-soft)] dark:text-[var(--bladevault-gold)] dark:hover:bg-[var(--bladevault-surface-hover)] dark:hover:text-[var(--bladevault-gold)]'

const settingsPrimaryButtonClassName =
  'border-primary bg-primary text-primary-foreground hover:bg-[var(--primary-hover)] hover:text-primary-foreground'

const themeStyleLabels: Record<ThemeStyle, { name: string; note: string }> = {
  classic: { name: 'Classic', note: 'Warm gold' },
  modern: { name: 'Modern', note: 'Cool graphite' },
  alloy: { name: 'Alloy', note: 'Black & gold' },
  forge: { name: 'Forge', note: 'Graphite & ember' },
  titanium: { name: 'Titanium', note: 'Anodized gradient' },
  field: { name: 'Field', note: 'Stone & acid lime' },
  lumen: { name: 'Lumen', note: 'White & orange' },
  espresso: { name: 'Espresso', note: 'Cream & dark roast' },
  phosphor: { name: 'Phosphor', note: 'Amber terminal' },
  atrium: { name: 'Atrium', note: 'Gallery & dock' },
  ledger: { name: 'Ledger', note: 'Green-bar ledger' },
}

const startPageOptions = START_PAGES.map((startPage) => ({
  value: startPage,
  label: startPage.charAt(0).toUpperCase() + startPage.slice(1),
}))
const colorModeOptions = APP_THEMES.map((theme) => ({
  value: theme,
  label: theme.charAt(0).toUpperCase() + theme.slice(1),
}))
const dimensionUnitOptions: { value: DimensionUnit; label: string }[] = [
  { value: 'in', label: 'Imperial' },
  { value: 'mm', label: 'Metric' },
  { value: 'both', label: 'Both' },
]
const timeFormatOptions = TIME_FORMATS.map((timeFormat) => ({
  value: timeFormat,
  label: timeFormat === '12h' ? '12-hour' : '24-hour',
}))

const subscribeToBrowserOrigin = () => () => {}
const getBrowserOrigin = () => window.location.origin
const getServerOrigin = () => ''

async function copyTextToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return
    } catch {
      // Plain HTTP LAN origins can expose the API but reject write access.
    }
  }

  const activeElement = document.activeElement
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.readOnly = true
  textarea.style.position = 'fixed'
  textarea.style.inset = '0 auto auto -9999px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)

  try {
    if (!document.execCommand('copy')) {
      throw new Error('Browser copy command was rejected.')
    }
  } finally {
    textarea.remove()
    if (activeElement instanceof HTMLElement) {
      activeElement.focus({ preventScroll: true })
    }
  }
}

function StatusPill({
  status,
  message,
  quiet = false,
}: {
  status: StatusTone
  message?: string
  quiet?: boolean
}) {
  if (status === 'idle') return null

  if (status === 'loading') {
    return (
      <span className="inline-flex max-w-full items-start gap-1.5 text-xs text-muted-foreground">
        {quiet ? (
          <Cloud className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        )}
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

function formatBackupSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  )
  const value = bytes / 1024 ** index
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

function formatSyncTime(
  value: string,
  timeFormat: TimeFormat = DEFAULT_SETTINGS.timeFormat,
) {
  if (!value) return 'Never'

  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      hourCycle: getHourCycle(timeFormat),
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

function applyThemePreference(
  theme: AppSettings['theme'],
  themeStyle: AppSettings['themeStyle'],
) {
  // Forge, Titanium, Field, Lumen and Espresso are variants of the Modern layout, so the
  // root needs `data-theme-style="modern"` plus a variant, not the raw style
  // name. The mode goes second so fixed-mode styles can set `dark` themselves.
  applyThemeStyleToElement(document.documentElement, themeStyle)
  applyThemeModeToElement(document.documentElement, theme)
}

function getCardFieldExampleValues(
  dimensionUnit: DimensionUnit,
): Record<string, string> {
  return {
    bladeStyle: 'Drop point',
    handleMaterial: 'Micarta',
    'specs.modelNumber': 'BV-01',
    'specs.designer': 'In-house design',
    'specs.country': 'USA',
    'specs.price': '$145',
    'specs.bladeMaterial': '154CM',
    'specs.bladeCoating': 'Satin',
    'specs.lockingMechanism': 'Crossbar lock',
    'specs.hardness': '60 HRC',
    'specs.overallLength': formatDimension('190 mm', dimensionUnit),
    'specs.bladeLength': formatDimension('3.25 in', dimensionUnit),
    'specs.bladeThickness': formatDimension('3 mm', dimensionUnit),
    'specs.handleLength': formatDimension('110 mm', dimensionUnit),
    'specs.weight': formatWeight('95 g', dimensionUnit),
  }
}

function CardFieldsPreview({
  fields,
  customFields,
  dimensionUnit,
}: {
  fields: CardField[]
  customFields: CustomField[]
  dimensionUnit: DimensionUnit
}) {
  const exampleValues = getCardFieldExampleValues(dimensionUnit)
  const previewFields = fields
    .filter((field) => field !== 'specs.modelNumber')
    .map((field) => ({
      key: field,
      label: getCardFieldLabel(field, customFields),
      value: exampleValues[field] ?? 'Example value',
    }))

  return (
    <div
      className="mx-auto w-full max-w-[15rem]"
      role="group"
      aria-label="Card appearance preview"
    >
      <Card className="@container/knife-card gap-0 p-0">
        <div
          data-photo-stage
          className="relative flex aspect-video items-center justify-center overflow-hidden bg-white"
        >
          <div className="relative h-7 w-32 -rotate-[24deg]" aria-hidden="true">
            <div className="absolute right-0 top-0 h-7 w-14 rounded-r-md bg-[var(--bladevault-olive)] shadow-sm" />
            <div className="absolute left-0 top-1 h-5 w-[4.75rem] rounded-l-full border border-[#aaa59b] bg-gradient-to-b from-[#f0f0ed] to-[#c9c9c4] shadow-sm [clip-path:polygon(0_50%,18%_0,100%_0,100%_100%,18%_100%)]" />
          </div>
        </div>
        <KnifeCardDetails
          brand="BladeVault"
          name="Sample knife"
          modelNumber="BV-01"
          fields={previewFields}
          bladeLength={formatDimension('80 mm', dimensionUnit)}
          dimensionUnit={dimensionUnit}
          footerAction={
            <span
              className="absolute right-2 inline-flex items-center gap-1"
              aria-hidden="true"
            >
              <CompareIcon className="size-3" /> Compare
            </span>
          }
        />
      </Card>
      <div className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
        <Lock className="size-3" />
        Brand and model are always shown
      </div>
    </div>
  )
}

function PinnedItemFieldsPreview({
  fields,
  dimensionUnit,
}: {
  fields: CardField[]
  dimensionUnit: DimensionUnit
}) {
  const exampleValues = getCardFieldExampleValues(dimensionUnit)
  const detailLine = fields
    .map((field) => exampleValues[field] ?? 'Example value')
    .filter(Boolean)
    .join(' · ')

  return (
    <div
      className="mx-auto w-full max-w-[17rem]"
      role="group"
      aria-label="Pinned item preview"
    >
      <div className="rounded-lg border border-border/70 bg-[var(--bladevault-surface-soft)] p-2">
        <div className="flex items-center gap-1.5 text-xs">
          <span
            className="flex size-6 shrink-0 items-center justify-center rounded border border-border/60 bg-background"
            aria-hidden="true"
          >
            <ImageIcon className="size-3 text-muted-foreground/60" />
          </span>
          <Pin
            className="size-3 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate">
              <span className="text-muted-foreground">Vosteed</span>
              <span className="mx-1 text-muted-foreground/50">·</span>
              <span className="font-medium text-foreground">Porcupine</span>
            </span>
            <span className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">
              {detailLine}
            </span>
          </span>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
        <Lock className="size-3" />
        Brand and name are always shown
      </div>
    </div>
  )
}

function CardFieldOptions({
  fields,
  customFields,
  lockedRows,
  disabled,
  onToggle,
  ariaLabelSuffix = 'cards',
}: {
  fields: CardField[]
  customFields: CustomField[]
  lockedRows: readonly { label: string; note: string }[]
  disabled: boolean
  onToggle: (field: CardField, checked: boolean) => void
  ariaLabelSuffix?: string
}) {
  return (
    <div className="settings-card-fields-options" aria-busy={disabled}>
      <div className="settings-chip-group">
        <div className="settings-chips">
          {lockedRows.map((row) => (
            <span
              key={row.label}
              className="settings-chip is-locked"
              title={row.note}
            >
              <Lock className="size-3" aria-hidden="true" />
              {row.label}
            </span>
          ))}
        </div>
      </div>
      {getCardFieldGroups(customFields).map((group) => {
        if (group.fields.length === 0) return null

        return (
          <div
            key={group.label}
            className="settings-chip-group"
            role="group"
            aria-label={group.label}
          >
            <div className="settings-chip-group-label">{group.label}</div>
            <div className="settings-chips">
              {group.fields.map((field) => {
                const checked = fields.includes(field.key)
                return (
                  <button
                    key={field.key}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    aria-label={`Show ${field.label} on ${ariaLabelSuffix}`}
                    disabled={disabled}
                    className="settings-chip"
                    onClick={() => onToggle(field.key, !checked)}
                  >
                    {field.label}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function SettingsView() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const tabParam = searchParams.get('tab')
  // Cloud backup and local Backup & Restore used to be separate tabs; keep
  // their old URLs working by sending both to the combined tab.
  const normalizedTabParam =
    tabParam === 'cloud-backup' || tabParam === 'restore-database'
      ? 'backup'
      : tabParam
  const activeTab: SettingsTab = [
    'general',
    'app-lock',
    'backup',
    'appearance',
    'fields',
    'mcp',
    'about',
  ].includes(normalizedTabParam || '')
    ? (normalizedTabParam as SettingsTab)
    : 'general'
  const setActiveTab = useCallback(
    (tab: SettingsTab) => {
      const params = new URLSearchParams(searchParams.toString())
      params.set('tab', tab)
      router.push(`/settings?${params}`, { scroll: false })
    },
    [router, searchParams],
  )
  const isDesktop = useSyncExternalStore(
    subscribeToBrowserOrigin,
    () => Boolean(window.bladevaultDesktop),
    () => false,
  )
  const { update, checkForUpdates, downloadUpdate, installUpdate } =
    useDesktopUpdates()
  const { knives, refreshVault, cloudBackupJob, startVaultBackup } = useKnives()
  const {
    job: restoreJob,
    readOnly: isVaultReadOnly,
    startRestore,
  } = useVaultRestore()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [localDataPath, setLocalDataPath] = useState('')
  const [configuredLocalDataPath, setConfiguredLocalDataPath] = useState('')
  const [defaultLocalDataPath, setDefaultLocalDataPath] = useState('')
  const [pendingLocalDataPath, setPendingLocalDataPath] = useState('')
  const [moveExistingLocalData, setMoveExistingLocalData] = useState(true)
  const [dataDirManagedByEnv, setDataDirManagedByEnv] = useState(false)
  const [dockerHostDataMountPath, setDockerHostDataMountPath] = useState('')
  const [isContainerized, setIsContainerized] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const backupStatus: StatusTone =
    cloudBackupJob.status === 'running' ? 'loading' : cloudBackupJob.status
  const restoreStatus: StatusTone =
    restoreJob.status === 'running' ? 'loading' : restoreJob.status
  const driveBackupPillStatus = backupStatus
  const driveRestorePillStatus = restoreStatus
  const driveBackupMessage =
    cloudBackupJob.status === 'running'
      ? 'Backing up in the background. You can leave this page.'
      : cloudBackupJob.status === 'error'
        ? cloudBackupJob.message || 'Google Drive backup failed. Try again.'
        : 'Backup saved to Google Drive.'
  const driveRestoreMessage =
    restoreJob.status === 'running'
      ? restoreJob.phase === 'applying'
        ? 'Applying restored vault…'
        : restoreJob.phase === 'validating'
          ? 'Checking your backup. You can keep browsing; editing is paused.'
          : 'Downloading in the background. You can leave this page; editing is paused.'
      : restoreJob.status === 'error'
        ? restoreJob.message ||
          'Google Drive restore failed. Your vault was not replaced.'
        : 'Backup restored successfully.'
  const [driveStatus, setDriveStatus] = useState<DriveBackupStatus | null>(null)
  const [driveAuthStatus, setDriveAuthStatus] = useState<StatusTone>('idle')
  const [driveAuthMessage, setDriveAuthMessage] = useState('')
  const [localBackupStatus, setLocalBackupStatus] = useState<StatusTone>('idle')
  const [localBackupMessage, setLocalBackupMessage] = useState('')
  const [localDataStatus, setLocalDataStatus] = useState<StatusTone>('idle')
  const [localDataMessage, setLocalDataMessage] = useState('')
  const [isChangingDataFolder, setIsChangingDataFolder] = useState(false)
  const [loadAttemptKey, setLoadAttemptKey] = useState(0)
  const [fieldToDelete, setFieldToDelete] = useState<CustomField | null>(null)
  const [deletingField, setDeletingField] = useState(false)
  const deletingFieldRef = useRef(false)
  const [fieldDeleteError, setFieldDeleteError] = useState('')
  const [newFieldName, setNewFieldName] = useState('')
  const [newFieldType, setNewFieldType] = useState<CustomFieldType>('text')
  const [isSavingCardFields, setIsSavingCardFields] = useState(false)
  const [isSavingPinnedCardFields, setIsSavingPinnedCardFields] =
    useState(false)
  const [mcpStatus, setMcpStatus] = useState<McpRuntimeStatus | null>(null)
  const [copiedMcpConfig, setCopiedMcpConfig] = useState(false)
  const [copiedMcpToken, setCopiedMcpToken] = useState(false)
  const [mcpUpdateStatus, setMcpUpdateStatus] = useState<StatusTone>('idle')
  const [mcpUpdateMessage, setMcpUpdateMessage] = useState('')
  const localRestoreInputRef = useRef<HTMLInputElement>(null)

  const updateMessage =
    update.status === 'checking'
      ? 'Checking GitHub for a newer release...'
      : update.status === 'downloading'
        ? `Downloading update${update.percent != null ? ` (${update.percent}%)` : '...'}`
        : update.status === 'downloaded'
          ? update.platform === 'darwin'
            ? 'DMG opened. Quit BladeVault and replace the app in Applications.'
            : update.platform === 'linux' && update.path
              ? 'Installer opened. Finish the installation, then reopen BladeVault.'
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
    // Manual installers (macOS DMG, Linux deb) are handed off to the OS, so
    // only updater-managed downloads (Windows, Linux AppImage) restart in place.
    if (update.status === 'downloaded' && !update.path) {
      await installUpdate()
      return
    }

    if (update.status === 'available') {
      await downloadUpdate()
      return
    }

    await checkForUpdates()
  }

  const canChooseLocalDataFolder =
    typeof window !== 'undefined' &&
    Boolean(window.bladevaultDesktop?.selectDirectory)
  const normalizedPendingLocalDataPath = pendingLocalDataPath.trim()
  const isLocalDataFolderDirty =
    normalizedPendingLocalDataPath !== '' &&
    normalizedPendingLocalDataPath !== localDataPath
  const showDataFolderForm = isChangingDataFolder || localDataStatus !== 'idle'
  const browserOrigin = useSyncExternalStore(
    subscribeToBrowserOrigin,
    getBrowserOrigin,
    getServerOrigin,
  )
  const mcpEndpointUrl = browserOrigin
    ? new URL(mcpStatus?.http.path || '/mcp', browserOrigin).toString()
    : mcpStatus?.http.path || '/mcp'
  const mcpClientConfig = mcpStatus
    ? JSON.stringify(
        {
          mcpServers: {
            bladevault: {
              url: mcpEndpointUrl,
              headers: {
                Authorization: `Bearer ${mcpStatus.http.authToken}`,
              },
            },
          },
        },
        null,
        2,
      )
    : ''

  useEffect(() => {
    const openCloudBackup = () => setActiveTab('backup')

    window.addEventListener(
      'bladevault:open-cloud-backup-settings',
      openCloudBackup,
    )
    return () =>
      window.removeEventListener(
        'bladevault:open-cloud-backup-settings',
        openCloudBackup,
      )
  }, [setActiveTab])

  const tabs = useMemo(
    () => [
      {
        id: 'general' as const,
        label: 'Local storage',
        icon: Database,
        blurb: 'Where this vault keeps its database and images.',
      },
      {
        id: 'app-lock' as const,
        label: 'App lock',
        icon: Lock,
        blurb: 'Require a password before the vault opens on this device.',
      },
      {
        id: 'backup' as const,
        label: 'Backup & Restore',
        icon: Cloud,
        blurb: 'Back up to your Google Drive or save a portable ZIP you own.',
      },
      {
        id: 'appearance' as const,
        label: 'Appearance',
        icon: Palette,
        blurb: 'How BladeVault looks and which details appear on cards.',
      },
      {
        id: 'fields' as const,
        label: 'Custom fields',
        icon: SlidersHorizontal,
        blurb: 'Extra fields that apply to every knife in this vault.',
      },
      {
        id: 'mcp' as const,
        label: 'AI / MCP',
        icon: Plug,
        blurb: 'Let an assistant read or write this vault over MCP.',
      },
      {
        id: 'about' as const,
        label: 'About',
        icon: Info,
        blurb: 'Version, updates and licensing.',
      },
    ],
    [],
  )

  const activeTabMeta = tabs.find((tab) => tab.id === activeTab) ?? tabs[0]

  useEffect(() => {
    const cancellation = { cancelled: false }

    async function load() {
      setIsLoading(true)
      setLoadError(null)
      setLocalDataStatus('idle')
      setLocalDataMessage('')

      try {
        const [response, mcpResponse] = await Promise.all([
          fetch('/api/settings', { cache: 'no-store' }),
          fetch('/api/settings/mcp', { cache: 'no-store' }),
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
        applyThemePreference(nextSettings.theme, nextSettings.themeStyle)
        setLocalDataPath(data.localDataPath || '')
        setConfiguredLocalDataPath(data.configuredLocalDataPath || '')
        setDefaultLocalDataPath(data.defaultLocalDataPath || '')
        setPendingLocalDataPath(data.localDataPath || '')
        setDataDirManagedByEnv(Boolean(data.dataDirManagedByEnv))
        setDockerHostDataMountPath(data.dockerHostDataMountPath || '')
        setIsContainerized(Boolean(data.isContainerized))
        if (mcpResponse.ok) {
          const mcpData = await readJsonResponse<{ mcp?: McpRuntimeStatus }>(
            mcpResponse,
          )
          setMcpStatus(mcpData.mcp || null)
        }
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
  }, [loadAttemptKey])

  useEffect(() => {
    const syncExternalSettings = (event: Event) => {
      const detail = (event as CustomEvent<Partial<AppSettings>>).detail
      if (!detail) return
      setSettings((current) => (current ? { ...current, ...detail } : current))
    }

    window.addEventListener(SETTINGS_UPDATED_EVENT, syncExternalSettings)
    return () =>
      window.removeEventListener(SETTINGS_UPDATED_EVENT, syncExternalSettings)
  }, [])

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
    applyThemePreference(nextSettings.theme, nextSettings.themeStyle)

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
      applyThemePreference(data.settings.theme, data.settings.themeStyle)
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
      applyThemePreference(nextSettings.theme, nextSettings.themeStyle)
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

  // Read Google Drive when the tab opens and after a Drive job finishes, so
  // the stored backup's date and size stay current.
  const driveJobSettled =
    cloudBackupJob.status !== 'running' && restoreJob.status !== 'running'
  useEffect(() => {
    if (activeTab !== 'backup') return
    let cancelled = false
    getDriveBackupStatus()
      .then((status) => {
        if (!cancelled) setDriveStatus(status)
      })
      .catch(() => {
        // Keep the last known state; the next visit to this tab retries.
      })
    return () => {
      cancelled = true
    }
  }, [activeTab, driveJobSettled])

  const handleDriveConnect = async () => {
    setDriveAuthStatus('loading')
    setDriveAuthMessage('Opening Google sign-in...')
    try {
      setDriveStatus(await connectDriveBackup())
      setDriveAuthStatus('success')
      setDriveAuthMessage('Google Drive is connected.')
    } catch (error) {
      setDriveAuthStatus('error')
      setDriveAuthMessage(
        error instanceof Error ? error.message : 'Google sign-in failed.',
      )
    }
  }

  const handleDriveDisconnect = async () => {
    try {
      setDriveStatus(await disconnectDriveBackup())
      setDriveAuthStatus('idle')
      setDriveAuthMessage('')
    } catch (error) {
      setDriveAuthStatus('error')
      setDriveAuthMessage(
        error instanceof Error
          ? error.message
          : 'Could not disconnect Google Drive.',
      )
    }
  }

  const handleDriveRestore = async () => {
    if (
      !window.confirm(
        'Restore the backup from Google Drive and replace the local database on this device? You can keep browsing while editing is temporarily paused.',
      )
    ) {
      return
    }

    await startRestore()
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

  const handlePrintCollectionReport = () => {
    router.push('/insights?print=1')
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
      const createdAt = formatSyncTime(manifest.createdAt, settings?.timeFormat)
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

  const handleDriveAutoBackupToggle = async (checked: boolean) => {
    if (!settings) return

    try {
      await saveSettings({ driveAutoBackupEnabled: checked })
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

  const handleThemeStyleChange = async (themeStyle: ThemeStyle) => {
    if (!THEME_STYLES.includes(themeStyle)) return

    try {
      // The theme shell remounts this page; keep Appearance selected on return.
      const url = new URL(window.location.href)
      url.searchParams.set('tab', 'appearance')
      window.history.replaceState(null, '', url)
      await saveSettings({ themeStyle })
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : 'Failed to save settings',
      )
    }
  }

  const handleStartPageChange = async (value: string | null) => {
    if (!START_PAGES.includes(value as StartPage)) return

    try {
      await saveSettings({ startPage: value as StartPage })
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : 'Failed to save settings',
      )
    }
  }

  const handleTimeFormatChange = async (value: string | null) => {
    const timeFormat = value as TimeFormat
    if (!timeFormat || !TIME_FORMATS.includes(timeFormat)) return

    try {
      await saveSettings({ timeFormat })
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : 'Failed to save settings',
      )
    }
  }

  const handleDimensionUnitChange = async (value: string | null) => {
    if (!DIMENSION_UNITS.includes(value as DimensionUnit)) return

    try {
      await saveSettings({ dimensionUnit: value as DimensionUnit })
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

  const handlePinnedCardFieldToggle = async (
    field: CardField,
    checked: boolean,
  ) => {
    if (!settings) return

    const nextFields = checked
      ? [...settings.pinnedCardFields.filter((item) => item !== field), field]
      : settings.pinnedCardFields.filter((item) => item !== field)

    try {
      setIsSavingPinnedCardFields(true)
      await saveSettings({ pinnedCardFields: nextFields })
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : 'Failed to save settings',
      )
    } finally {
      setIsSavingPinnedCardFields(false)
    }
  }

  const handleCopyMcpConfig = async () => {
    if (!mcpClientConfig) return

    try {
      await copyTextToClipboard(mcpClientConfig)
      setCopiedMcpConfig(true)
      window.setTimeout(() => setCopiedMcpConfig(false), 1800)
    } catch {
      setLoadError('Could not copy the MCP configuration to the clipboard.')
    }
  }

  const handleCopyMcpToken = async () => {
    if (!mcpStatus?.http.authToken) return

    try {
      await copyTextToClipboard(mcpStatus.http.authToken)
      setCopiedMcpToken(true)
      window.setTimeout(() => setCopiedMcpToken(false), 1800)
    } catch {
      setLoadError('Could not copy the MCP token to the clipboard.')
    }
  }

  const updateMcpSettings = async (
    updates: { enabled?: boolean; writeEnabled?: boolean },
    successMessage: string,
  ) => {
    setMcpUpdateStatus('loading')
    setMcpUpdateMessage('Saving MCP settings...')
    try {
      const response = await fetch('/api/settings/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      const data = await readJsonResponse<{
        error?: string
        mcp?: McpRuntimeStatus
      }>(response)
      if (!response.ok || !data.mcp) {
        throw new Error(getApiErrorMessage(data, 'Failed to save MCP settings'))
      }

      setMcpStatus(data.mcp)
      setMcpUpdateStatus('success')
      setMcpUpdateMessage(successMessage)
    } catch (error) {
      setMcpUpdateStatus('error')
      setMcpUpdateMessage(
        error instanceof Error ? error.message : 'Failed to save MCP settings',
      )
    }
  }

  const handleMcpEnabledChange = (checked: boolean) =>
    updateMcpSettings(
      { enabled: checked },
      checked ? 'MCP access is enabled.' : 'MCP access is disabled.',
    )

  const handleMcpWriteEnabledChange = (checked: boolean) => {
    if (
      checked &&
      !window.confirm(
        'Allow connected AI clients to modify knife metadata? Every MCP change is audited, but approved tool calls will update your collection.',
      )
    ) {
      return
    }
    return updateMcpSettings(
      { writeEnabled: checked },
      checked ? 'MCP write access is enabled.' : 'MCP is now read-only.',
    )
  }

  const refreshMcpStatus = async () => {
    setMcpUpdateStatus('loading')
    setMcpUpdateMessage('Refreshing MCP activity...')
    try {
      const response = await fetch('/api/settings/mcp', {
        cache: 'no-store',
      })
      const data = await readJsonResponse<{
        error?: string
        mcp?: McpRuntimeStatus
      }>(response)
      if (!response.ok || !data.mcp) {
        throw new Error(
          getApiErrorMessage(data, 'Failed to refresh MCP activity'),
        )
      }
      setMcpStatus(data.mcp)
      setMcpUpdateStatus('idle')
      setMcpUpdateMessage('')
    } catch (error) {
      setMcpUpdateStatus('error')
      setMcpUpdateMessage(
        error instanceof Error
          ? error.message
          : 'Failed to refresh MCP activity',
      )
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
    if (!settings) return false

    const nextCustomFields = updater(settings.customFields)
    if (
      JSON.stringify(nextCustomFields) === JSON.stringify(settings.customFields)
    ) {
      return true
    }

    const customFieldIds = new Set(nextCustomFields.map((field) => field.id))
    const isManagedCustomField = (field: CardField) =>
      field.startsWith('custom:') &&
      customFieldIds.has(field.slice('custom:'.length))
    const nextCardFields = settings.cardFields.filter(
      (field) => !field.startsWith('custom:') || isManagedCustomField(field),
    )
    const nextPinnedCardFields = settings.pinnedCardFields.filter(
      (field) => !field.startsWith('custom:') || isManagedCustomField(field),
    )

    try {
      await saveSettings({
        customFields: nextCustomFields,
        cardFields: nextCardFields,
        pinnedCardFields: nextPinnedCardFields,
      })
      setLoadError(null)
      return true
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to save settings'
      setLoadError(message)
      setFieldDeleteError(message)
      return false
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
              className={`${settingsPrimaryButtonClassName} rounded-lg`}
              onClick={() => setLoadAttemptKey((current) => current + 1)}
            >
              Retry
            </Button>
          </div>
        </div>
      ) : (
        <div className="settings-surface flex h-full min-h-0 w-full flex-col xl:flex-row xl:gap-8">
          {/* Sidebar */}
          <aside className="flex w-full shrink-0 border-b border-border xl:w-52 xl:flex-col xl:border-b-0">
            <nav
              data-settings-rail
              className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto py-2 xl:min-h-0 xl:flex-col xl:overflow-x-hidden xl:overflow-y-auto xl:py-0"
            >
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
                        ? 'bg-[var(--bladevault-nav-active-bg)] font-medium text-[var(--bladevault-nav-active-fg)]'
                        : 'text-muted-foreground hover:bg-[var(--bladevault-surface-hover)] hover:text-foreground',
                    )}
                  >
                    <tab.icon className="h-4 w-4 shrink-0" />
                    <span className="flex-1">{tab.label}</span>
                  </button>
                )
              })}
            </nav>
          </aside>

          {/* Main content */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="settings-content min-h-0 flex-1 overflow-y-auto px-0.5 pt-5 pb-6 xl:pt-0">
              <div className="settings-head">
                <h2>{activeTabMeta.label}</h2>
                <p>{activeTabMeta.blurb}</p>
              </div>
              {activeTab === 'app-lock' && <AppLockSettings />}
              {activeTab === 'general' && (
                <div className="settings-grid">
                  <SettingsSection title="Vault folder">
                    <SettingsRow
                      label="Data folder"
                      description={
                        <MonoValue>{localDataPath || 'Unavailable'}</MonoValue>
                      }
                    >
                      <Button
                        type="button"
                        variant="outline"
                        className={`${settingsSecondaryButtonClassName} rounded-lg`}
                        aria-expanded={showDataFolderForm}
                        onClick={() => {
                          setIsChangingDataFolder(!showDataFolderForm)
                          setPendingLocalDataPath(localDataPath)
                          setLocalDataStatus('idle')
                          setLocalDataMessage('')
                        }}
                        disabled={
                          dataDirManagedByEnv || localDataStatus === 'loading'
                        }
                      >
                        {showDataFolderForm ? 'Cancel' : 'Change…'}
                      </Button>
                    </SettingsRow>

                    {showDataFolderForm ? (
                      <div className="settings-reveal">
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <Input
                            aria-label="Change local data folder"
                            value={pendingLocalDataPath}
                            onChange={(event) => {
                              setPendingLocalDataPath(event.target.value)
                              setLocalDataStatus('idle')
                              setLocalDataMessage('')
                            }}
                            placeholder={
                              defaultLocalDataPath ||
                              '/Users/you/BladeVault/data'
                            }
                            disabled={dataDirManagedByEnv}
                            className="h-8 min-w-0 flex-1 rounded-lg border-border bg-background font-mono text-xs shadow-none dark:border-input"
                          />
                          {canChooseLocalDataFolder ? (
                            <Button
                              type="button"
                              variant="outline"
                              className={`${settingsSecondaryButtonClassName} rounded-lg`}
                              onClick={handleChooseLocalDataFolder}
                              disabled={dataDirManagedByEnv}
                            >
                              <FolderOpen className="h-3.5 w-3.5" />
                              Choose
                            </Button>
                          ) : null}
                        </div>
                        <div className="flex items-center justify-between gap-4">
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-foreground">
                              Move existing data
                            </div>
                            <div className="text-xs text-muted-foreground">
                              Copy your current vault into the new folder.
                            </div>
                          </div>
                          <SettingsSwitch
                            checked={moveExistingLocalData}
                            onCheckedChange={setMoveExistingLocalData}
                            disabled={dataDirManagedByEnv}
                            aria-label="Move existing local data"
                          />
                        </div>
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <StatusPill
                            status={localDataStatus}
                            message={localDataMessage}
                          />
                          <Button
                            type="button"
                            className={`${settingsPrimaryButtonClassName} rounded-lg sm:ml-auto`}
                            onClick={handleSaveLocalDataFolder}
                            disabled={
                              dataDirManagedByEnv ||
                              backupStatus === 'loading' ||
                              localDataStatus === 'loading' ||
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
                      </div>
                    ) : null}

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
                      />
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
                  </SettingsSection>
                  <ScreenshotBackfill />
                </div>
              )}

              {activeTab === 'backup' && (
                <div className="settings-grid">
                  {!driveStatus ? (
                    <SettingsSection title="Google Drive">
                      <div className="py-3">
                        <StatusPill
                          status="loading"
                          message="Checking Google Drive…"
                          quiet
                        />
                      </div>
                    </SettingsSection>
                  ) : null}

                  {driveStatus && !driveStatus.available ? (
                    <SettingsSection title="Google Drive">
                      <SettingsRow
                        label="Not available here"
                        description="Google Drive backup needs the desktop app or a self-hosted server. Use Local backup below for a portable ZIP."
                      />
                    </SettingsSection>
                  ) : null}

                  {driveStatus?.available ? (
                    <SettingsSection
                      title="Google Drive"
                      description="Keep one backup file in your own Google Drive. BladeVault can only see the files it creates there."
                    >
                      {driveStatus.connected ? (
                        <>
                          <SettingsRow
                            label="Google Drive connected"
                            description={
                              driveStatus.file
                                ? `Backup in Drive: ${[
                                    formatSyncTime(
                                      driveStatus.file.modifiedTime,
                                      settings.timeFormat,
                                    ),
                                    formatBackupSize(driveStatus.file.size),
                                  ]
                                    .filter(Boolean)
                                    .join(' · ')}`
                                : driveStatus.message ||
                                  'No backup in Drive yet.'
                            }
                          >
                            <Button
                              variant="outline"
                              className={`${settingsSecondaryButtonClassName} rounded-lg`}
                              onClick={handleDriveDisconnect}
                              disabled={
                                backupStatus === 'loading' ||
                                restoreStatus === 'loading'
                              }
                            >
                              <LogOut className="h-3.5 w-3.5" />
                              Disconnect
                            </Button>
                          </SettingsRow>

                          <SettingsRow
                            label="Back up to Google Drive"
                            description="Replaces the backup file in your Drive."
                          >
                            <Button
                              variant="outline"
                              className={`${settingsSecondaryButtonClassName} rounded-lg`}
                              onClick={() => void startVaultBackup()}
                              disabled={
                                isVaultReadOnly ||
                                backupStatus === 'loading' ||
                                restoreStatus === 'loading' ||
                                localBackupStatus === 'loading'
                              }
                            >
                              <Upload className="h-3.5 w-3.5" />
                              Backup
                            </Button>
                          </SettingsRow>

                          <SettingsRow
                            inline
                            label="Automatic backup to Google Drive"
                            description="Back up to Drive quietly after edits settle, without notifications."
                          >
                            <SettingsSwitch
                              checked={settings.driveAutoBackupEnabled}
                              onCheckedChange={handleDriveAutoBackupToggle}
                              disabled={isVaultReadOnly}
                              aria-label="Enable automatic backup to Google Drive"
                            />
                          </SettingsRow>

                          <SettingsRow
                            label="Restore from Google Drive"
                            description="Replaces the local data on this device."
                          >
                            <Button
                              variant="outline"
                              className={`${settingsSecondaryButtonClassName} rounded-lg`}
                              onClick={handleDriveRestore}
                              disabled={
                                !driveStatus.file ||
                                isVaultReadOnly ||
                                restoreStatus === 'loading' ||
                                backupStatus === 'loading'
                              }
                            >
                              {driveRestorePillStatus === 'loading' ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Download className="h-3.5 w-3.5" />
                              )}
                              Restore
                            </Button>
                          </SettingsRow>
                        </>
                      ) : (
                        <SettingsRow
                          label="Not connected"
                          description={
                            driveStatus.message ||
                            'Sign in with Google to store a backup in your Drive.'
                          }
                        >
                          <Button
                            className={`${settingsPrimaryButtonClassName} rounded-lg`}
                            onClick={handleDriveConnect}
                            disabled={driveAuthStatus === 'loading'}
                          >
                            <FcGoogle className="h-4 w-4" />
                            Connect Google Drive
                          </Button>
                        </SettingsRow>
                      )}

                      {driveAuthStatus !== 'idle' &&
                      !(
                        driveAuthStatus === 'success' &&
                        (driveBackupPillStatus !== 'idle' ||
                          driveRestorePillStatus !== 'idle')
                      ) ? (
                        <div className="py-3">
                          <StatusPill
                            status={driveAuthStatus}
                            message={driveAuthMessage}
                          />
                        </div>
                      ) : null}

                      {driveBackupPillStatus !== 'idle' ? (
                        <div className="py-3">
                          <StatusPill
                            status={driveBackupPillStatus}
                            message={driveBackupMessage}
                            quiet
                          />
                        </div>
                      ) : null}

                      {driveRestorePillStatus !== 'idle' ? (
                        <div className="py-3">
                          <StatusPill
                            status={driveRestorePillStatus}
                            message={driveRestoreMessage}
                            quiet
                          />
                        </div>
                      ) : null}
                    </SettingsSection>
                  ) : null}

                  <SettingsSection
                    title="Local backup"
                    description="Portable ZIPs you own. No cloud account is required."
                  >
                    <SettingsRow label="Download full backup">
                      <Button
                        variant="outline"
                        className={`${settingsSecondaryButtonClassName} rounded-lg`}
                        onClick={handleLocalBackupDownload}
                        disabled={
                          localBackupStatus === 'loading' ||
                          backupStatus === 'loading'
                        }
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
                        className={`${settingsSecondaryButtonClassName} rounded-lg`}
                        onClick={() => localRestoreInputRef.current?.click()}
                        disabled={
                          localBackupStatus === 'loading' ||
                          backupStatus === 'loading'
                        }
                      >
                        <Upload className="h-3.5 w-3.5" />
                        Choose ZIP
                      </Button>
                    </SettingsRow>

                    {localBackupStatus !== 'idle' ? (
                      <div className="py-3">
                        <StatusPill
                          status={localBackupStatus}
                          message={localBackupMessage}
                        />
                      </div>
                    ) : null}
                  </SettingsSection>
                </div>
              )}

              {activeTab === 'appearance' && (
                <div className="settings-grid">
                  <SettingsSection title="Theme">
                    <SettingsRow label="Style" className="settings-theme-row">
                      <div
                        className="theme-style-options"
                        role="radiogroup"
                        aria-label="Theme"
                      >
                        {THEME_STYLES.map((themeStyle) => {
                          const isActive = settings.themeStyle === themeStyle
                          const labels = themeStyleLabels[themeStyle]

                          return (
                            <button
                              key={themeStyle}
                              type="button"
                              role="radio"
                              aria-checked={isActive}
                              onClick={() =>
                                void handleThemeStyleChange(themeStyle)
                              }
                              className={cn(
                                'theme-style-option',
                                isActive && 'is-active',
                              )}
                            >
                              <span
                                aria-hidden="true"
                                className={cn(
                                  'theme-style-swatch',
                                  `is-${themeStyle}`,
                                )}
                              >
                                <span className="theme-style-swatch-rail" />
                                <span className="theme-style-swatch-body">
                                  <span className="theme-style-swatch-title" />
                                  <span className="theme-style-swatch-line" />
                                  <span className="theme-style-swatch-line is-short" />
                                  <span className="theme-style-swatch-card" />
                                </span>
                              </span>
                              <span className="theme-style-meta">
                                <span className="theme-style-name">
                                  {labels.name}
                                </span>
                                <span className="theme-style-note">
                                  {labels.note}
                                </span>
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </SettingsRow>
                    <SettingsRow
                      label="Color mode"
                      description={
                        hasFixedColorMode(settings.themeStyle)
                          ? `${themeStyleLabels[settings.themeStyle].name} has one color mode.`
                          : undefined
                      }
                    >
                      <SegmentedControl
                        aria-label="Color mode"
                        value={settings.theme}
                        options={colorModeOptions}
                        onValueChange={handleThemeChange}
                        disabled={hasFixedColorMode(settings.themeStyle)}
                      />
                    </SettingsRow>
                  </SettingsSection>
                  <SettingsSection title="Preferences">
                    <SettingsRow
                      label="Start page"
                      description="Opens when you launch BladeVault."
                    >
                      <SegmentedControl
                        aria-label="Start page"
                        value={settings.startPage ?? DEFAULT_SETTINGS.startPage}
                        options={startPageOptions}
                        onValueChange={handleStartPageChange}
                      />
                    </SettingsRow>
                    <SettingsRow
                      label="Measurement units"
                      description="Metric (mm, g), imperial (in, oz), or both, for measurements, Add/Edit fields and Insights charts."
                    >
                      <SegmentedControl
                        aria-label="Measurement units"
                        value={
                          settings.dimensionUnit ??
                          DEFAULT_SETTINGS.dimensionUnit
                        }
                        options={dimensionUnitOptions}
                        onValueChange={handleDimensionUnitChange}
                      />
                    </SettingsRow>
                    <SettingsRow label="Time format">
                      <SegmentedControl
                        aria-label="Time format"
                        value={settings.timeFormat}
                        options={timeFormatOptions}
                        onValueChange={handleTimeFormatChange}
                      />
                    </SettingsRow>
                    <SettingsRow
                      inline
                      label="Keep pinned knives first"
                      description="In the Dashboard, Collection and Compare views."
                    >
                      <SettingsSwitch
                        aria-label="Keep pinned knives first"
                        checked={settings.pinnedItemsFirst}
                        onCheckedChange={handlePinnedItemsFirstToggle}
                      />
                    </SettingsRow>
                  </SettingsSection>
                  <SettingsSection
                    title="Card fields"
                    description="Choose any structured or custom details to show on knife cards."
                    className="settings-card-fields"
                  >
                    <div className="settings-card-fields-layout grid items-start gap-4 py-4">
                      <CardFieldsPreview
                        fields={settings.cardFields}
                        customFields={settings.customFields}
                        dimensionUnit={settings.dimensionUnit}
                      />
                      <CardFieldOptions
                        fields={settings.cardFields}
                        customFields={settings.customFields}
                        lockedRows={[
                          { label: 'Brand and model', note: 'Always shown' },
                        ]}
                        disabled={isSavingCardFields}
                        onToggle={(field, checked) =>
                          void handleCardFieldToggle(field, checked)
                        }
                      />
                    </div>
                  </SettingsSection>
                  <SettingsSection
                    title="Pinned item fields"
                    description="Choose any structured or custom details to show under pinned knives in the sidebar. Steel and blade length are selected by default."
                    className="settings-pinned-card-fields"
                  >
                    <div className="settings-card-fields-layout grid items-start gap-4 py-4">
                      <PinnedItemFieldsPreview
                        fields={settings.pinnedCardFields}
                        dimensionUnit={settings.dimensionUnit}
                      />
                      <CardFieldOptions
                        fields={settings.pinnedCardFields}
                        customFields={settings.customFields}
                        lockedRows={[
                          { label: 'Brand and name', note: 'Always shown' },
                        ]}
                        disabled={isSavingPinnedCardFields}
                        onToggle={(field, checked) =>
                          void handlePinnedCardFieldToggle(field, checked)
                        }
                        ariaLabelSuffix="pinned items"
                      />
                    </div>
                  </SettingsSection>
                </div>
              )}

              {activeTab === 'fields' && (
                <div className="settings-grid">
                  <SettingsSection description="Define extra fields that apply to every knife. They appear in the add/edit form and as collection filters.">
                    {settings.customFields.length === 0 ? (
                      <div className="py-3 text-sm text-muted-foreground">
                        No custom fields yet. Add one below to use it across
                        your library.
                      </div>
                    ) : (
                      <div className="divide-y divide-[var(--border)]/60">
                        {settings.customFields.map((field, index) => (
                          <div
                            key={field.id}
                            className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center"
                          >
                            <Input
                              aria-label={`Name for ${field.name} field`}
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
                              className="h-8 flex-1 rounded-lg border-border bg-background text-sm shadow-none dark:border-input"
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
                                aria-label={`Type for ${field.name} field`}
                                size="sm"
                                className="h-8 w-full rounded-lg border-border bg-[var(--bladevault-surface-soft)] sm:w-28"
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
                              onClick={() => {
                                setFieldDeleteError('')
                                setFieldToDelete(field)
                              }}
                              aria-label={`Delete ${field.name} field`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="border-t border-border/60 py-3">
                      <div className="mb-2 text-xs text-muted-foreground">
                        Add a field to show on every knife.
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <Input
                          aria-label="New field name"
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
                          className="h-8 flex-1 rounded-lg border-border bg-background text-sm shadow-none dark:border-input"
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
                            aria-label="New field type"
                            size="sm"
                            className="h-8 w-full rounded-lg border-border bg-[var(--bladevault-surface-soft)] sm:w-28"
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
                          className={`${settingsPrimaryButtonClassName} rounded-lg sm:self-auto`}
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

              {activeTab === 'mcp' && (
                <div className="settings-grid">
                  {mcpUpdateStatus !== 'idle' ? (
                    <div className="flex justify-end">
                      <StatusPill
                        status={mcpUpdateStatus}
                        message={mcpUpdateMessage}
                      />
                    </div>
                  ) : null}

                  <SettingsSection title="Access">
                    <SettingsRow
                      inline
                      label="Enabled"
                      description={
                        mcpStatus?.controls.enabledManagedByEnvironment
                          ? 'Managed by MCP_ENABLED.'
                          : undefined
                      }
                    >
                      <SettingsSwitch
                        checked={mcpStatus?.enabled || false}
                        onCheckedChange={(checked) =>
                          void handleMcpEnabledChange(checked)
                        }
                        disabled={
                          !mcpStatus ||
                          mcpUpdateStatus === 'loading' ||
                          mcpStatus.controls.enabledManagedByEnvironment
                        }
                        aria-label="Enable MCP access"
                      />
                    </SettingsRow>
                    <SettingsRow
                      inline
                      label="Write access"
                      description={
                        mcpStatus?.controls.writeEnabledManagedByEnvironment
                          ? 'Managed by MCP_WRITE_ENABLED.'
                          : 'Read-only when off. Writes are audited.'
                      }
                    >
                      <SettingsSwitch
                        checked={mcpStatus?.writeEnabled || false}
                        onCheckedChange={(checked) =>
                          void handleMcpWriteEnabledChange(checked)
                        }
                        disabled={
                          !mcpStatus?.enabled ||
                          mcpUpdateStatus === 'loading' ||
                          mcpStatus.controls.writeEnabledManagedByEnvironment
                        }
                        aria-label="Allow MCP to modify knives"
                      />
                    </SettingsRow>
                    <SettingsRow
                      label="Token"
                      description={
                        mcpStatus?.http.authManagedByEnvironment
                          ? 'Managed by MCP_AUTH_TOKEN.'
                          : 'Stored with your vault data.'
                      }
                    >
                      <div className="flex max-w-full items-center gap-2 text-right">
                        <MonoValue>
                          {mcpStatus?.http.authToken || 'Unavailable'}
                        </MonoValue>
                        <Button
                          type="button"
                          variant="outline"
                          className={`${settingsSecondaryButtonClassName} rounded-lg`}
                          onClick={() => void handleCopyMcpToken()}
                          disabled={!mcpStatus}
                        >
                          <Copy className="h-3.5 w-3.5" />
                          {copiedMcpToken ? 'Copied' : 'Copy token'}
                        </Button>
                      </div>
                    </SettingsRow>
                    <div className="space-y-2 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-medium text-foreground">
                          Config
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          className={`${settingsSecondaryButtonClassName} rounded-lg`}
                          onClick={() => void handleCopyMcpConfig()}
                          disabled={!mcpClientConfig}
                        >
                          <Copy className="h-3.5 w-3.5" />
                          {copiedMcpConfig ? 'Copied' : 'Copy config'}
                        </Button>
                      </div>
                      <pre className="max-h-64 overflow-auto rounded-lg border border-border bg-[var(--bladevault-surface-soft)] p-3 text-xs text-foreground dark:border-input">
                        <code>
                          {mcpClientConfig || 'Loading configuration…'}
                        </code>
                      </pre>
                    </div>
                  </SettingsSection>

                  <SettingsSection
                    title={
                      <div className="flex items-center justify-between gap-3">
                        <span>Activity</span>
                        <Button
                          type="button"
                          variant="ghost"
                          className="rounded-lg px-2 text-xs"
                          onClick={() => void refreshMcpStatus()}
                          disabled={mcpUpdateStatus === 'loading'}
                        >
                          <RefreshCw
                            className={cn(
                              'h-3.5 w-3.5',
                              mcpUpdateStatus === 'loading' && 'animate-spin',
                            )}
                          />
                          Refresh
                        </Button>
                      </div>
                    }
                  >
                    <SettingsRow label="Collection">
                      <span className="text-xs text-muted-foreground">
                        {mcpStatus?.stats.knifeCount ?? 0} knives
                      </span>
                    </SettingsRow>
                    <SettingsRow label="Tools">
                      <span className="text-xs text-muted-foreground">
                        {mcpStatus?.tools.read ?? 6} read ·{' '}
                        {mcpStatus?.tools.write ?? 2} write ·{' '}
                        {mcpStatus?.activity.toolCallsSinceStart ?? 0} calls
                      </span>
                    </SettingsRow>
                    <SettingsRow label="Last activity">
                      <span className="text-xs text-muted-foreground">
                        {mcpStatus?.activity.lastTransport
                          ? `${mcpStatus.activity.lastTransport.toUpperCase()} · ${formatSyncTime(
                              mcpStatus.activity.lastActivityAt || '',
                              settings.timeFormat,
                            )}`
                          : 'Never'}
                      </span>
                    </SettingsRow>
                    <SettingsRow label="MCP changes">
                      <span className="text-xs text-muted-foreground">
                        {mcpStatus?.stats.writeOperationCount ?? 0} operations ·{' '}
                        {mcpStatus?.stats.changedKnifeCount ?? 0} knives ·{' '}
                        {formatSyncTime(
                          mcpStatus?.stats.lastWriteAt || '',
                          settings.timeFormat,
                        )}
                      </span>
                    </SettingsRow>
                  </SettingsSection>
                </div>
              )}

              {activeTab === 'about' && (
                <div className="settings-grid">
                  <SettingsSection title="BladeVault">
                    <SettingsRow label="Version" description={pkg.version}>
                      {isDesktop && (
                        <Button
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
                          ) : (
                            <RefreshCw />
                          )}
                          {update.status === 'available'
                            ? 'Download update'
                            : update.status === 'downloaded' && !update.path
                              ? 'Restart to update'
                              : 'Check for updates'}
                        </Button>
                      )}
                    </SettingsRow>
                    <SettingsRow label="Update status">
                      {isDesktop ? (
                        updateTone === 'idle' ? (
                          <span className="text-xs text-muted-foreground">
                            {update.status === 'available'
                              ? 'A new version is available.'
                              : 'Ready to check for updates.'}
                          </span>
                        ) : (
                          <StatusPill
                            status={updateTone}
                            message={updateMessage}
                          />
                        )
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Automatic updates are available in the desktop app.
                        </span>
                      )}
                    </SettingsRow>
                    <SettingsRow
                      label="Repository"
                      description={pkg.repository?.url}
                    >
                      <a
                        href={pkg.repository?.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-8 items-center rounded-lg border border-border bg-[var(--bladevault-surface-soft)] px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-[var(--bladevault-surface-hover)]"
                      >
                        View on GitHub
                      </a>
                    </SettingsRow>
                    <SettingsRow label="License" description="MIT" />
                  </SettingsSection>
                  <SettingsSection title="Print">
                    <SettingsRow
                      label="Collection report"
                      description="Use your system print dialog to print it or save it as a PDF."
                    >
                      <Button
                        variant="outline"
                        className={`${settingsSecondaryButtonClassName} rounded-lg`}
                        onClick={handlePrintCollectionReport}
                        disabled={knives.length === 0}
                      >
                        <Printer className="h-3.5 w-3.5" />
                        Print Report
                      </Button>
                    </SettingsRow>
                  </SettingsSection>
                  {isDesktop ? (
                    <DesktopErrorReportingSettings />
                  ) : (
                    <ServerErrorReportingSettings />
                  )}
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
      <Dialog
        open={Boolean(fieldToDelete)}
        onOpenChange={(open) => {
          if (!open && !deletingFieldRef.current) setFieldToDelete(null)
        }}
      >
        <DialogContent
          showCloseButton={!deletingField}
          initialFocus={() => document.getElementById('cancel-field-delete')}
        >
          <DialogHeader>
            <DialogTitle>Delete {fieldToDelete?.name} field?</DialogTitle>
            <DialogDescription>
              This removes the field from every knife’s forms, details, and card
              options. Existing values remain stored in the vault but will no
              longer be shown.
            </DialogDescription>
          </DialogHeader>
          {fieldDeleteError && (
            <p role="alert" className="text-sm text-destructive">
              {fieldDeleteError}
            </p>
          )}
          <DialogFooter>
            <Button
              id="cancel-field-delete"
              variant="outline"
              disabled={deletingField}
              onClick={() => setFieldToDelete(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deletingField || isVaultReadOnly}
              onClick={async () => {
                if (!fieldToDelete || deletingFieldRef.current) return
                deletingFieldRef.current = true
                setFieldDeleteError('')
                setDeletingField(true)
                try {
                  const saved = await handleUpdateCustomFields((fields) =>
                    fields.filter((field) => field.id !== fieldToDelete.id),
                  )
                  if (saved) setFieldToDelete(null)
                } finally {
                  deletingFieldRef.current = false
                  setDeletingField(false)
                }
              }}
            >
              {deletingField ? 'Deleting…' : 'Delete field'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
