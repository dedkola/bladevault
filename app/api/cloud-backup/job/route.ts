import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { VaultOperationBusyError } from '@/lib/vault-operation'
import {
  getCloudBackupJobState,
  startCloudBackupJob,
} from '@/lib/cloud-backup-job'

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

  let body: { sessionToken?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }
  const sessionToken =
    typeof body?.sessionToken === 'string' ? body.sessionToken.trim() : ''
  if (!sessionToken || sessionToken.length > 16_384) {
    return NextResponse.json(
      { error: 'sessionToken is required.' },
      { status: 400 },
    )
  }

  try {
    const started = getCloudBackupJobState().status !== 'running'
    return NextResponse.json(
      { job: startCloudBackupJob(sessionToken), started },
      { status: 202, headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    if (error instanceof VaultOperationBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    return NextResponse.json(
      { error: 'Could not start background backup. Please try again.' },
      { status: 500 },
    )
  }
}
