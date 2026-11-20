'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import {
  AchievementBadge,
  ACHIEVEMENT_TIER_COLORS,
  ACHIEVEMENT_TIER_LABELS,
} from '@/components/achievement-badge'
import {
  AchievementRankSummary,
  ProgressBar,
} from '@/components/achievement-trophy-case'
import { AchievementShareButton } from '@/components/achievement-share-card'
import { useAchievements } from '@/components/providers/achievements-provider'
import { useKnives } from '@/components/providers/knives-provider'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  ACHIEVEMENT_CATEGORIES,
  ACHIEVEMENT_TIER_POINTS,
  ACHIEVEMENTS,
  type AchievementCategory,
  type AchievementDefinition,
  type AchievementProgress,
  type AchievementTier,
} from '@/lib/achievements/catalog'
import {
  achievementPercent,
  formatAchievementProgress,
} from '@/lib/achievements/format'
import type { AchievementUnlock } from '@/lib/achievements/unlocks'
import { cn } from '@/lib/utils'

type StatusFilter = 'all' | 'unlocked' | 'locked' | 'secret'

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unlocked', label: 'Unlocked' },
  { value: 'locked', label: 'Locked' },
  { value: 'secret', label: 'Secret' },
]

const TIERS: AchievementTier[] = ['bronze', 'silver', 'gold', 'platinum']

type Row = {
  achievement: AchievementDefinition
  progress: AchievementProgress | undefined
  unlock: AchievementUnlock | undefined
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : ''
}

/** Unlocked newest first, then locked by closeness, unavailable last. */
function compareRows(left: Row, right: Row): number {
  if (left.unlock && right.unlock) {
    return right.unlock.unlockedAt.localeCompare(left.unlock.unlockedAt)
  }
  if (left.unlock) return -1
  if (right.unlock) return 1
  const leftAvailable = left.progress?.available !== false
  const rightAvailable = right.progress?.available !== false
  if (leftAvailable !== rightAvailable) return leftAvailable ? -1 : 1
  const leftPercent = left.progress ? achievementPercent(left.progress) : 0
  const rightPercent = right.progress ? achievementPercent(right.progress) : 0
  return (
    rightPercent - leftPercent ||
    ACHIEVEMENT_TIER_POINTS[left.achievement.tier] -
      ACHIEVEMENT_TIER_POINTS[right.achievement.tier]
  )
}

function AchievementCard({
  row,
  knifeName,
}: {
  row: Row
  knifeName: string | null
}) {
  const { achievement, progress, unlock } = row
  const hidden = achievement.secret && !unlock
  const points = ACHIEVEMENT_TIER_POINTS[achievement.tier]
  return (
    <li
      id={`achievement-${achievement.id}`}
      data-achievement={achievement.id}
      data-unlocked={unlock ? 'true' : 'false'}
      className={cn(
        'flex min-w-0 gap-3 rounded-lg border border-border bg-card p-3',
        !unlock && 'bg-muted/30',
      )}
    >
      <AchievementBadge id={achievement.id} locked={!unlock} />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'font-medium leading-snug',
            !unlock && 'text-muted-foreground',
          )}
        >
          {hidden ? '???' : achievement.title}
        </p>
        <p className="text-xs text-muted-foreground">
          {hidden
            ? 'A secret achievement. Keep collecting to find out.'
            : achievement.description}
        </p>
        <p className="mt-1 text-[11px] font-medium text-muted-foreground">
          {ACHIEVEMENT_TIER_LABELS[achievement.tier]} · {points} points
          {achievement.secret && !hidden ? ' · Secret' : ''}
        </p>
        {unlock ? (
          <p className="mt-1 text-xs">
            Unlocked {formatDate(unlock.unlockedAt)}
            {unlock.backfilled ? ' (already met)' : ''}
            {unlock.knifeId && knifeName ? (
              <>
                {' · with '}
                <Link
                  href={`/collection/${encodeURIComponent(unlock.knifeId)}`}
                  className="font-medium underline-offset-2 hover:underline"
                >
                  {knifeName}
                </Link>
              </>
            ) : null}
          </p>
        ) : progress && !progress.available ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Turn on price monitoring to track this one.
          </p>
        ) : progress && !hidden && progress.target > 1 ? (
          <div className="mt-2">
            <ProgressBar
              percent={achievementPercent(progress)}
              label={`${achievement.title} progress`}
            />
            <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
              {formatAchievementProgress(progress)}
            </p>
          </div>
        ) : null}
      </div>
    </li>
  )
}

