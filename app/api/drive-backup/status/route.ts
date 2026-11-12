import { requireAppUnlock } from '@/lib/app-lock'
import { getDriveBackupStatus } from '@/lib/drive-backup'
import { reportServerError } from '@/lib/sentry/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    return Response.json(await getDriveBackupStatus(), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    reportServerError(error, '/api/drive-backup/status')
    return Response.json(
      { error: 'Could not read Google Drive backup status.' },
      { status: 500 },
    )
  }
}
