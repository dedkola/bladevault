import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { parseAchievementAction } from '@/lib/achievements/unlocks'
import { reportServerError } from '@/lib/sentry/server'
import {
  getAchievementState,
  syncAchievements,
  updateAchievements,
} from '@/lib/services/achievements-service'
import { withVaultMutationRequest } from '@/lib/vault-mutation-request'

function serverError(error: unknown) {
  reportServerError(error, '/api/achievements')
  const message = error instanceof Error ? error.message : 'Unknown error'
  return NextResponse.json({ error: message }, { status: 500 })
}

/** Stored unlocks and live progress, without recording new unlocks. */
export async function GET(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked

  try {
    return NextResponse.json(await getAchievementState())
  } catch (error) {
    return serverError(error)
  }
}

/** Evaluates the vault, records newly met achievements and returns them. */
export async function POST(request: Request) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked

    try {
      return NextResponse.json(await syncAchievements())
    } catch (error) {
      return serverError(error)
    }
  })
}

/** Marks unlocks as celebrated, or resets every unlock. */
export async function PATCH(request: Request) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked

    let action
    try {
      action = parseAchievementAction(await request.json())
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Invalid request body'
      return NextResponse.json({ error: message }, { status: 400 })
    }
    try {
      return NextResponse.json(await updateAchievements(action))
    } catch (error) {
      return serverError(error)
    }
  })
}
