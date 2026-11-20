'use client'

import { Trophy } from 'lucide-react'
import { AchievementBadge } from '@/components/achievement-badge'
import { useAchievements } from '@/components/providers/achievements-provider'
import {
  achievementPoints,
  ACHIEVEMENTS_BY_ID,
  nextAchievements,
} from '@/lib/achievements/catalog'
import {
  achievementPercent,
  formatAchievementProgress,
} from '@/lib/achievements/format'
import type {
  AchievementState,
  AchievementUnlock,
} from '@/lib/achievements/unlocks'
import { cn } from '@/lib/utils'

const number = new Intl.NumberFormat('en-US')

/** Newest first; unlocks from the same moment lead with the highest tier. */
export function recentUnlocks(
  unlocks: readonly AchievementUnlock[],
  limit = Infinity,
): AchievementUnlock[] {
  return unlocks
    .filter((unlock) => ACHIEVEMENTS_BY_ID.has(unlock.id))
    .sort(
      (left, right) =>
        right.unlockedAt.localeCompare(left.unlockedAt) ||
        achievementPoints(right.id) - achievementPoints(left.id),
    )
    .slice(0, limit)
}

export function ProgressBar({
  percent,
  label,
  className,
}: {
  percent: number
  label: string
  className?: string
}) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      className={cn('h-1.5 overflow-hidden rounded-full bg-muted', className)}
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-500"
        style={{ width: `${percent}%` }}
      />
    </div>
  )
}

/** Rank, score and progress to the next rank. */
export function AchievementRankSummary({
  summary,
  className,
}: {
  summary: AchievementState['summary']
  className?: string
}) {
  const { rank, nextRank, score } = summary
  const rankPercent = nextRank
    ? ((score - rank.minScore) / (nextRank.minScore - rank.minScore)) * 100
    : 100
  return (
    <div
      className={cn('flex items-center gap-4', className)}
      data-achievement-rank
    >
      <span className="grid size-12 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
        <Trophy className="size-6" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <p className="text-lg font-semibold tracking-tight">{rank.title}</p>
          <p className="text-sm text-muted-foreground">
            <strong className="font-semibold text-foreground">
              {number.format(score)}
            </strong>{' '}
            points · {summary.unlockedCount} / {summary.total} unlocked
          </p>
        </div>
        <ProgressBar
          className="mt-2"
          percent={rankPercent}
          label={nextRank ? `Progress to ${nextRank.title}` : 'Top rank'}
        />
        <p className="mt-1.5 text-xs text-muted-foreground">
          {nextRank
            ? `${number.format(nextRank.minScore - score)} points to ${nextRank.title}`
            : 'Top rank reached. Every badge from here is for the glory.'}
        </p>
      </div>
    </div>
  )
}

/**
 * The Insights trophy case: rank and score, the latest badges and the three
 * closest to unlocking. Renders nothing while achievements are off.
 */
export function AchievementTrophyCase() {
  const { settings, state } = useAchievements()
  if (!settings.enabled) return null
  if (!state) {
    return (
      <div
        role="status"
        aria-label="Loading achievements"
        className="h-40 animate-pulse rounded-lg bg-muted"
      />
    )
  }

  const recent = recentUnlocks(state.unlocks, 5)
  const next = nextAchievements(state.progress, 3)

  return (
    <div className="grid gap-5" data-achievement-trophy-case>
      <AchievementRankSummary summary={state.summary} />
      <div className="grid gap-5 md:grid-cols-2">
        <div className="min-w-0">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Recently unlocked
          </h3>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No badges yet. Your first one is closer than you think.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-3">
              {recent.map((unlock) => {
                const achievement = ACHIEVEMENTS_BY_ID.get(unlock.id)!
                return (
                  <li
                    key={unlock.id}
                    className="flex w-[4.5rem] flex-col items-center gap-1 text-center"
                    title={`${achievement.title}: ${achievement.description}`}
                  >
                    <AchievementBadge id={unlock.id} />
                    <span className="line-clamp-2 text-[11px] leading-tight">
                      {achievement.title}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <div className="min-w-0">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Next up
          </h3>
          {next.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Keep adding and caring for knives to start new badges.
            </p>
          ) : (
            <ul className="grid gap-3">
              {next.map((entry) => {
                const achievement = ACHIEVEMENTS_BY_ID.get(entry.id)!
                return (
                  <li key={entry.id} className="flex items-center gap-3">
                    <AchievementBadge id={entry.id} size="sm" locked />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="truncate text-sm font-medium">
                          {achievement.title}
                        </p>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {formatAchievementProgress(entry)}
                        </span>
                      </div>
                      <ProgressBar
                        className="mt-1"
                        percent={achievementPercent(entry)}
                        label={`${achievement.title} progress`}
                      />
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

/** Whether Insights should show the trophy case panel. */
export function useTrophyCaseVisible(): boolean {
  return useAchievements().settings.enabled
}
