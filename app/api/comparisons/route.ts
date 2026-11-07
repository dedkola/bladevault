import { withVaultMutationRequest } from '@/lib/vault-mutation-request'
import { requireAppUnlock } from '@/lib/app-lock'
import { NextResponse } from 'next/server'
import { comparisonCommandSchema } from '@/lib/comparisons'
import {
  ComparisonError,
  getComparisons,
  mutateComparison,
} from '@/lib/comparison-storage'
import { reportServerError } from '@/lib/sentry/server'

export function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  try {
    return NextResponse.json({ lists: getComparisons() })
  } catch (error) {
    reportServerError(error, '/api/comparisons')
    return NextResponse.json(
      { error: 'Could not load comparisons.' },
      { status: 500 },
    )
  }
}
export async function POST(request: Request) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }
    const parsed = comparisonCommandSchema.safeParse(body)
    if (!parsed.success)
      return NextResponse.json(
        {
          error:
            parsed.error.issues[0]?.message ?? 'Invalid comparison request.',
        },
        { status: 400 },
      )
    try {
      return NextResponse.json(mutateComparison(parsed.data))
    } catch (error) {
      if (!(error instanceof ComparisonError)) {
        reportServerError(error, '/api/comparisons')
      }
      return NextResponse.json(
        {
          error:
            error instanceof ComparisonError
              ? error.message
              : 'Could not save comparison.',
        },
        { status: error instanceof ComparisonError ? error.status : 500 },
      )
    }
  })
}
