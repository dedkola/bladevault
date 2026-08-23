'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import { InsightsChart } from '@/components/insights-chart'
import {
  categoryHref,
  getHorizontalBarOption,
  missingHref,
} from '@/components/collection-insights'
import { useKnives } from '@/components/providers/knives-provider'
import { createCollectionStats, type CategoryKey } from '@/lib/collection-stats'

export function CategoryDetail({
  categoryKey,
  title,
}: {
  categoryKey: CategoryKey
  title: string
}) {
  const { knives } = useKnives()
  const stats = useMemo(() => createCollectionStats(knives, 'all'), [knives])
  const categories = stats.categories[categoryKey]
  const notSet =
    categoryKey === 'designer'
      ? stats.missingFields.find(({ key }) => key === 'designer')
      : undefined

  return (
    <div className="space-y-6">
      {categories.length > 0 && (
        <InsightsChart
          buildOption={(palette) => getHorizontalBarOption(categories, palette)}
          ariaLabel={`${title} distribution`}
          className="h-72 w-full"
        />
      )}

      <div className="grid gap-1">
        {categories.map((category, index) => {
          const href = categoryHref(categoryKey, category)
          const content = (
            <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-2.5 text-sm transition-colors hover:bg-muted">
              <span className="font-serif text-muted-foreground">
                {String(index + 1).padStart(2, '0')}
              </span>
              <strong className="truncate">{category.name}</strong>
              <span className="text-xs text-muted-foreground">
                {category.count} · {category.percent}%
              </span>
            </div>
          )

          return href ? (
            <Link
              key={category.name}
              href={href}
              className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {content}
            </Link>
          ) : (
            <div
              key={category.name}
              className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {content}
            </div>
          )
        })}

        {notSet ? (
          <Link
            href={missingHref('designer')}
            className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-2.5 text-sm transition-colors hover:bg-muted">
              <span className="font-serif text-muted-foreground">—</span>
              <strong className="truncate text-muted-foreground">
                Not set
              </strong>
              <span className="text-xs text-muted-foreground">
                {notSet.count}
              </span>
            </div>
          </Link>
        ) : null}
      </div>
    </div>
  )
}
