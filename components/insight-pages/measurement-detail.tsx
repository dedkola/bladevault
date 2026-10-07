'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { formatMetric } from '@/components/collection-insights'
import { useKnives } from '@/components/providers/knives-provider'
import {
  InsightPanel,
  InsightRecordPreview,
  type InsightSelection,
} from '@/components/insight-pages/detail-primitives'
import {
  createCollectionStats,
  type MeasurementKey,
} from '@/lib/collection-stats'

export function MeasurementDetail({
  initialTab,
}: {
  initialTab?: MeasurementKey
}) {
  const { knives } = useKnives(),
    stats = useMemo(() => createCollectionStats(knives, 'all'), [knives])
  const [selection, setSelection] = useState<InsightSelection | null>(null)
  return (
    <>
      <div className="id-grid id-two">
        {Object.values(stats.measurements).map((measurement) => {
          const max = Math.max(1, ...measurement.bins.map((bin) => bin.count))
          return (
            <InsightPanel
              key={measurement.key}
              id={`measurement-${measurement.key}`}
              title={measurement.label}
              ariaLabel={`${measurement.label} distribution`}
              className={
                initialTab === measurement.key
                  ? 'id-selected-measurement'
                  : undefined
              }
              description={`${measurement.knownCount} interpreted · ${measurement.missingCount} missing · ${measurement.uninterpretableCount} unreadable`}
            >
              <dl className="id-measurement-summary">
                {[
                  { label: 'Min', value: measurement.min },
                  { label: 'Q1', value: measurement.q1 },
                  { label: 'Median', value: measurement.median },
                  { label: 'Q3', value: measurement.q3 },
                  { label: 'Max', value: measurement.max },
                ].map((item) => (
                  <div key={item.label}>
                    <dt>{item.label}</dt>
                    <dd>{formatMetric(item.value, measurement.unit)}</dd>
                  </div>
                ))}
              </dl>
              {measurement.knownCount ? (
                <div
                  className="id-histogram"
                  aria-label={`${measurement.label} ranges`}
                >
                  {measurement.bins.map((bin) => (
                    <button
                      key={bin.label}
                      type="button"
                      className="id-bin"
                      disabled={!bin.count}
                      aria-label={`${measurement.label} ${bin.label}: ${bin.count} knives`}
                      onClick={() =>
                        setSelection({
                          title: `${measurement.label} · ${bin.label}`,
                          knifeIds: bin.knifeIds,
                        })
                      }
                    >
                      <strong>{bin.count}</strong>
                      <i
                        aria-hidden="true"
                        style={{ height: `${(bin.count / max) * 96}px` }}
                      />
                      <span>{bin.label}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  Not enough data
                </p>
              )}
              <p className="id-note">
                Units: {measurement.unit}.{' '}
                {measurement.uninterpretableCount
                  ? `${measurement.uninterpretableCount} populated values excluded because their units cannot be interpreted.`
                  : 'All populated values can be interpreted.'}{' '}
                <Link href="/insights/completeness#measurement-review">
                  Review values →
                </Link>
              </p>
            </InsightPanel>
          )
        })}
      </div>
      <InsightRecordPreview
        selection={selection}
        onClose={() => setSelection(null)}
      />
    </>
  )
}
