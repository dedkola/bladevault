import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { getLocalDb } from '@/lib/local-db'
import {
  agentActive,
  agentEventGapMs,
  agentHeartbeatMs,
  agentNextRunAt,
  agentRunning,
  forgetAgentNote,
  lastAgentRunAt,
  readAgentEvents,
  readAgentLabels,
  readAgentNotes,
  readAgentRuns,
  readBlockedStores,
  runPriceAgent,
} from '@/lib/price-monitor/agent'
import { aiConfigured } from '@/lib/price-monitor/ai'
import { NO_STORE, priceAiErrorResponse } from '@/lib/price-monitor/ai-route'
import { getPriceMonitorWorker } from '@/lib/price-monitor/worker'
import { reportServerError } from '@/lib/sentry/server'
import { getSettings, saveSettings } from '@/lib/settings'
import { PRICE_AGENT_MODES, type PriceAgentMode } from '@/lib/settings-shared'
import { vaultAccessErrorResponse } from '@/lib/vault-access'
import { withVaultMutationRequest } from '@/lib/vault-mutation-request'

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

function state() {
  const settings = getSettings().priceMonitoring
  const database = getLocalDb()
  const runs = readAgentRuns(database, 20)
  const active = agentActive(settings)
  const now = Date.now()
  const last = lastAgentRunAt(database)
  const events =
    last === null
      ? { total: 0, oldestAt: null }
      : readAgentEvents(database, last, 0)
  return {
    mode: settings.ai.agentMode,
    aiConfigured: aiConfigured(settings.ai),
    usage: settings.ai.usage.mode,
    active,
    running: agentRunning(),
    intervalMinutes: Math.round(agentHeartbeatMs(settings) / 60_000),
    eventGapMinutes: Math.round(agentEventGapMs(settings) / 60_000),
    /** Changes since the last run that will wake the supervisor. */
    pendingEvents: events.total,
    nextRunAt:
      active && settings.enabled
        ? new Date(
            agentNextRunAt({ settings, lastRunAt: last, now, events }),
          ).toISOString()
        : null,
    blockedStores: readBlockedStores(database),
    runs,
    labels: readAgentLabels(database, runs),
    notes: readAgentNotes(database, now),
  }
}

/** The AI supervisor's state and recent runs, newest first. */
export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    return NextResponse.json(state(), { headers: NO_STORE })
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

/** Switch the supervisor's mode. Body: { mode: 'off' | 'observe' | 'act' }. */
export async function PATCH(request: Request) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked
    const body = (await request.json().catch(() => null)) as {
      mode?: unknown
    } | null
    if (!(PRICE_AGENT_MODES as readonly unknown[]).includes(body?.mode))
      return NextResponse.json(
        { error: 'Choose off, observe or act.' },
        { status: 400 },
      )
    try {
      const current = getSettings().priceMonitoring
      saveSettings({
        priceMonitoring: {
          ...current,
          ai: { ...current.ai, agentMode: body!.mode as PriceAgentMode },
        },
      })
      getPriceMonitorWorker().wake(0)
      return NextResponse.json(state(), { headers: NO_STORE })
    } catch (error) {
      const vaultResponse = vaultAccessErrorResponse(error)
      if (vaultResponse) return vaultResponse
      reportServerError(error, '/api/prices/agent')
      return NextResponse.json(
        { error: 'Could not change the AI supervisor.' },
        { status: 500 },
      )
    }
  })
}

/** Forget one of the supervisor's notes. Body: { noteId: number }. */
export async function DELETE(request: Request) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked
    const body = (await request.json().catch(() => null)) as {
      noteId?: unknown
    } | null
    const noteId = body?.noteId
    if (
      typeof noteId !== 'number' ||
      !Number.isSafeInteger(noteId) ||
      noteId <= 0
    )
      return NextResponse.json(
        { error: 'noteId must be a note id.' },
        { status: 400 },
      )
    try {
      if (!(await forgetAgentNote(noteId)))
        return NextResponse.json(
          { error: 'This note is already gone.' },
          { status: 404 },
        )
      return NextResponse.json(state(), { headers: NO_STORE })
    } catch (error) {
      const vaultResponse = vaultAccessErrorResponse(error)
      if (vaultResponse) return vaultResponse
      reportServerError(error, '/api/prices/agent')
      return NextResponse.json(
        { error: 'Could not forget the note.' },
        { status: 500 },
      )
    }
  })
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
    return NextResponse.json(
      { run: result.run, ...state() },
      { headers: NO_STORE },
    )
  } catch (error) {
    const vaultResponse = vaultAccessErrorResponse(error)
    if (vaultResponse) return vaultResponse
    return priceAiErrorResponse(error, '/api/prices/agent')
  }
}
