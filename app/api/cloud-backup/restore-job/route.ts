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
  let body: { sessionToken?: unknown }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }
  const sessionToken =
    typeof body?.sessionToken === 'string' ? body.sessionToken.trim() : ''
  if (!sessionToken || sessionToken.length > 16_384)
    return Response.json(
      { error: 'sessionToken is required.' },
      { status: 400 },
    )
  try {
    return Response.json(startCloudRestoreJob(sessionToken, generation), {
      status: 202,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    const busy = vaultAccessErrorResponse(error)
    if (busy) return busy
    if (error instanceof VaultOperationBusyError)
      return Response.json({ error: error.message }, { status: 409 })
    return Response.json(
      { error: 'Could not start cloud restore. Please try again.' },
      { status: 500 },
    )
  }
}
