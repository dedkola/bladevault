import { notFound } from 'next/navigation'
import {
  isInsightCategorySlug,
  isInsightSlug,
  isMeasurementKey,
  INSIGHT_CATEGORY_SLUGS,
  type InsightSlug,
} from '@/lib/insight-stats'
import { ActivityDetail } from '@/components/insight-pages/activity-detail'
import { CategoryDetail } from '@/components/insight-pages/category-detail'
import { CompletenessDetail } from '@/components/insight-pages/completeness-detail'
import { InsightDetailShell } from '@/components/insight-pages/insight-detail-shell'
import { LibraryDetail } from '@/components/insight-pages/library-detail'
import { MeasurementDetail } from '@/components/insight-pages/measurement-detail'
import { RecentDetail } from '@/components/insight-pages/recent-detail'

const SLUG_META: Record<
  InsightSlug,
  { eyebrow: string; title: string; description?: string }
> = {
  library: {
    eyebrow: 'Library',
    title: 'Collection library',
    description: 'Totals, yearly additions, and pinned count.',
  },
  makers: {
    eyebrow: 'Brands',
    title: 'Makers',
    description: 'Full brand distribution across your collection.',
  },
  'blade-steels': {
    eyebrow: 'Materials',
    title: 'Blade steels',
    description: 'Full blade material distribution.',
  },
  'blade-shapes': {
    eyebrow: 'Profiles',
    title: 'Blade shapes',
    description: 'Full blade style distribution.',
  },
  locks: {
    eyebrow: 'Construction',
    title: 'Lock types',
    description: 'Full locking mechanism distribution.',
  },
  'handle-materials': {
    eyebrow: 'Construction',
    title: 'Handle materials',
    description: 'Full handle material distribution.',
  },
  designers: {
    eyebrow: 'People',
    title: 'Designers',
    description: 'Full designer distribution.',
  },
  measurements: {
    eyebrow: 'Dimensions',
    title: 'Measurements',
    description:
      'Full distributions for blade length, overall length, blade thickness, and weight.',
  },
  completeness: {
    eyebrow: 'Collection health',
    title: 'Data completeness',
    description: 'Every missing field across the collection.',
  },
  activity: {
    eyebrow: 'Activity',
    title: 'Collection activity',
    description: 'Full 52-week activity heatmap and daily lists.',
  },
  recent: {
    eyebrow: 'Latest',
    title: 'Recently added',
    description: 'Recently added knives.',
  },
}

export default async function InsightStatPage({
  params,
  searchParams,
}: {
  params: Promise<{ stat: string }>
  searchParams?: Promise<{
    [key: string]: string | string[] | undefined
  }>
}) {
  const { stat } = await params

  if (!isInsightSlug(stat)) {
    notFound()
  }

  const query = searchParams ? await searchParams : {}
  const tabParam = query.tab
  const initialTab =
    typeof tabParam === 'string' && isMeasurementKey(tabParam)
      ? tabParam
      : undefined

  const meta = SLUG_META[stat]

  return (
    <InsightDetailShell
      eyebrow={meta.eyebrow}
      title={meta.title}
      description={meta.description}
    >
      {stat === 'library' && <LibraryDetail />}
      {stat === 'measurements' && <MeasurementDetail initialTab={initialTab} />}
      {stat === 'completeness' && <CompletenessDetail />}
      {stat === 'activity' && <ActivityDetail />}
      {stat === 'recent' && <RecentDetail />}
      {isInsightCategorySlug(stat) && (
        <CategoryDetail
          categoryKey={INSIGHT_CATEGORY_SLUGS[stat]}
          title={meta.title}
        />
      )}
    </InsightDetailShell>
  )
}
