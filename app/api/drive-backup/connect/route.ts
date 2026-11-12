import { requireAppUnlock } from '@/lib/app-lock'
import {
  beginDriveConnect,
  completeDriveConnect,
  disconnectDrive,
  getDriveBackupStatus,
} from '@/lib/drive-backup'
import { reportServerError } from '@/lib/sentry/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const noStore = { 'Cache-Control': 'no-store' }

function parseOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

// Step 1 returns the Google sign-in address; step 2 trades the returned code
// for Drive access. The access itself never reaches the browser.
export async function POST(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked

  let body: {
    action?: unknown
    clientOrigin?: unknown
    state?: unknown
    code?: unknown
  }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  if (body?.action === 'begin') {
    const clientOrigin = parseOrigin(body.clientOrigin)
    if (!clientOrigin) {
      return Response.json(
        { error: 'clientOrigin is required.' },
        { status: 400 },
      )
    }
    return Response.json(beginDriveConnect(clientOrigin), { headers: noStore })
  }

  if (body?.action === 'complete') {
    const state = typeof body.state === 'string' ? body.state : ''
    const code = typeof body.code === 'string' ? body.code : ''
    if (!state || !code || state.length > 512 || code.length > 4096) {
      return Response.json(
        { error: 'state and code are required.' },
        { status: 400 },
      )
    }
    try {
      await completeDriveConnect(state, code)
    } catch (error) {
      // These messages are written for the user and never include tokens.
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Google Drive sign-in failed.',
        },
        { status: 400, headers: noStore },
      )
    }
    return Response.json(await getDriveBackupStatus(), { headers: noStore })
  }

  return Response.json({ error: 'Unknown action.' }, { status: 400 })
}

export async function DELETE(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    await disconnectDrive()
    return Response.json(await getDriveBackupStatus(), { headers: noStore })
  } catch (error) {
    reportServerError(error, '/api/drive-backup/connect')
    return Response.json(
      { error: 'Could not disconnect Google Drive.' },
      { status: 500 },
    )
  }
}
