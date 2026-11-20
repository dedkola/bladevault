import type { AchievementProgress } from '@/lib/achievements/catalog'
import type { AchievementInput } from '@/lib/achievements/snapshot'
import {
  achievementPoints,
  ACHIEVEMENTS_BY_ID,
  summarizeAchievements,
} from '@/lib/achievements/catalog'

/** Asks the achievements provider to sync soon (e.g. after a reset). */
export const ACHIEVEMENTS_REFRESH_EVENT = 'bladevault:achievements-refresh'

/** A stored unlock. Unlocks are permanent until the user resets them. */
export type AchievementUnlock = {
  id: string
  unlockedAt: string
  /** The knife most recently touched when it unlocked; may since be deleted. */
  knifeId: string | null
  /** Earned before tracking started, so it is never celebrated. */
  backfilled: boolean
  /** When the unlock was celebrated (or backfilled); null while pending. */
  seenAt: string | null
}

export type AchievementState = {
  /** False while achievements are switched off in Settings; progress is then empty. */
  enabled: boolean
  unlocks: AchievementUnlock[]
  progress: AchievementProgress[]
  summary: ReturnType<typeof summarizeAchievements>
}

export type AchievementSyncResult = AchievementState & {
  /** Unlocks this sync created that should be celebrated. */
  newlyUnlocked: AchievementUnlock[]
  /** How many unlocks this sync recorded silently as the first evaluation. */
  backfilledCount: number
}

export type AchievementAction =
  { action: 'seen'; ids: string[] } | { action: 'reset' }

export function parseAchievementAction(body: unknown): AchievementAction {
  if (!body || typeof body !== 'object') {
    throw new Error('Expected an achievement action.')
  }
  const { action, ids } = body as { action?: unknown; ids?: unknown }
  if (action === 'reset') return { action }
  if (action === 'seen') {
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > ACHIEVEMENTS_BY_ID.size ||
      !ids.every((id) => typeof id === 'string' && ACHIEVEMENTS_BY_ID.has(id))
    ) {
      throw new Error('Provide the ids of known achievements.')
    }
    return { action, ids: [...new Set(ids as string[])] }
  }
  throw new Error('Unknown achievement action.')
}

/**
 * Unlocks waiting to be celebrated, oldest first; unlocks from the same sync
 * lead with the highest tier, so "Collector" comes before "Drawer Starter".
 */
export function pendingCelebrations(
  unlocks: readonly AchievementUnlock[],
): AchievementUnlock[] {
  return unlocks
    .filter((unlock) => !unlock.backfilled && !unlock.seenAt)
    .sort(
      (left, right) =>
        left.unlockedAt.localeCompare(right.unlockedAt) ||
        achievementPoints(right.id) - achievementPoints(left.id),
    )
}

/**
 * The knife touched most recently (added, edited or cared for), credited on
 * the unlock as the one that "did it". Null when it no longer exists.
 */
export function latestTouchedKnifeId(input: AchievementInput): string | null {
  const existing = new Set(input.knives.map((knife) => knife.id))
  const events = [
    ...input.knives.map((knife) => ({
      knifeId: knife.id,
      occurredAt: knife.addedAt,
    })),
    ...(input.activity ?? []),
    ...(input.maintenance ?? []),
  ]
  let latestId: string | null = null
  let latestAt = -Infinity
  for (const event of events) {
    const at = Date.parse(event.occurredAt)
    if (existing.has(event.knifeId) && at > latestAt) {
      latestId = event.knifeId
      latestAt = at
    }
  }
  return latestId
}

/**
 * Records newly met achievements in memory (the static web app's session),
 * with the same rules as the vault store: unlocks are permanent, and the first
 * evaluation after tracking starts is stored quietly as already seen.
 */
export function recordAchievementUnlocks(
  existing: readonly AchievementUnlock[],
  candidates: ReadonlyArray<{ id: string; knifeId: string | null }>,
  initialized: boolean,
  now: Date,
): { unlocks: AchievementUnlock[]; inserted: AchievementUnlock[] } {
  const known = new Set(existing.map((unlock) => unlock.id))
  const at = now.toISOString()
  const inserted = candidates
    .filter((candidate) => ACHIEVEMENTS_BY_ID.has(candidate.id))
    .filter((candidate) => !known.has(candidate.id))
    .map<AchievementUnlock>((candidate) => ({
      id: candidate.id,
      unlockedAt: at,
      knifeId: candidate.knifeId,
      backfilled: !initialized,
      seenAt: initialized ? null : at,
    }))
  return { unlocks: [...existing, ...inserted], inserted }
}
