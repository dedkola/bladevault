import {
  ACHIEVEMENT_TIER_POINTS,
  ACHIEVEMENTS,
  ACHIEVEMENTS_BY_ID,
  evaluateAchievements,
  summarizeAchievements,
  type AchievementCategory,
} from '@/lib/achievements/catalog'
import { formatAchievementProgress } from '@/lib/achievements/format'
import {
  achievementMessageKey,
  ACHIEVEMENT_BACKFILL_KEY_PREFIX,
} from '@/lib/achievements/messages'
import type { AchievementInput } from '@/lib/achievements/snapshot'
import {
  getAchievementUnlocks,
  markAchievementsSeen,
  readPriceAchievementInput,
  resetAchievements,
  saveAchievementUnlocks,
} from '@/lib/achievements/store'
import {
  latestTouchedKnifeId,
  type AchievementAction,
  type AchievementState,
  type AchievementSyncResult,
  type AchievementUnlock,
} from '@/lib/achievements/unlocks'
import { getCareNotificationBox } from '@/lib/care-notifications'
import { getComparisons } from '@/lib/comparison-storage'
import { getSettings } from '@/lib/settings'
import { getStorage } from '@/lib/storage'
import { reportSystemMessage } from '@/lib/system-message-store'
import type { Knife } from '@/lib/data'

/** Reads every source the achievement checks need from the vault. */
async function gatherAchievementInput(now: Date): Promise<AchievementInput> {
  const storage = getStorage()
  const settings = getSettings()
  const [knives, activity, maintenance, notes, careNotifications] =
    await Promise.all([
      storage.getAllKnives(),
      storage.getKnifeActivity(),
      storage.getAllMaintenanceEvents(),
      storage.getAllKnifeNotes(),
      settings.maintenanceReminders.enabled
        ? storage.getCareNotifications()
        : Promise.resolve(null),
    ])
  return {
    knives,
    activity,
    maintenance,
    noteCount: notes.length,
    comparisons: getComparisons().map((list) => ({ knifeIds: list.ids })),
    openCareReminders: careNotifications
      ? careNotifications.filter(
          (notification) =>
            getCareNotificationBox(notification, now) === 'open',
        ).length
      : null,
    clearedCareReminders: careNotifications
      ? careNotifications.filter(
          (notification) =>
            getCareNotificationBox(notification, now) === 'done',
        ).length
      : 0,
    priceMonitoring: settings.priceMonitoring.enabled
      ? readPriceAchievementInput()
      : null,
    now,
  }
}

const TIER_LABELS = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  platinum: 'Platinum',
} as const

