'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { useKnives } from '@/components/providers/knives-provider'
import {
  InsightBars,
  InsightKnifeRow,
  InsightMetrics,
  InsightPanel,
  InsightRecordPreview,
  InsightRing,
  type InsightSelection,
} from '@/components/insight-pages/detail-primitives'
import { createCollectionStats } from '@/lib/collection-stats'

export function LibraryDetail() {
  const { knives } = useKnives()
  const stats = useMemo(() => createCollectionStats(knives, 'all'), [knives])
  const [selection, setSelection] = useState<InsightSelection | null>(null)
  const months = useMemo(() => {
    const values = new Map<string, { label: string; knifeIds: string[] }>()
    for (const knife of knives) {
      const date = new Date(knife.addedAt)
      if (!Number.isFinite(date.getTime())) continue
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      const entry = values.get(key) ?? {
        label: date.toLocaleDateString(undefined, {
          month: 'short',
          year: '2-digit',
        }),
        knifeIds: [],
      }
      entry.knifeIds.push(knife.id)
      values.set(key, entry)
    }
    return [...values.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key, ...value }))
  }, [knives])
  const pinned = knives.filter((knife) => knife.pinned),
    recent = useMemo(
      () =>
        [...knives]
          .sort(
            (a, b) =>
              new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime(),
          )
          .slice(0, 6),
      [knives],
    )
  const max = Math.max(1, ...months.map((m) => m.knifeIds.length))
  return (
    <div className="id-library">
      <InsightMetrics
        items={[
          {
            value: stats.total,
            label: 'Total knives',
            helper: 'Your complete collection',
          },
          {
            value: stats.addedThisYear,
            label: 'Added this year',
            helper: 'Based on each record’s added date',
          },
          {
            value: stats.pinnedCount,
            label: 'Pinned',
            helper: 'Quick access to your favorites',
          },
        ]}
      />
      <div className="id-grid id-three">
        <InsightPanel
          title="Collection coverage"
          description="Core fields populated"
          footer={
            <Link href="/insights/completeness">Open data completeness →</Link>
          }
        >
          <div className="id-health">
            <InsightRing value={stats.completeness} />
            <div>
              <h2>Collection data health</h2>
              <p>
                Core field coverage is {stats.completeness}%. Measurement
                accuracy and label consistency are reviewed separately.
              </p>
            </div>
          </div>
        </InsightPanel>
        <InsightPanel
          title="Additions by month"
          description="All collection records · original added dates"
        >
          <div className="overflow-x-auto">
            <div className="id-growth" style={{ minWidth: months.length * 55 }}>
              {months.map((month) => (
                <button
                  key={month.key}
                  type="button"
                  className="id-growth-item"
                  aria-label={`${month.label}: ${month.knifeIds.length} knives added`}
                  onClick={() =>
                    setSelection({
                      title: `Added in ${month.label}`,
                      knifeIds: month.knifeIds,
                    })
                  }
                >
                  <strong>{month.knifeIds.length}</strong>
                  <i
                    aria-hidden="true"
                    style={{
                      height: `${(month.knifeIds.length / max) * 130}px`,
                    }}
                  />
                  <span>{month.label}</span>
                </button>
              ))}
            </div>
          </div>
        </InsightPanel>
        <InsightPanel
          title="Maker overview"
          description={`${stats.categories.brand.length} makers represented`}
          footer={<Link href="/insights/makers">All makers →</Link>}
        >
          <InsightBars
            categories={stats.categories.brand.slice(0, 4)}
            categoryKey="brand"
          />
        </InsightPanel>
      </div>
      <div className="id-grid id-two id-bottom">
        <InsightPanel
          title="Pinned knives"
          description={`${pinned.length} pinned records`}
        >
          <div className="id-scroll">
            {pinned.length ? (
              pinned.map((knife) => (
                <InsightKnifeRow key={knife.id} knife={knife} />
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                No pinned knives yet.
              </p>
            )}
          </div>
        </InsightPanel>
        <InsightPanel
          title="Latest additions"
          description="Six most recently added knives"
          footer={
            <Link href="/insights/recent">
              Browse all {stats.total} additions →
            </Link>
          }
        >
          <div className="id-scroll">
            {recent.map((knife) => (
              <InsightKnifeRow key={knife.id} knife={knife} />
            ))}
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
