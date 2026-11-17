'use client'

import { useEffect, useState } from 'react'
import { CloudDownload, CloudUpload } from 'lucide-react'
import { useKnives } from '@/components/providers/knives-provider'
import { useVaultRestore } from '@/components/providers/vault-restore-provider'

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

export function VaultTaskNotice({
  icon,
  message,
  percent,
}: {
  icon: 'download' | 'upload'
  message: string
  percent: number | null
}) {
  const Icon = icon === 'download' ? CloudDownload : CloudUpload
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 z-40 w-[min(30rem,calc(100%-2rem))] -translate-x-1/2 rounded-lg border bg-background px-3 py-2 text-xs text-muted-foreground shadow-sm"
    >
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">{message}</span>
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

export function BackupProgressNotice() {
  const { cloudBackupJob } = useKnives()
  const { readOnly } = useVaultRestore()
  if (cloudBackupJob.status !== 'running' || readOnly) return null
  return <BackupProgressBar uploading={cloudBackupJob.phase === 'uploading'} />
}