/** The full trophy case: every badge, filterable by category and status. */
export function AchievementsDetail() {
  const { settings, state } = useAchievements()
  const { knives } = useKnives()
  const [category, setCategory] = useState<AchievementCategory | null>(null)
  const [status, setStatus] = useState<StatusFilter>('all')

  const knifeNames = useMemo(
    () =>
      new Map(
        knives.map((knife) => [
          knife.id,
          knife.brand ? `${knife.brand} ${knife.name}` : knife.name,
        ]),
      ),
    [knives],
  )

  const rows = useMemo<Row[]>(() => {
    if (!state) return []
    const progressById = new Map(state.progress.map((p) => [p.id, p]))
    const unlockById = new Map(state.unlocks.map((u) => [u.id, u]))
    return ACHIEVEMENTS.map((achievement) => ({
      achievement,
      progress: progressById.get(achievement.id),
      unlock: unlockById.get(achievement.id),
    }))
  }, [state])

  if (!settings.enabled) {
    return (
      <Card className="border-dashed bg-muted/40">
        <CardContent className="flex flex-col items-center py-16 text-center">
          <h2 className="font-medium">Achievements are switched off</h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Turn them on in Settings to earn badges for collection milestones,
            care habits and lucky finds.
          </p>
          <Button
            className="mt-5"
            render={<Link href="/settings?tab=achievements" />}
            nativeButton={false}
          >
            Open achievement settings
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (!state) {
    return (
      <div
        role="status"
        aria-label="Loading achievements"
        className="h-96 animate-pulse rounded-xl bg-muted"
      />
    )
  }

  // Locked secrets stay out of the list unless the user asked to see them.
  const visible = rows.filter(
    (row) => !row.achievement.secret || row.unlock || settings.showSecret,
  )
  const hiddenSecrets = rows.length - visible.length
  const inCategory = category
    ? visible.filter((row) => row.achievement.category === category)
    : visible
  const shown = inCategory
    .filter((row) =>
      status === 'unlocked'
        ? row.unlock
        : status === 'locked'
          ? !row.unlock
          : status === 'secret'
            ? row.achievement.secret
            : true,
    )
    .sort(compareRows)

  const tierCounts = TIERS.map((tier) => {
    const inTier = rows.filter((row) => row.achievement.tier === tier)
    return {
      tier,
      unlocked: inTier.filter((row) => row.unlock).length,
      total: inTier.length,
    }
  })

  return (
    <div className="grid gap-5" data-achievements-page>
      <Card className="gap-0 py-0">
        <CardContent className="grid gap-4 p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <AchievementRankSummary
              summary={state.summary}
              className="min-w-0 flex-1"
            />
            <div className="shrink-0 self-end sm:self-center">
              <AchievementShareButton state={state} />
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {tierCounts.map(({ tier, unlocked, total }) => (
              <div
                key={tier}
                className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2"
              >
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: ACHIEVEMENT_TIER_COLORS[tier] }}
                />
                <dt className="text-xs text-muted-foreground">
                  {ACHIEVEMENT_TIER_LABELS[tier]}
                </dt>
                <dd className="ml-auto text-sm font-semibold tabular-nums">
                  {unlocked}/{total}
                </dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        <div
          role="group"
          aria-label="Category"
          className="flex flex-wrap gap-1.5"
        >
          {[
            { id: null, label: 'All categories' },
            ...ACHIEVEMENT_CATEGORIES,
          ].map((entry) => {
            const inThis = entry.id
              ? visible.filter((row) => row.achievement.category === entry.id)
              : visible
            const active = category === entry.id
            return (
              <button
                key={entry.id ?? 'all'}
                type="button"
                aria-pressed={active}
                onClick={() => setCategory(entry.id)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {entry.label}{' '}
                <span className="tabular-nums opacity-75">
                  {inThis.filter((row) => row.unlock).length}/{inThis.length}
                </span>
              </button>
            )
          })}
        </div>
        <Tabs
          value={status}
          onValueChange={(value) => setStatus(value as StatusFilter)}
        >
          <TabsList aria-label="Status">
            {STATUS_FILTERS.map((filter) => (
              <TabsTrigger key={filter.value} value={filter.value}>
                {filter.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
          {status === 'unlocked'
            ? 'Nothing unlocked here yet.'
            : status === 'secret' && !settings.showSecret
              ? 'No secrets found yet.'
              : 'Nothing left to unlock here. Well done.'}
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((row) => (
            <AchievementCard
              key={row.achievement.id}
              row={row}
              knifeName={
                row.unlock?.knifeId
                  ? (knifeNames.get(row.unlock.knifeId) ?? null)
                  : null
              }
            />
          ))}
        </ul>
      )}

      {hiddenSecrets > 0 && (
        <p className="text-xs text-muted-foreground">
          {hiddenSecrets} secret{' '}
          {hiddenSecrets === 1 ? 'achievement is' : 'achievements are'} hidden
          until you find {hiddenSecrets === 1 ? 'it' : 'them'}.{' '}
          <Link
            href="/settings?tab=achievements"
            className="underline-offset-2 hover:underline"
          >
            Show them as “???”
          </Link>
        </p>
      )}
    </div>
  )
}
