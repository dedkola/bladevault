import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { getLocalDb } from '@/lib/local-db'
import {
  agentActive,
  agentIntervalMs,
  readAgentRuns,
  runPriceAgent,
} from '@/lib/price-monitor/agent'
import { NO_STORE, priceAiErrorResponse } from '@/lib/price-monitor/ai-route'
import { getPriceMonitorWorker } from '@/lib/price-monitor/worker'
import { reportServerError } from '@/lib/sentry/server'
import { getSettings } from '@/lib/settings'
import { vaultAccessErrorResponse } from '@/lib/vault-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SKIPPED: Record<string, { status: number; error: string }> = {
  disabled: {
    status: 409,
    error:
      'Set up AI and choose Observe or Act for the AI supervisor in Settings → Price monitoring.',
  },
  read_only: {
    status: 423,
    error: 'The vault is read-only while a restore runs.',
  },
  busy: { status: 409, error: 'The AI supervisor is already running.' },
}

/** The AI supervisor's recent runs, newest first. */
export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    const settings = getSettings().priceMonitoring
    return NextResponse.json(
      {
        mode: settings.ai.agentMode,
        active: agentActive(settings),
        intervalMinutes: Math.round(agentIntervalMs(settings) / 60_000),
        runs: readAgentRuns(getLocalDb(), 20),
      },
      { headers: NO_STORE },
    )
  } catch (error) {
    const vaultResponse = vaultAccessErrorResponse(error)
    if (vaultResponse) return vaultResponse
    reportServerError(error, '/api/prices/agent')
    return NextResponse.json(
      { error: 'Could not read the AI supervisor runs.' },
      { status: 500 },
    )
  }
}

/** Run the AI supervisor now; checks it moves forward start at once. */
export async function POST(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    const result = await runPriceAgent({
      trigger: 'manual',
      signal: request.signal,
    })
    if (result.status === 'skipped') {
      const skipped = SKIPPED[result.reason]
      return NextResponse.json(
        { error: skipped.error, reason: result.reason },
        { status: skipped.status },
      )
    }
    if (result.run.actions.some((action) => action.status === 'applied'))
      getPriceMonitorWorker().start({ scheduled: false })
    return NextResponse.json({ run: result.run }, { headers: NO_STORE })
  } catch (error) {
    const vaultResponse = vaultAccessErrorResponse(error)
    if (vaultResponse) return vaultResponse
    return priceAiErrorResponse(error, '/api/prices/agent')
  }
}
