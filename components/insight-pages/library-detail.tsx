'use client'

import { useMemo } from 'react'
import { InsightsChart } from '@/components/insights-chart'
import { getLibraryOption } from '@/components/collection-insights'
import { useKnives } from '@/components/providers/knives-provider'
import { Card, CardContent } from '@/components/ui/card'
import { createCollectionStats } from '@/lib/collection-stats'

export function LibraryDetail() {
  const { knives } = useKnives()
  const stats = useMemo(() => createCollectionStats(knives, 'all'), [knives])

  const metrics = [
    { label: 'Total knives', value: stats.total },
    { label: 'Added this year', value: stats.addedThisYear },
    { label: 'Pinned', value: stats.pinnedCount },
  ]

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Card className="flex items-center justify-center">
        <CardContent className="flex flex-col items-center p-5">
          <InsightsChart
            buildOption={(palette) => getLibraryOption(stats.total, palette)}
            ariaLabel={`${stats.total} knives catalogued`}
            className="h-40 w-40"
          />
        </CardContent>
      </Card>

      {metrics.map((metric) => (
        <Card key={metric.label}>
          <CardContent className="flex h-full flex-col justify-center p-5">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              {metric.label}
            </span>
            <p className="mt-2 text-4xl font-semibold tabular-nums tracking-tight">
              {metric.value}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
