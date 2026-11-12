import { requireAppUnlock } from '@/lib/app-lock'
import {
  getCloudRestoreJobState,
  startCloudRestoreJob,
} from '@/lib/cloud-restore-job'
import {
  getVaultAccessState,
  vaultAccessErrorResponse,
  VAULT_GENERATION_HEADER,
} from '@/lib/vault-access'
import { VaultOperationBusyError } from '@/lib/vault-operation'
import { isDriveConnected } from '@/lib/drive-backup'
import { reportServerError } from '@/lib/sentry/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  return Response.json(
    { job: getCloudRestoreJobState() },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function POST(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  const generation =
    request.headers.get(VAULT_GENERATION_HEADER) ??
    getVaultAccessState().generation
  // Restores come from the user's Google Drive, the only cloud source.
  if (!(await isDriveConnected()))
    return Response.json(
      { error: 'Connect Google Drive before restoring a backup.' },
      { status: 400 },
    )
  try {
    return Response.json(startCloudRestoreJob(generation), {
      status: 202,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    const busy = vaultAccessErrorResponse(error)
    if (busy) return busy
    if (error instanceof VaultOperationBusyError)
      return Response.json({ error: error.message }, { status: 409 })
    reportServerError(error, '/api/cloud-backup/restore-job')
    return Response.json(
      { error: 'Could not start cloud restore. Please try again.' },
      { status: 500 },
    )
  }
}
