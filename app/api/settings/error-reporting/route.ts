import { withVaultMutationRequest } from '@/lib/vault-mutation-request'
import { requireAppUnlock } from '@/lib/app-lock'
import { z } from 'zod/v4'
import { vaultAccessErrorResponse } from '@/lib/vault-access'
import {
  getErrorReportingConsent,
  setErrorReportingConsent,
} from '@/lib/error-reporting-consent'
import {
  getErrorReportingConfig,
  getErrorReportingMode,
  reportServerError,
} from '@/lib/sentry/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const updateSchema = z
  .object({ consent: z.enum(['granted', 'declined']) })
  .strict()

const NO_STORE = { 'Cache-Control': 'no-store' }

function status() {
  const mode = getErrorReportingMode()
  const consent = mode === 'consent' ? getErrorReportingConsent() : null
  return {
    mode,
    consent,
    // The browser starts its SDK from this after a "Send Reports" answer.
    config:
      mode === 'managed' || consent === 'granted'
        ? getErrorReportingConfig()
        : null,
  }
}

export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked

  try {
    return Response.json(status(), { headers: NO_STORE })
  } catch (error) {
    reportServerError(error, '/api/settings/error-reporting')
    return Response.json(
      { error: 'Could not load the error reporting setting.' },
      { status: 500 },
    )
  }
}

export async function POST(request: Request) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked

    const parsed = updateSchema.safeParse(
      await request.json().catch(() => null),
    )
    if (!parsed.success) {
      return Response.json(
        { error: 'Choose granted or declined.' },
        { status: 400 },
      )
    }

    if (getErrorReportingMode() !== 'consent') {
      return Response.json(
        { error: 'Error reporting is managed by this server.' },
        { status: 409 },
      )
    }

    try {
      setErrorReportingConsent(parsed.data.consent)
      return Response.json(status(), { headers: NO_STORE })
    } catch (error) {
      const busy = vaultAccessErrorResponse(error)
      if (busy) return busy
      reportServerError(error, '/api/settings/error-reporting')
      return Response.json(
        { error: 'Could not save the error reporting setting.' },
        { status: 500 },
      )
    }
  })
}
