import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import {
  applyAttentionAction,
  readAttentionList,
} from '@/lib/price-monitor/attention-actions'
import { parseAttentionActionRequest } from '@/lib/price-monitor/attention-filter'
import { reportServerError } from '@/lib/sentry/server'
import {
  getVaultAccessState,
  vaultAccessErrorResponse,
} from '@/lib/vault-access'
import { withVaultMutationRequest } from '@/lib/vault-mutation-request'

/**
 * Needs attention: store pages whose checks need the user, with snoozed
 * and quiet ones after them (see price-monitor/attention-filter).
 */
export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    return NextResponse.json(readAttentionList(), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    const vaultResponse = vaultAccessErrorResponse(error)
    if (vaultResponse) return vaultResponse
    reportServerError(error, '/api/prices/attention')
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * Later (snooze 1 or 7 days), unsnooze, Price is right (accept), Wrong
 * page, Pause, Remove, Retry (check now, fresh cookies after a bot check)
 * or Find at other stores for one or many store pages:
 * `{ action, sourceIds, days? }`.
 */
export async function POST(request: Request) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked
    let body
    try {
      body = parseAttentionActionRequest(await request.json())
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Invalid request body'
      return NextResponse.json({ error: message }, { status: 400 })
    }
    try {
      if (getVaultAccessState().readOnly)
        return NextResponse.json(
          { error: 'The vault is read-only while a restore runs.' },
          { status: 423 },
        )
      const result = await applyAttentionAction(body)
      return NextResponse.json(
        { result, ...readAttentionList() },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    } catch (error) {
      const vaultResponse = vaultAccessErrorResponse(error)
      if (vaultResponse) return vaultResponse
      reportServerError(error, '/api/prices/attention')
      const message = error instanceof Error ? error.message : 'Unknown error'
      return NextResponse.json({ error: message }, { status: 500 })
    }
  })
}
