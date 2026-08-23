'use client'

import Link from 'next/link'
import { useMemo } from 'react'
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
