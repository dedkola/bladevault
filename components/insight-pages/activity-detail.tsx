'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import {
  formatActivityCounts,
  formatActivityDayLabel,
} from '@/components/collection-insights'
import { useKnives } from '@/components/providers/knives-provider'
import {
  InsightMetrics,
  InsightPanel,
  InsightRecordPreview,
  type InsightSelection,
} from '@/components/insight-pages/detail-primitives'
import { readJsonResponse } from '@/lib/api-response'
import { createCollectionStats } from '@/lib/collection-stats'
import { type KnifeActivityEvent } from '@/lib/data'

export function ActivityDetail() {
  const { knives } = useKnives(),
    [recordedActivity, setRecordedActivity] = useState<KnifeActivityEvent[]>(),
    [failed, setFailed] = useState(false),
    [now] = useState(() => new Date()),
    [selection, setSelection] = useState<InsightSelection | null>(null)
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const response = await fetch('/api/activity', { cache: 'no-store' })
        const data = await readJsonResponse<{
          activity?: KnifeActivityEvent[]
        }>(response)
        if (!response.ok || !Array.isArray(data.activity))
          throw new Error('Activity unavailable')
        if (!cancelled) setRecordedActivity(data.activity)
      } catch {
        if (!cancelled) setFailed(true)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])
  const stats = useMemo(
    () => createCollectionStats(knives, 'all', now, recordedActivity),
    [knives, now, recordedActivity],
  )
  const byId = useMemo(
    () => new Map(knives.map((knife) => [knife.id, knife])),
    [knives],
  )
  const active = [...stats.activity].filter((day) => day.count).reverse(),
    max = Math.max(1, ...stats.activity.map((day) => day.count)),
    colors = ['var(--muted)', '#b7bd86', '#79824a', '#4f5821', '#2e3417']
  const events = useMemo(
    () =>
      recordedActivity
        ? [...recordedActivity]
            .filter((event) => byId.has(event.knifeId))
            .sort(
              (a, b) =>
                new Date(b.occurredAt).getTime() -
                new Date(a.occurredAt).getTime(),
            )
        : undefined,
    [recordedActivity, byId],
  )
  const date = (value: Date | string) =>
    new Date(value).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
  return (
    <div className="id-activity">
      <InsightMetrics
        items={[
          {
            value: stats.additionsInActivityRange,
            label: 'Additions',
            helper: 'Knives added in the last 52 weeks',
          },
          {
            value: stats.editsInActivityRange,
            label: 'Edited knives',
            helper: 'Daily unique edited records, summed',
          },
          {
            value: stats.maintainedKnivesInActivityRange,
            label: 'Maintained knives',
            helper: 'Daily unique maintained records, summed',
          },
        ]}
      />
      {failed && (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          Recorded activity unavailable. Showing additions from collection
          records. Reload to try again.
        </p>
      )}
      <InsightPanel
        title="Activity calendar"
        description={`${stats.activeDays} active days · last 52 weeks`}
        footer={
          <>
            <span>Last 52 weeks</span>
            <span className="id-legend">
              Less{' '}
              {colors.map((color) => (
                <i key={color} style={{ background: color }} />
              ))}{' '}
              More
            </span>
          </>
        }
      >
        <div
          className="id-heatmap-wrap"
          role="region"
          aria-label="Activity calendar; scroll to see all weeks"
          tabIndex={0}
        >
          <div className="id-heatmap-inner">
            <div className="id-months" aria-hidden="true">
              {Array.from({ length: 52 }, (_, index) => {
                const day = stats.activity[index * 7],
                  previous = stats.activity[(index - 1) * 7]
                return (
                  <span key={day.dateKey}>
                    {!previous ||
                    day.date.getMonth() !== previous.date.getMonth()
                      ? day.date.toLocaleDateString(undefined, {
                          month: 'short',
                        })
                      : ''}
                  </span>
                )
              })}
            </div>
            <div className="id-heatmap">
              {stats.activity.map((day) => (
                <button
                  key={day.dateKey}
                  type="button"
                  className="id-day"
                  aria-label={formatActivityDayLabel(
                    day.date,
                    day.addedCount,
                    day.editedCount,
                    day.maintainedCount,
                  )}
                  title={formatActivityDayLabel(
                    day.date,
                    day.addedCount,
                    day.editedCount,
                    day.maintainedCount,
                  )}
                  style={{
                    background:
                      colors[
                        day.count
                          ? Math.max(1, Math.ceil((day.count / max) * 4))
                          : 0
                      ],
                  }}
                  onClick={() => {
                    if (day.count)
                      setSelection({
                        title: `${date(day.date)} · activity`,
                        knifeIds: day.knifeIds,
                      })
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </InsightPanel>
      <div className="id-grid id-two id-bottom">
        <InsightPanel
          title="Active days"
          description={`${active.length} days · select a date to inspect matching knives`}
        >
          <div className="id-scroll">
            {active.length ? (
              active.map((day) => (
                <div className="id-activity-day" key={day.dateKey}>
                  <button
                    type="button"
                    onClick={() =>
                      setSelection({
                        title: `${date(day.date)} · activity`,
                        knifeIds: day.knifeIds,
                      })
                    }
                  >
                    <strong>{date(day.date)}</strong>
                    <span>{day.count} knives ›</span>
                  </button>
                  <p>
                    {formatActivityCounts(
                      day.addedCount,
                      day.editedCount,
                      day.maintainedCount,
                    )}
                  </p>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                No activity in the last 52 weeks
              </p>
            )}
          </div>
        </InsightPanel>
        <InsightPanel
          title="Recorded events"
          description={
            events
              ? `${events.length} events · newest first`
              : 'Original activity history'
          }
        >
          <div className="id-scroll">
            {events?.length ? (
              events.map((event, index) => {
                const knife = byId.get(event.knifeId)!
                return (
                  <div
                    className="id-activity-day"
                    key={`${event.knifeId}-${event.occurredAt}-${event.type}-${index}`}
                  >
                    <Link
                      href={`/collection/${encodeURIComponent(knife.id)}`}
                      className="id-event-row"
                    >
                      <strong>
                        {knife.brand} · {knife.name}
                      </strong>
                      <span className="id-pill">
                        {event.type === 'created'
                          ? 'Added'
                          : event.type === 'updated'
                            ? 'Edited'
                            : 'Maintained'}
                      </span>
                    </Link>
                    <p>
                      <time dateTime={event.occurredAt}>
                        {new Date(event.occurredAt).toLocaleString()}
                      </time>
                    </p>
                  </div>
                )
              })
            ) : (
              <p className="text-sm text-muted-foreground">
                {failed
                  ? 'Recorded history unavailable.'
                  : events
                    ? 'No recorded events.'
                    : 'Loading recorded history…'}
              </p>
            )}
          </div>
        </InsightPanel>
      </div>
      <InsightRecordPreview
        selection={selection}
        onClose={() => setSelection(null)}
      />
    </div>
  )
}
