import { requireAppUnlock } from '@/lib/app-lock'
import { getLocalDb } from '@/lib/local-db'
import { getMcpActivity } from '@/lib/mcp/activity'
import { getVaultAccessState } from '@/lib/vault-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * A cheap token that changes when the vault is written outside this window:
 * `data_version` moves when another process (the stdio CLI) commits, and the
 * MCP write counter covers in-process MCP writes, which share the app's
 * connection. The app's own UI writes leave it unchanged.
 */
export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked

  try {
    const { generation } = getVaultAccessState()
    const dataVersion = getLocalDb().pragma('data_version', { simple: true })
    const { writesSinceStart } = getMcpActivity()
    return Response.json(
      { token: `${generation}:${dataVersion}:${writesSinceStart}` },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch {
    // The vault may be switching or restoring; callers retry later.
    return Response.json(
      { error: 'Vault unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
