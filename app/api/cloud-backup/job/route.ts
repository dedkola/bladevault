import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { VaultOperationBusyError } from '@/lib/vault-operation'
import {
  getCloudBackupJobState,
  startCloudBackupJob,
} from '@/lib/cloud-backup-job'
import { isDriveConnected } from '@/lib/drive-backup'
import { reportServerError } from '@/lib/sentry/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  return NextResponse.json(
    { job: getCloudBackupJobState() },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function POST(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked

  // Backups go to the user's Google Drive, the only cloud destination.
  if (!(await isDriveConnected())) {
    return NextResponse.json(
      { error: 'Connect Google Drive before starting a backup.' },
      { status: 400 },
    )
  }

  try {
    const started = getCloudBackupJobState().status !== 'running'
    return NextResponse.json(
      { job: startCloudBackupJob(), started },
      { status: 202, headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    if (error instanceof VaultOperationBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    reportServerError(error, '/api/cloud-backup/job')
    return NextResponse.json(
      { error: 'Could not start background backup. Please try again.' },
      { status: 500 },
    )
  }
}
