'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import { useCare } from '@/components/providers/care-provider'
import { useKnives } from '@/components/providers/knives-provider'
import { careToneDotClass, careToneTextClass } from '@/components/care-badge'
import {
  CARE_KIND_PARAM,
  CARE_STATUS_LABELS,
  careDueSummary,
  countCareStatuses,
  rankCareAttention,
  type CareStatusLevel,
} from '@/lib/maintenance-due'
import type { CareTrack } from '@/lib/settings-shared'
import { cn } from '@/lib/utils'

/** Bar and legend order: healthy first, then by urgency. */
const SUMMARY_ORDER: CareStatusLevel[] = ['ok', 'due-soon', 'overdue']

/** Collection link for a care level, optionally for one kind of care. */
export function careFilterHref(
  level: CareStatusLevel,
  kind?: CareTrack,
): string {
  const params = new URLSearchParams({ care: level })
  if (kind) params.set(CARE_KIND_PARAM, kind)
  return `/collection?${params}`
}

/** Care counts and the most urgent knives; null while reminders are off. */
export function useCareSummary() {
  const { reminders, statusById, isLoading } = useCare()
  const { knives } = useKnives()
  return useMemo(() => {
    if (!reminders.enabled) return null
    const counts = countCareStatuses(statusById)
    const tracked = SUMMARY_ORDER.reduce((sum, level) => sum + counts[level], 0)
    const knivesById = new Map(knives.map((knife) => [knife.id, knife]))
    const attention = rankCareAttention(statusById).flatMap((status) => {
      const knife = knivesById.get(status.knifeId)
      return knife ? [{ knife, status }] : []
    })
    return { counts, tracked, attention, isLoading }
  }, [reminders.enabled, statusById, knives, isLoading])
}

export function CareStatusBar({
  counts,
  tracked,
  className,
}: {
  counts: Record<CareStatusLevel, number>
  tracked: number
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-muted',
        className,
      )}
    >
      {tracked > 0 &&
        SUMMARY_ORDER.map((level) =>
          counts[level] > 0 ? (
            <span
              key={level}
              className={cn('h-full', careToneDotClass(level))}
              style={{ width: `${(counts[level] / tracked) * 100}%` }}
            />
          ) : null,
        )}
    </span>
  )
}

export function CareStatusLegend({
  counts,
}: {
  counts: Record<CareStatusLevel, number>
}) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
      {SUMMARY_ORDER.map((level) => (
        <li key={level}>
          <Link
            href={careFilterHref(level)}
            className="inline-flex items-center gap-1.5 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              aria-hidden="true"
              className={cn('size-2 rounded-full', careToneDotClass(level))}
            />
            {CARE_STATUS_LABELS[level]}
            <span className="tabular-nums text-foreground">
              {counts[level]}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

/**
 * Compact "Care status" body for the Insights pages: a status bar with its
 * legend, and the knives that need care soonest.
 */
export function CareStatusSummary({ limit = 4 }: { limit?: number }) {
  const summary = useCareSummary()
  if (!summary) return null
  const { counts, tracked, attention, isLoading } = summary

  if (isLoading) {
    return (
      <p role="status" className="py-4 text-xs text-muted-foreground">
        Loading care status…
      </p>
    )
  }

  if (tracked === 0) {
    return (
      <p className="py-4 text-xs text-muted-foreground">
        No knives are tracked yet. Log any maintenance on a knife to start its
        reminders.
      </p>
    )
  }

  return (
    <div data-care-summary className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
      <div className="min-w-0">
        <p className="text-2xl font-semibold tabular-nums tracking-tight">
          {counts.overdue}
          <span className="ml-1.5 text-sm font-normal text-muted-foreground">
            overdue · {counts['due-soon']} due soon
          </span>
        </p>
        <CareStatusBar counts={counts} tracked={tracked} className="my-3" />
        <CareStatusLegend counts={counts} />
      </div>
      <div className="min-w-0">
        {attention.length > 0 ? (
          <ul aria-label="Knives needing care" className="grid">
            {attention.slice(0, limit).map(({ knife, status }) => (
              <li
                key={knife.id}
                className="border-b border-border/70 last:border-b-0"
              >
                <Link
                  href={`/collection/${encodeURIComponent(knife.id)}`}
                  className="flex items-center gap-2.5 rounded-sm py-2 text-xs hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'size-2 shrink-0 rounded-full',
                      careToneDotClass(status.level),
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {knife.brand ? `${knife.brand} ` : ''}
                    {knife.name}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 tabular-nums',
                      careToneTextClass(status.level),
                    )}
                  >
                    {careDueSummary(status)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-2 text-xs text-muted-foreground">
            Nothing is due. Every tracked knife is inside its care interval.
          </p>
        )}
        {attention.length > limit ? (
          <p className="mt-2 text-xs text-muted-foreground">
            +{attention.length - limit} more need care
          </p>
        ) : null}
      </div>
    </div>
  )
}
