'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  DrilldownKnife,
  formatActivityCounts,
  formatActivityDayLabel,
  getOrdinalDay,
} from '@/components/collection-insights'
import { useKnives } from '@/components/providers/knives-provider'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { readJsonResponse } from '@/lib/api-response'
import { createCollectionStats } from '@/lib/collection-stats'
import { type Knife, type KnifeActivityEvent } from '@/lib/data'
import { cn } from '@/lib/utils'

function formatActivityListDate(date: Date): string {
  return `${date.toLocaleDateString(undefined, { weekday: 'long', month: 'long' })} ${getOrdinalDay(date.getDate())}`
}

export function ActivityDetail() {
  const { knives } = useKnives()
  const [recordedActivity, setRecordedActivity] =
    useState<KnifeActivityEvent[]>()
  const [now] = useState(() => new Date())

  useEffect(() => {
    let cancelled = false

    async function loadActivity() {
      try {
        const response = await fetch('/api/activity', { cache: 'no-store' })
        const data = await readJsonResponse<{
          activity?: KnifeActivityEvent[]
        }>(response)
        if (!cancelled && response.ok && Array.isArray(data.activity)) {
          setRecordedActivity(data.activity)
        }
      } catch {
        // Fall back to addition-only activity derived from knives.
      }
    }

    void loadActivity()
    return () => {
      cancelled = true
    }
  }, [])

  const stats = useMemo(
    () => createCollectionStats(knives, 'all', now, recordedActivity),
    [knives, now, recordedActivity],
  )
  const knivesById = useMemo(
    () => new Map(knives.map((knife) => [knife.id, knife])),
    [knives],
  )
  const activityWeeks = useMemo(
    () =>
      Array.from({ length: 52 }, (_, index) =>
        stats.activity.slice(index * 7, index * 7 + 7),
      ),
    [stats.activity],
  )
  const maxActivityCount = Math.max(
    1,
    ...stats.activity.map(({ count }) => count),
  )
  const activeDays = useMemo(
    () =>
      [...stats.activity]
        .filter(({ count }) => count > 0)
        .sort((left, right) => right.date.getTime() - left.date.getTime()),
    [stats.activity],
  )

  const resolveKnives = (ids: string[]) =>
    ids
      .map((id) => knivesById.get(id))
      .filter((knife): knife is Knife => Boolean(knife))

  return (
    <div className="space-y-8">
      <div className="overflow-x-auto pb-2">
        <div className="min-w-[42rem]">
          <div className="ml-8 grid grid-cols-[repeat(52,minmax(0,1fr))] gap-[3px] text-[8px] text-muted-foreground">
            {activityWeeks.map((week, index) => {
              const month = week[0]?.date.getMonth()
              const previousMonth =
                activityWeeks[index - 1]?.[0]?.date.getMonth()
              return (
                <span key={week[0]?.dateKey}>
                  {index === 0 || month !== previousMonth
                    ? week[0]?.date.toLocaleDateString(undefined, {
                        month: 'short',
                      })
                    : ''}
                </span>
              )
            })}
          </div>
          <div className="mt-2 grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2">
            <div className="grid grid-rows-7 gap-[3px] text-[8px] leading-[11px] text-muted-foreground">
              <span>Mon</span>
              <span />
              <span>Wed</span>
              <span />
              <span>Fri</span>
              <span />
              <span>Sun</span>
            </div>
            <div className="flex gap-[3px]">
              {activityWeeks.map((week) => (
                <div
                  key={week[0]?.dateKey}
                  className="grid flex-1 grid-rows-7 gap-[3px]"
                >
                  {week.map((day) => {
                    const level =
                      day.count === 0
                        ? 0
                        : Math.max(
                            1,
                            Math.ceil((day.count / maxActivityCount) * 4),
                          )
                    const activityLabel = formatActivityDayLabel(
                      day.date,
                      day.addedCount,
                      day.editedCount,
                      day.maintainedCount,
                    )
                    return (
                      <Tooltip key={day.dateKey}>
                        <TooltipTrigger
                          type="button"
                          aria-label={activityLabel}
                          onClick={() => {
                            if (!day.count) return
                            const element = document.getElementById(
                              `activity-${day.dateKey}`,
                            )
                            element?.scrollIntoView({
                              behavior: 'smooth',
                              block: 'start',
                            })
                          }}
                          className={cn(
                            'h-[11px] min-w-[10px] rounded-[2px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            day.count === 0 && 'bg-muted',
                            level === 1 && 'bg-[#b7bd86] dark:bg-[#66552c]',
                            level === 2 && 'bg-[#79824a] dark:bg-[#947535]',
                            level === 3 && 'bg-[#4f5821] dark:bg-[#b78d36]',
                            level === 4 && 'bg-[#2e3417] dark:bg-[#c89c3d]',
                          )}
                        />
                        <TooltipContent
                          sideOffset={8}
                          className="whitespace-nowrap border border-[var(--bladevault-line)] bg-[#f7f1e5] text-sm font-semibold text-[var(--bladevault-olive)] shadow-[0_8px_24px_rgba(46,52,23,0.14)] [&>[aria-hidden=true]]:bg-[#f7f1e5] [&>[aria-hidden=true]]:fill-[#f7f1e5]"
                        >
                          {activityLabel}
                        </TooltipContent>
                      </Tooltip>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-3 text-[9px] text-muted-foreground">
        <span>Last 52 weeks</span>
        <span className="flex items-center gap-1">
          Less
          <i className="size-2.5 rounded-[2px] bg-muted" />
          <i className="size-2.5 rounded-[2px] bg-[#b7bd86] dark:bg-[#66552c]" />
          <i className="size-2.5 rounded-[2px] bg-[#79824a] dark:bg-[#947535]" />
          <i className="size-2.5 rounded-[2px] bg-[#4f5821] dark:bg-[#b78d36]" />
          <i className="size-2.5 rounded-[2px] bg-[#2e3417] dark:bg-[#c89c3d]" />
          More
        </span>
      </div>

      {activeDays.length === 0 ? (
        <p className="text-center text-sm text-muted-foreground">
          No activity in the last 52 weeks
        </p>
      ) : (
        <div className="grid gap-6">
          {activeDays.map((day) => {
            const addedKnives = resolveKnives(day.addedKnifeIds)
            const editedKnives = resolveKnives(day.editedKnifeIds)
            const maintainedKnives = resolveKnives(day.maintainedKnifeIds)
            return (
              <section
                key={day.dateKey}
                id={`activity-${day.dateKey}`}
                className="scroll-mt-6"
              >
                <h3 className="text-sm font-semibold">
                  {formatActivityListDate(day.date)}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {formatActivityCounts(
                    day.addedCount,
                    day.editedCount,
                    day.maintainedCount,
                  )}
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {addedKnives.length > 0 && (
                    <div className="grid gap-2">
                      <h4 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                        Added
                      </h4>
                      {addedKnives.map((knife) => (
                        <DrilldownKnife key={knife.id} knife={knife} />
                      ))}
                    </div>
                  )}
                  {editedKnives.length > 0 && (
                    <div className="grid gap-2">
                      <h4 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                        Edited
                      </h4>
                      {editedKnives.map((knife) => (
                        <DrilldownKnife key={knife.id} knife={knife} />
                      ))}
                    </div>
                  )}
                  {maintainedKnives.length > 0 && (
                    <div className="grid gap-2">
                      <h4 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                        Maintained
                      </h4>
                      {maintainedKnives.map((knife) => (
                        <DrilldownKnife key={knife.id} knife={knife} />
                      ))}
                    </div>
                  )}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
