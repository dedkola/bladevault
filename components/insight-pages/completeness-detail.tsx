'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useCleanupQueue } from '@/hooks/use-cleanup-queue'
import {
  cleanupMeasurements,
  cleanupLabelFields,
  getCombinedSteelKnives,
  getLabelAliasGroups,
  measurementIssue,
  type CleanupMeasurementKey,
  type LabelAliasGroup,
  type MeasurementIssue,
} from '@/lib/collection-cleanup'
import { LabelAliasReview } from '@/components/insight-pages/label-alias-review'
import { MeasurementReview } from '@/components/insight-pages/measurement-review'
import { InsightsChart } from '@/components/insights-chart'
import {
  getCompletenessOption,
  missingHref,
} from '@/components/collection-insights'
import { useKnives } from '@/components/providers/knives-provider'
import { createCollectionStats } from '@/lib/collection-stats'
import { getBulkEditFieldValue } from '@/lib/bulk-edit'
import type { BuiltInFilterKey } from '@/lib/collection-filters'

export function CompletenessDetail() {
  const { knives } = useKnives()
  const stats = useMemo(() => createCollectionStats(knives, 'all'), [knives])
  const aliases = useMemo(() => getLabelAliasGroups(knives), [knives])
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
  const combinedSteelKnives = useMemo(
    () => getCombinedSteelKnives(knives),
    [knives],
  )
  const missingFields = useMemo(() => {
    const fields = new Map<
      BuiltInFilterKey,
      {
        key: BuiltInFilterKey
        label: string
        count: number
        knifeIds: string[]
      }
    >(stats.missingFields.map((field) => [field.key, field]))
    for (const field of cleanupLabelFields) {
      const knifeIds = knives
        .filter((knife) => !getBulkEditFieldValue(knife, field.field).trim())
        .map((knife) => knife.id)
      if (knifeIds.length)
        fields.set(field.key, {
          key: field.key,
          label: field.label,
          count: knifeIds.length,
          knifeIds,
        })
    }
    const handleLength = measurements.find(
      (field) => field.key === 'handleLength',
    )!
    if (handleLength.missing.length)
      fields.set('handleLength', {
        key: 'handleLength',
        label: handleLength.label,
        count: handleLength.missing.length,
        knifeIds: handleLength.missing.map((knife) => knife.id),
      })
    return [...fields.values()].sort(
      (a, b) => b.count - a.count || a.label.localeCompare(b.label),
    )
  }, [knives, measurements, stats.missingFields])
  const [alias, setAlias] = useState<LabelAliasGroup | null>(null)
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

  const missingMeasurementValues = measurements.reduce(
    (sum, field) => sum + field.missing.length,
    0,
  )
  const uninterpretableMeasurementValues = measurements.reduce(
    (sum, field) => sum + field.uninterpretable.length,
    0,
  )
  const summaryTiles = [
    {
      label: 'Missing measurement values',
      value: missingMeasurementValues,
      helper: 'field values to fill',
      href: '#measurement-review',
    },
    {
      label: 'Uninterpretable values',
      value: uninterpretableMeasurementValues,
      helper: "units that can't be read",
      href: '#measurement-review',
    },
    {
      label: 'Label groups',
      value: aliases.length,
      helper: 'case or spelling variants',
      href: '#label-consistency',
    },
  ]

  return (
    <div className="space-y-6">
      <section aria-labelledby="completeness-summary-heading">
        <Card className="gap-0 py-0 shadow-sm print:break-inside-avoid">
          <CardContent className="px-5 pb-5 pt-5">
            <div className="flex flex-col items-center gap-6 sm:flex-row sm:gap-8">
              <InsightsChart
                buildOption={(palette) =>
                  getCompletenessOption(stats.completeness, palette)
                }
                ariaLabel={`${stats.completeness}% complete`}
                className="h-40 w-40 sm:h-44 sm:w-44"
              />
              <div className="min-w-0 flex-1 space-y-2 text-center sm:text-left">
                <h2
                  id="completeness-summary-heading"
                  className="font-heading text-lg font-medium"
                >
                  Collection data health
                </h2>
                <p className="text-sm text-muted-foreground">
                  The score counts populated core fields, not accuracy or
                  consistent labels. Country, finish and handle length are
                  reviewed separately.
                </p>
              </div>
            </div>
            <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
              {summaryTiles.map((tile) => (
                <a
                  key={tile.label}
                  href={tile.href}
                  className="flex flex-col gap-1 rounded-lg border p-4 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    {tile.label}
                  </span>
                  <span className="text-2xl font-semibold tabular-nums text-[var(--bladevault-title)]">
                    {tile.value}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {tile.helper}
                  </span>
                </a>
              ))}
            </div>
          </CardContent>
        </Card>
      </section>

      <section
        aria-labelledby="missing-fields-heading"
        className="scroll-mt-20"
      >
        <Card className="gap-0 py-0 shadow-sm print:break-inside-avoid">
          <CardContent className="space-y-3 px-5 pb-5 pt-5">
            <h2
              id="missing-fields-heading"
              className="font-heading text-lg font-medium"
            >
              Missing fields
            </h2>
            <p className="text-sm text-muted-foreground">
              Includes country, finish and handle length even though they do not
              affect the core completeness score. A blank field may be optional
              or not applicable.
            </p>
            {missingFields.length === 0 ? (
              <p className="text-sm font-medium text-muted-foreground">
                All reviewed fields populated
              </p>
            ) : (
              <ul className="grid gap-2">
                {missingFields.map((field) => {
                  const percent =
                    stats.total === 0
                      ? 0
                      : Math.round((field.count / stats.total) * 100)
                  return (
                    <li key={field.key}>
                      <Link
                        href={missingHref(field.key)}
                        className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <div className="rounded-md bg-muted px-4 py-3 transition-colors hover:bg-accent">
                          <div className="flex items-center justify-between text-sm">
                            <span>{field.label} missing</span>
                            <strong className="tabular-nums">
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
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>

      <section
        id="measurement-review"
        aria-labelledby="measurement-review-heading"
        className="scroll-mt-20"
      >
        <Card className="gap-0 py-0 shadow-sm print:break-inside-avoid">
          <CardContent className="space-y-4 px-5 pb-5 pt-5">
            <div className="space-y-1">
              <h2
                id="measurement-review-heading"
                className="font-heading text-lg font-medium"
              >
                Measurement review
              </h2>
              <p className="text-sm text-muted-foreground">
                Fill in blank values and fix entries whose units cannot be read,
                one knife at a time.
              </p>
            </div>
            {queue && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted p-3">
                <p className="text-sm">
                  {
                    cleanupMeasurements.find(
                      (field) => field.key === queue.field,
                    )!.label
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
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setQueue(null)}
                  >
                    End review
                  </Button>
                </div>
              </div>
            )}
            <div className="overflow-x-auto">
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
                      {(['missing', 'uninterpretable'] as const).map(
                        (issue) => (
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
                        ),
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              Measurement counts are field values, not unique knives. Select a
              count to review those knives. Values with units are interpreted
              without rewriting their source text.
            </p>
          </CardContent>
        </Card>
      </section>

      <section
        id="label-consistency"
        aria-labelledby="label-consistency-heading"
        className="scroll-mt-20"
      >
        <Card className="gap-0 py-0 shadow-sm print:break-inside-avoid">
          <CardContent className="space-y-3 px-5 pb-5 pt-5">
            <h2
              id="label-consistency-heading"
              className="font-heading text-lg font-medium"
            >
              Field label consistency
            </h2>
            {aliases.length ? (
              <ul className="space-y-2 text-sm">
                {aliases.map((group) => (
                  <li
                    key={group.key}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted p-3"
                  >
                    <p className="min-w-0 break-words">
                      <span className="font-medium">{group.field.label}: </span>
                      {group.values
                        .map((item) => `${item.value} (${item.knives.length})`)
                        .join(' · ')}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Review labels for ${group.field.label.toLowerCase()}: ${group.values.map((item) => item.value).join(', ')}`}
                      onClick={() => setAlias(group)}
                    >
                      Review labels
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No case, whitespace or known spelling variants found across the
                eight fields.
              </p>
            )}
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="source-review-heading" className="scroll-mt-20">
        <Card className="gap-0 py-0 shadow-sm print:break-inside-avoid">
          <CardContent className="space-y-3 px-5 pb-5 pt-5">
            <h2
              id="source-review-heading"
              className="font-heading text-lg font-medium"
            >
              Source review
            </h2>
            <p className="text-sm text-muted-foreground">
              Label matching cannot verify facts such as country of manufacture.
              Open a knife to compare its source and saved notes, then use Edit
              to correct the fields individually.
            </p>
            {combinedSteelKnives.length ? (
              <>
                <p className="text-sm font-medium">
                  {combinedSteelKnives.length}{' '}
                  {combinedSteelKnives.length === 1
                    ? 'knife has'
                    : 'knives have'}{' '}
                  hardness information in the blade material field.
                </p>
                <ul className="space-y-2 text-sm">
                  {combinedSteelKnives.map((knife) => (
                    <li
                      key={knife.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted p-3"
                    >
                      <span className="min-w-0 break-words">
                        {knife.brand} {knife.name} · {knife.specs.bladeMaterial}
                      </span>
                      <Link
                        href={`/collection/${encodeURIComponent(knife.id)}`}
                        className="shrink-0 underline underline-offset-4"
                      >
                        Review source and fields
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No hardness information found in blade material labels.
              </p>
            )}
            <Link
              href="/collection"
              className="inline-block text-sm underline underline-offset-4"
            >
              Browse collection for source review
            </Link>
          </CardContent>
        </Card>
      </section>

      {alias && (
        <LabelAliasReview group={alias} onClose={() => setAlias(null)} />
      )}
      {queue && (
        <MeasurementReview
          queue={queue}
          open={reviewOpen}
          onOpenChange={setReviewOpen}
          onQueueChange={setQueue}
        />
      )}
    </div>
  )
}
