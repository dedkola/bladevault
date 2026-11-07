'use client'

import { formatKnifeCount } from '@/lib/knife-count'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { useKnives } from '@/components/providers/knives-provider'
import {
  InsightPanel,
  InsightRecordPreview,
  type InsightSelection,
} from '@/components/insight-pages/detail-primitives'
import {
  createCollectionStats,
  formatStatsMeasurement,
  type MeasurementKey,
} from '@/lib/collection-stats'

export function MeasurementDetail({
  initialTab,
}: {
  initialTab?: MeasurementKey
}) {
  const { knives, dimensionUnit = 'in' } = useKnives()
  const stats = useMemo(
    () =>
      createCollectionStats(knives, 'all', undefined, undefined, dimensionUnit),
    [knives, dimensionUnit],
  )
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
                    <dd>
                      {formatStatsMeasurement(item.value, measurement)
                        .split(' / ')
                        .map((part, index) => (
                          <span className="id-dimension-pair" key={part}>
                            {index > 0 && <span className="sr-only"> / </span>}
                            {part}
                          </span>
                        ))}
                    </dd>
                  </div>
                ))}
              </dl>
              {measurement.knownCount ? (
                <div
                  className="overflow-x-auto pb-3"
                  role="region"
                  aria-label={`${measurement.label} chart; scroll to see all ranges`}
                  tabIndex={0}
                >
                  <div
                    className="id-histogram"
                    aria-label={`${measurement.label} ranges`}
                    style={{
                      minWidth:
                        measurement.dimensionUnit === 'both'
                          ? 900
                          : measurement.dimensionUnit === 'mm'
                            ? 600
                            : undefined,
                    }}
                  >
                    {measurement.bins.map((bin) => (
                      <button
                        key={bin.label}
                        type="button"
                        className="id-bin"
                        disabled={!bin.count}
                        aria-label={`${measurement.label} ${bin.label}: ${formatKnifeCount(bin.count)}`}
                        onClick={() =>
                          setSelection({
                            title: `${measurement.label} · ${bin.label}`,
                            knifeIds: bin.knifeIds,
                          })
                        }
                      >
                        <div className="id-bin-plot">
                          <strong>{bin.count}</strong>
                          <i
                            aria-hidden="true"
                            style={{ height: `${(bin.count / max) * 96}px` }}
                          />
                        </div>
                        <span>{bin.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  Not enough data
                </p>
              )}
              <p className="id-note">
                Units:{' '}
                {measurement.dimensionUnit === 'both'
                  ? measurement.key === 'weight'
                    ? 'g and oz'
                    : 'mm and in'
                  : measurement.unit}
                .{' '}
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
