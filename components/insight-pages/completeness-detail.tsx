'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useCleanupQueue } from '@/hooks/use-cleanup-queue'
import {
  cleanupMeasurements,
  getMaterialAliasGroups,
  measurementIssue,
  type CleanupMeasurementKey,
  type MaterialAliasGroup,
  type MeasurementIssue,
} from '@/lib/collection-cleanup'
import { MaterialAliasReview } from '@/components/insight-pages/material-alias-review'
import { MeasurementReview } from '@/components/insight-pages/measurement-review'
import { InsightsChart } from '@/components/insights-chart'
import {
  getCompletenessOption,
  missingHref,
} from '@/components/collection-insights'
import { useKnives } from '@/components/providers/knives-provider'
import { createCollectionStats } from '@/lib/collection-stats'

export function CompletenessDetail() {
  const { knives } = useKnives()
  const stats = useMemo(() => createCollectionStats(knives, 'all'), [knives])
  const aliases = useMemo(() => getMaterialAliasGroups(knives), [knives])
  const measurements = useMemo(
    () =>
      cleanupMeasurements.map((field) => ({
        ...field,
        missing: knives.filter(
          (knife) =>
            measurementIssue(field.key, knife.specs[field.key] ?? '') ===
            'missing',
        ),
        uninterpretable: knives.filter(
          (knife) =>
            measurementIssue(field.key, knife.specs[field.key] ?? '') ===
            'uninterpretable',
        ),
      })),
    [knives],
  )
  const [alias, setAlias] = useState<MaterialAliasGroup | null>(null)
  const [queue, setQueue] = useCleanupQueue()
  const [reviewOpen, setReviewOpen] = useState(false)
  const startReview = (
    field: CleanupMeasurementKey,
    issue: MeasurementIssue,
  ) => {
    const entries = measurements
      .find((item) => item.key === field)!
      [issue].map(({ id, addedAt }) => ({ id, addedAt }))
    if (!entries.length) return
    setQueue({ field, issue, entries, index: 0, saved: 0, skipped: 0 })
    setReviewOpen(true)
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-center">
        <InsightsChart
          buildOption={(palette) =>
            getCompletenessOption(stats.completeness, palette)
          }
          ariaLabel={`${stats.completeness}% complete`}
          className="h-48 w-48"
        />
      </div>

      <section
        aria-labelledby="cleanup-heading"
        className="space-y-4 rounded-xl border p-4"
      >
        <div className="space-y-1">
          <h2 id="cleanup-heading" className="font-heading text-lg font-medium">
            Guided collection cleanup
          </h2>
          <p className="text-sm text-muted-foreground">
            Completeness counts populated fields. Review measurement readability
            and consistent material labels here.
          </p>
        </div>
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div className="flex items-start justify-between gap-4 sm:block">
            <dt className="text-muted-foreground">Missing measurements</dt>
            <dd className="mt-1 text-lg font-medium">
              {measurements.reduce(
                (sum, field) => sum + field.missing.length,
                0,
              )}
            </dd>
          </div>
          <div className="flex items-start justify-between gap-4 sm:block">
            <dt className="text-muted-foreground">
              Uninterpretable measurements
            </dt>
            <dd className="mt-1 text-lg font-medium">
              {measurements.reduce(
                (sum, field) => sum + field.uninterpretable.length,
                0,
              )}
            </dd>
          </div>
          <div className="flex items-start justify-between gap-4 sm:block">
            <dt className="text-muted-foreground">Label suggestions</dt>
            <dd className="mt-1 text-lg font-medium">{aliases.length}</dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">
          Select a count to review those knives. Values with units are
          interpreted without rewriting their source text.
        </p>
        {queue && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted p-3">
            <p className="text-sm">
              {
                cleanupMeasurements.find((field) => field.key === queue.field)!
                  .label
              }{' '}
              review · {queue.index} of {queue.entries.length} reviewed
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setReviewOpen(true)}
              >
                Resume review
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setQueue(null)}>
                End review
              </Button>
            </div>
          </div>
        )}
        <table className="w-full text-sm">
          <caption className="sr-only">Measurement review queues</caption>
          <thead>
            <tr className="text-left text-muted-foreground">
              <th scope="col" className="pb-2 font-medium">
                Measurement
              </th>
              <th scope="col" className="pb-2 text-center font-medium">
                Missing
              </th>
              <th scope="col" className="pb-2 text-center font-medium">
                Uninterpretable
              </th>
            </tr>
          </thead>
          <tbody>
            {measurements.map((field) => (
              <tr key={field.key} className="border-t">
                <th scope="row" className="py-2 text-left font-medium">
                  {field.label}
                </th>
                {(['missing', 'uninterpretable'] as const).map((issue) => (
                  <td key={issue} className="py-2 text-center">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!field[issue].length}
                      aria-label={`Review ${field[issue].length} ${issue} ${field.label.toLowerCase()} values`}
                      onClick={() => startReview(field.key, issue)}
                    >
                      {field[issue].length}
                      <span className="sr-only"> values</span>
                    </Button>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Handle material labels</h3>
          {aliases.length ? (
            aliases.map((group) => (
              <div
                key={group.key}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted p-3"
              >
                <p className="min-w-0 text-sm break-words">
                  {group.values
                    .map((item) => `${item.value} (${item.knives.length})`)
                    .join(' · ')}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Review labels ${group.values.map((item) => item.value).join(', ')}`}
                  onClick={() => setAlias(group)}
                >
                  Review labels
                </Button>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              No equivalent label variants found.
            </p>
          )}
        </div>
      </section>

      {alias && (
        <MaterialAliasReview group={alias} onClose={() => setAlias(null)} />
      )}
      {queue && (
        <MeasurementReview
          queue={queue}
          open={reviewOpen}
          onOpenChange={setReviewOpen}
          onQueueChange={setQueue}
        />
      )}

      {stats.missingFields.length === 0 ? (
        <p className="text-center text-sm font-medium text-muted-foreground">
          All fields complete
        </p>
      ) : (
        <div className="grid gap-2">
          {stats.missingFields.map((field) => {
            const percent =
              stats.total === 0
                ? 0
                : Math.round((field.count / stats.total) * 100)
            return (
              <Link
                key={field.key}
                href={missingHref(field.key)}
                className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="rounded-md bg-muted px-4 py-3 transition-colors hover:bg-accent">
                  <div className="flex items-center justify-between text-sm">
                    <span>{field.label} missing</span>
                    <strong>
                      {field.count} · {percent}%
                    </strong>
                  </div>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-background">
                    <div
                      className="h-full rounded-full bg-[var(--bladevault-gold)]"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
