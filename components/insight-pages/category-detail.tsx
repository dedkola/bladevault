'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import { categoryHref, missingHref } from '@/components/collection-insights'
import { useKnives } from '@/components/providers/knives-provider'
import { InsightDetailShell } from '@/components/insight-pages/insight-detail-shell'
import {
  DirectoryArrow,
  InsightBars,
  InsightMetrics,
  InsightPanel,
} from '@/components/insight-pages/detail-primitives'
import { createCollectionStats, type CategoryKey } from '@/lib/collection-stats'

const LABELS: Record<CategoryKey, { singular: string; plural: string }> = {
  brand: { singular: 'maker', plural: 'makers' },
  bladeMaterial: { singular: 'blade steel', plural: 'steels' },
  bladeStyle: { singular: 'blade shape', plural: 'profiles' },
  lockingMechanism: { singular: 'lock type', plural: 'lock types' },
  handleMaterial: { singular: 'handle material', plural: 'materials' },
  designer: { singular: 'designer', plural: 'designers' },
}

export function CategoryDetail({
  categoryKey,
  title,
  eyebrow = 'Collection',
}: {
  categoryKey: CategoryKey
  title: string
  eyebrow?: string
}) {
  const { knives } = useKnives()
  const stats = useMemo(() => createCollectionStats(knives, 'all'), [knives])
  const categories = stats.categories[categoryKey],
    labels = LABELS[categoryKey]
  const known = categories.reduce((n, c) => n + c.count, 0),
    missing = stats.total - known,
    leader = categories[0],
    top = categories.slice(0, 8),
    topCount = top.reduce((n, c) => n + c.count, 0)
  return (
    <InsightDetailShell
      eyebrow={eyebrow}
      title={title}
      description={`${categories.length} distinct ${categories.length === 1 ? labels.singular : labels.plural} across your collection.`}
    >
      <div className="id-category">
        <InsightMetrics
          items={[
            {
              value: categories.length,
              label: 'Distinct categories',
              helper: 'Represented in your collection',
            },
            {
              value: leader?.count ?? 0,
              label: leader?.name ?? 'No recorded values',
              helper: `${leader?.percent ?? 0}% of the entire collection`,
            },
            {
              value: known,
              label: 'Knives with a value',
              helper: `${missing} not set · ${stats.total ? Math.round((known / stats.total) * 100) : 0}% coverage`,
            },
          ]}
        />
        <div className="id-grid id-category-grid">
          <InsightPanel
            title="Distribution"
            ariaLabel={`${title} distribution`}
            description="Eight most common categories · share of the full collection"
            footer={
              <>
                <span>
                  Top eight: {topCount} knives ·{' '}
                  {stats.total ? Math.round((topCount / stats.total) * 100) : 0}
                  %
                </span>
                <span>Bars scaled to the leading count</span>
              </>
            }
          >
            <InsightBars categories={top} categoryKey={categoryKey} />
            {!top.length && <p>No recorded categories yet.</p>}
          </InsightPanel>
          <InsightPanel
            title="Full distribution"
            ariaLabel={`All ${labels.plural}`}
            description={`${categories.length} categories · select a row to see matching knives`}
            footer={
              <>
                <span>
                  {known} with a value · {missing} not set
                </span>
                <Link href="/insights/completeness">Review completeness →</Link>
              </>
            }
          >
            <div className="id-table-caption">
              <span>Rank · category</span>
              <span>Count · share of collection</span>
            </div>
            <div className="id-directory id-scroll">
              {categories.map((category, index) => {
                const content = (
                  <>
                    <span className="id-rank">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="id-directory-name">{category.name}</span>
                    <strong>{category.count}</strong>
                    <span className="id-share">{category.percent}%</span>
                    <DirectoryArrow />
                  </>
                )
                const href = categoryHref(categoryKey, category)
                return href ? (
                  <Link
                    key={category.name}
                    href={href}
                    className="id-directory-row"
                  >
                    {content}
                  </Link>
                ) : (
                  <div key={category.name} className="id-directory-row">
                    {content}
                  </div>
                )
              })}
            </div>
            {categoryKey === 'designer' && missing > 0 && (
              <Link
                className="id-directory-row"
                href={missingHref(categoryKey)}
              >
                <span className="id-rank">—</span>
                <span>Not set</span>
                <strong>{missing}</strong>
                <span className="id-share">
                  {Math.round((missing / stats.total) * 100)}%
                </span>
                <DirectoryArrow />
              </Link>
            )}
          </InsightPanel>
        </div>
        <div className="id-callout">
          <strong>Missing values</strong>
          <p>
            {missing} {missing === 1 ? 'knife has' : 'knives have'} no{' '}
            {labels.singular} recorded. Shares include all {stats.total} knives.
          </p>
          <Link href={missingHref(categoryKey)}>View {missing} knives →</Link>
        </div>
      </div>
    </InsightDetailShell>
  )
}
