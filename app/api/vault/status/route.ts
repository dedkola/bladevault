import { isAppLockEnabled, requireAppUnlock } from '@/lib/app-lock'
import { getVaultAccessState } from '@/lib/vault-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  return Response.json(
    { ...getVaultAccessState(), appLockEnabled: isAppLockEnabled() },
    {
      headers: { 'Cache-Control': 'no-store' },
    },
  )
}