/** One Inbox message per new unlock, and one summary for a quiet backfill. */
async function reportAchievementMessages(
  unlocks: readonly AchievementUnlock[],
  backfilledCount: number,
  knives: readonly Knife[],
  now: Date,
) {
  const knifeNames = new Map(
    knives.map((knife) => [
      knife.id,
      [knife.brand, knife.name].filter(Boolean).join(' '),
    ]),
  )
  for (const unlock of unlocks) {
    const achievement = ACHIEVEMENTS_BY_ID.get(unlock.id)
    if (!achievement) continue
    const knifeName = unlock.knifeId ? knifeNames.get(unlock.knifeId) : null
    const points = ACHIEVEMENT_TIER_POINTS[achievement.tier]
    await reportSystemMessage(
      {
        kind: 'achievement',
        key: achievementMessageKey(unlock.id),
        title: `Achievement unlocked: ${achievement.title}`,
        detail: [
          `${achievement.description} · ${TIER_LABELS[achievement.tier]} · +${points} points`,
          knifeName ? `Unlocked with ${knifeName}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      },
      now,
    )
  }
  if (backfilledCount > 0) {
    await reportSystemMessage(
      {
        kind: 'achievement',
        key: `${ACHIEVEMENT_BACKFILL_KEY_PREFIX}${now.toISOString()}`,
        title:
          backfilledCount === 1
            ? 'Your vault already meets 1 achievement'
            : `Your vault already meets ${backfilledCount} achievements`,
        detail:
          'They were added quietly to your trophy case, without celebrations.',
      },
      now,
    )
  }
}

function buildState(
  unlocks: AchievementUnlock[],
  progress: AchievementState['progress'],
  enabled = true,
): AchievementState {
  return {
    enabled,
    unlocks,
    progress,
    summary: summarizeAchievements(unlocks.map((unlock) => unlock.id)),
  }
}

function achievementsEnabled(): boolean {
  return getSettings().achievements.enabled
}

/** Unlocks kept while achievements are off; nothing is evaluated. */
function disabledState(): AchievementState {
  return buildState(getAchievementUnlocks(), [], false)
}

/** Stored unlocks plus live progress, without recording anything. */
export async function getAchievementState(
  now: Date = new Date(),
): Promise<AchievementState> {
  if (!achievementsEnabled()) return disabledState()
  const progress = evaluateAchievements(await gatherAchievementInput(now))
  return buildState(getAchievementUnlocks(), progress)
}

/**
 * Evaluates the vault and records achievements that are newly met. Earned
 * badges are permanent: one whose condition no longer holds stays unlocked.
 * Does nothing while achievements are switched off.
 */
export async function syncAchievements(
  now: Date = new Date(),
): Promise<AchievementSyncResult> {
  if (!achievementsEnabled()) {
    return { ...disabledState(), newlyUnlocked: [], backfilledCount: 0 }
  }
  const input = await gatherAchievementInput(now)
  const progress = evaluateAchievements(input)
  const knifeId = latestTouchedKnifeId(input)
  const { inserted, backfilled } = await saveAchievementUnlocks(
    progress
      .filter((entry) => entry.done)
      .map((entry) => ({ id: entry.id, knifeId })),
    now,
  )
  const newlyUnlocked = backfilled ? [] : inserted
  const backfilledCount = backfilled ? inserted.length : 0
  if (getSettings().achievements.inbox) {
    await reportAchievementMessages(
      newlyUnlocked,
      backfilledCount,
      input.knives,
      now,
    )
  }
  return {
    ...buildState(getAchievementUnlocks(), progress),
    newlyUnlocked,
    backfilledCount,
  }
}

export async function updateAchievements(
  action: AchievementAction,
  now: Date = new Date(),
): Promise<AchievementState> {
  if (action.action === 'seen') await markAchievementsSeen(action.ids, now)
  else await resetAchievements()
  return getAchievementState(now)
}

export type AchievementReportStatus = 'all' | 'unlocked' | 'locked'

/**
 * A read-only report for MCP clients: rank and score plus each badge with its
 * progress. Locked secret badges are left out and only counted, so an
 * assistant cannot spoil them. Records nothing; unlocks come from the app.
 */
export async function getAchievementReport(
  options: {
    status?: AchievementReportStatus
    category?: AchievementCategory
  } = {},
  now: Date = new Date(),
): Promise<Record<string, unknown>> {
  const state = await getAchievementState(now)
  if (!state.enabled) {
    return {
      enabled: false,
      message:
        'Achievements are switched off in Settings → Achievements. Unlocks are kept but not tracked.',
    }
  }
  const unlockById = new Map(state.unlocks.map((unlock) => [unlock.id, unlock]))
  const progressById = new Map(state.progress.map((entry) => [entry.id, entry]))
  const status = options.status ?? 'all'
  let hiddenSecretCount = 0
  const achievements = ACHIEVEMENTS.flatMap((achievement) => {
    if (options.category && achievement.category !== options.category) {
      return []
    }
    const unlock = unlockById.get(achievement.id)
    if (achievement.secret && !unlock) {
      hiddenSecretCount += 1
      return []
    }
    if (status === 'unlocked' && !unlock) return []
    if (status === 'locked' && unlock) return []
    const progress = progressById.get(achievement.id)
    return [
      {
        id: achievement.id,
        title: achievement.title,
        description: achievement.description,
        category: achievement.category,
        tier: achievement.tier,
        points: ACHIEVEMENT_TIER_POINTS[achievement.tier],
        secret: achievement.secret === true,
        unlocked: Boolean(unlock),
        unlockedAt: unlock?.unlockedAt ?? null,
        unlockedWithKnifeId: unlock?.knifeId ?? null,
        progress:
          unlock || !progress
            ? null
            : {
                current: Math.min(progress.current, progress.target),
                target: progress.target,
                text: formatAchievementProgress(progress),
                available: progress.available,
              },
      },
    ]
  })
  const { summary } = state
  return {
    enabled: true,
    rank: summary.rank.title,
    nextRank: summary.nextRank
      ? {
          title: summary.nextRank.title,
          pointsNeeded: summary.nextRank.minScore - summary.score,
        }
      : null,
    score: summary.score,
    maxScore: summary.maxScore,
    unlockedCount: summary.unlockedCount,
    total: summary.total,
    hiddenSecretCount,
    achievements,
  }
}
