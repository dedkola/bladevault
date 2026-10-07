'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  InsightPanel,
  InsightRing,
} from '@/components/insight-pages/detail-primitives'
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
import { missingHref } from '@/components/collection-insights'
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
    <div className="id-completeness">
      <section
        className="id-panel id-health-panel"
        aria-label="Collection data health"
      >
        <div className="id-panel-body id-health-summary">
          <div className="id-health">
            <InsightRing value={stats.completeness} />
            <div>
              <h2>Collection data health</h2>
              <p>
                The score counts populated core fields, not accuracy or
                consistent labels. Country, finish and handle length are
                reviewed separately.
              </p>
            </div>
          </div>
          {summaryTiles.map((tile) => (
            <a key={tile.label} href={tile.href} className="id-health-tile">
              <strong>{tile.value}</strong>
              <span>{tile.label}</span>
              <small>{tile.helper}</small>
            </a>
          ))}
        </div>
      </section>
      <div className="id-grid id-three">
        <InsightPanel
          title="Missing fields"
          description="Includes supplemental fields; a blank can be optional."
          footer={<span>{missingFields.length} fields with gaps</span>}
        >
          <div className="id-scroll">
            {missingFields.length ? (
              missingFields.map((field) => {
                const percent = stats.total
                  ? Math.round((field.count / stats.total) * 100)
                  : 0
                return (
                  <Link
                    key={field.key}
                    href={missingHref(field.key)}
                    className="id-missing-row"
                  >
                    <div>
                      <span>{field.label} missing</span>
                      <strong>
                        {field.count} · {percent}%
                      </strong>
                    </div>
                    <div className="id-track" aria-hidden="true">
                      <span
                        className="id-fill"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  </Link>
                )
              })
            ) : (
              <p className="text-sm text-muted-foreground">
                All reviewed fields populated
              </p>
            )}
          </div>
        </InsightPanel>
        <InsightPanel
          id="measurement-review"
          title="Measurement review"
          description="Counts represent field values, not unique knives."
          footer={
            <Link href="/insights/measurements">
              See measurement distributions →
            </Link>
          }
        >
          {queue && (
            <div className="mb-3 rounded-md bg-muted p-3">
              <p className="text-xs">
                {
                  cleanupMeasurements.find(
                    (field) => field.key === queue.field,
                  )!.label
                }{' '}
                review · {queue.index} of {queue.entries.length} reviewed
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
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
          <table className="id-review-table">
            <caption className="sr-only">Measurement review queues</caption>
            <thead>
              <tr>
                <th scope="col">Measurement</th>
                <th scope="col">Missing</th>
                <th scope="col">Uninterpretable</th>
              </tr>
            </thead>
            <tbody>
              {measurements.map((field) => (
                <tr key={field.key}>
                  <th scope="row">{field.label}</th>
                  {(['missing', 'uninterpretable'] as const).map((issue) => (
                    <td key={issue}>
                      <button
                        type="button"
                        disabled={!field[issue].length}
                        aria-label={`Review ${field[issue].length} ${issue} ${field.label.toLowerCase()} values`}
                        onClick={() => startReview(field.key, issue)}
                      >
                        {field[issue].length}
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="id-callout">
            <div>
              <strong>Review the original values</strong>
              <p>
                Select a count to review those knives. Values with units are
                interpreted without rewriting their source text.
              </p>
            </div>
          </div>
        </InsightPanel>
        <InsightPanel
          id="label-consistency"
          title="Field label consistency"
          description="Exact stored variants · select a group to inspect."
          footer={<span>{aliases.length} groups · review before merging</span>}
        >
          <div className="id-scroll">
            {aliases.length ? (
              aliases.map((group) => (
                <button
                  type="button"
                  key={group.key}
                  className="id-alias"
                  aria-label={`Review labels for ${group.field.label.toLowerCase()}: ${group.values.map((item) => item.value).join(', ')}`}
                  onClick={() => setAlias(group)}
                >
                  <small>
                    {group.field.label} ·{' '}
                    {group.values.reduce(
                      (n, item) => n + item.knives.length,
                      0,
                    )}{' '}
                    knives
                  </small>
                  <strong>{group.suggestedValue}</strong>
                  <p>
                    {group.values.map((item) => (
                      <span className="id-pill" key={item.value}>
                        {item.value} <b>{item.knives.length}</b>
                      </span>
                    ))}
                  </p>
                  <span className="sr-only">Review labels</span>
                </button>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                No case, whitespace or known spelling variants found across the
                eight fields.
              </p>
            )}
            <details className="mt-4 text-xs">
              <summary className="cursor-pointer font-medium">
                Source review
                {combinedSteelKnives.length
                  ? ` · ${combinedSteelKnives.length} combined steel labels`
                  : ''}
              </summary>
              <p className="mt-2 text-muted-foreground">
                Label matching cannot verify facts such as country of
                manufacture. Compare each knife’s source and saved notes before
                editing.
              </p>
              {combinedSteelKnives.length ? (
                <>
                  <p className="mt-2">
                    {combinedSteelKnives.length}{' '}
                    {combinedSteelKnives.length === 1
                      ? 'knife has'
                      : 'knives have'}{' '}
                    hardness information in the blade material field.
                  </p>
                  {combinedSteelKnives.map((knife) => (
                    <Link
                      className="id-alias"
                      key={knife.id}
                      href={`/collection/${encodeURIComponent(knife.id)}`}
                    >
                      <strong>
                        {knife.brand} {knife.name}
                      </strong>
                      <p>{knife.specs.bladeMaterial}</p>
                      <span>Review source and fields →</span>
                    </Link>
                  ))}
                </>
              ) : (
                <p className="mt-2 text-muted-foreground">
                  No hardness information found in blade material labels.
                </p>
              )}
              <Link className="mt-3 inline-block underline" href="/collection">
                Browse collection for source review
              </Link>
            </details>
          </div>
        </InsightPanel>
      </div>
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
