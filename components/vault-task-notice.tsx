'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import {
  CloudAlert,
  CloudCheck,
  CloudDownload,
  CloudUpload,
} from 'lucide-react'
import { useKnives } from '@/components/providers/knives-provider'
import { useVaultRestore } from '@/components/providers/vault-restore-provider'
import { cn } from '@/lib/utils'

// Backup and restore report phases, not byte counts, so the bar eases toward
// the end of the current phase and never claims to be finished before it is.
export function useEstimatedProgress(
  active: boolean,
  floor: number,
  ceiling: number,
) {
  const [value, setValue] = useState(floor)
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => {
      setValue((current) => {
        const base = Math.max(current, floor)
        return base + (ceiling - base) * 0.06
      })
    }, 600)
    return () => window.clearInterval(timer)
  }, [active, floor, ceiling])
  return Math.min(Math.round(Math.max(value, floor)), 99)
}

const NOTICE_ICONS = {
  download: CloudDownload,
  upload: CloudUpload,
  success: CloudCheck,
  error: CloudAlert,
} as const

export function VaultTaskNotice({
  icon,
  message,
  percent,
  action,
}: {
  icon: keyof typeof NOTICE_ICONS
  message: string
  percent: number | null
  action?: React.ReactNode
}) {
  const Icon = NOTICE_ICONS[icon]
  return (
    <div
      role="status"
      aria-live="polite"
      data-vault-task-notice={icon}
      className="fixed bottom-4 left-1/2 z-40 w-[min(30rem,calc(100%-2rem))] -translate-x-1/2 rounded-lg border bg-background px-3 py-2 text-xs text-muted-foreground shadow-sm"
    >
      <div className="flex items-center gap-2">
        <Icon
          className={cn(
            'size-4 shrink-0',
            icon === 'success' && 'text-emerald-600 dark:text-emerald-400',
            icon === 'error' && 'text-red-600 dark:text-red-400',
          )}
        />
        <span className="min-w-0 flex-1">{message}</span>
        {action}
        {percent !== null ? (
          <span className="shrink-0 tabular-nums">{percent}%</span>
        ) : null}
      </div>
      {percent !== null ? (
        <div
          role="progressbar"
          aria-label={message}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="mt-2 h-1 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-foreground/60 transition-[width] duration-500 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}
    </div>
  )
}

export function RestoreProgressNotice({ message }: { message: string }) {
  const { job } = useVaultRestore()
  const [floor, ceiling] =
    job.phase === 'applying'
      ? [85, 97]
      : job.phase === 'validating'
        ? [65, 85]
        : [3, 65]
  const percent = useEstimatedProgress(true, floor, ceiling)
  return <VaultTaskNotice icon="download" message={message} percent={percent} />
}

function BackupProgressBar({ uploading }: { uploading: boolean }) {
  const percent = useEstimatedProgress(
    true,
    uploading ? 45 : 3,
    uploading ? 97 : 45,
  )
  return (
    <VaultTaskNotice
      icon="upload"
      message={
        uploading
          ? 'Uploading backup to Google Drive. You can keep working.'
          : 'Preparing Google Drive backup. You can keep working.'
      }
      percent={percent}
    />
  )
}

const BACKUP_RESULT_MS = { success: 4_000, error: 10_000 } as const

type BackupResult = {
  status: 'success' | 'error'
  message: string | null
  /** Only a job the server ran records its failure in the Inbox. */
  recorded: boolean
}

function backupFailureText(message: string | null): string {
  const detail = message?.trim().replace(/\.$/, '')
  return detail && !/backup failed/i.test(detail)
    ? `Google Drive backup failed: ${detail}.`
    : 'Google Drive backup failed.'
}

/**
 * The bottom notice for Google Drive backups. While a backup runs it shows
 * the phase; when it ends it briefly says whether it worked, so the bar never
 * just vanishes. Failures are also kept in the Inbox.
 */
export function BackupProgressNotice() {
  const { cloudBackupJob } = useKnives()
  const { readOnly } = useVaultRestore()
  const [result, setResult] = useState<BackupResult | null>(null)
  const [previousStatus, setPreviousStatus] = useState(cloudBackupJob.status)

  // Note the moment a running backup ends, during render rather than in an
  // effect, so the result replaces the progress bar without a blank frame.
  if (previousStatus !== cloudBackupJob.status) {
    setPreviousStatus(cloudBackupJob.status)
    if (cloudBackupJob.status === 'running') {
      setResult(null)
    } else if (
      previousStatus === 'running' &&
      (cloudBackupJob.status === 'success' || cloudBackupJob.status === 'error')
    ) {
      setResult({
        status: cloudBackupJob.status,
        message: cloudBackupJob.message,
        recorded: cloudBackupJob.id !== null,
      })
    }
  }

  useEffect(() => {
    if (!result) return
    const timer = window.setTimeout(
      () => setResult(null),
      BACKUP_RESULT_MS[result.status],
    )
    return () => window.clearTimeout(timer)
  }, [result])

  if (readOnly) return null
  if (cloudBackupJob.status === 'running') {
    return (
      <BackupProgressBar uploading={cloudBackupJob.phase === 'uploading'} />
    )
  }
  if (result?.status === 'success') {
    return (
      <VaultTaskNotice
        icon="success"
        message="Backed up to Google Drive."
        percent={null}
      />
    )
  }
  if (result?.status === 'error') {
    return (
      <VaultTaskNotice
        icon="error"
        message={backupFailureText(result.message)}
        percent={null}
        action={
          result.recorded ? (
            <Link
              href="/inbox?filter=system"
              onClick={() => setResult(null)}
              className="shrink-0 font-medium text-foreground underline underline-offset-2"
            >
              Details
            </Link>
          ) : null
        }
      />
    )
  }
  return null
}
