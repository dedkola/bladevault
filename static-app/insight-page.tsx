'use client'

import {
  INSIGHT_CATEGORY_SLUGS,
  isInsightCategorySlug,
  isInsightSlug,
  isMeasurementKey,
} from '@/lib/insight-stats'
import { ActivityDetail } from '@/components/insight-pages/activity-detail'
import { CategoryDetail } from '@/components/insight-pages/category-detail'
import { CompletenessDetail } from '@/components/insight-pages/completeness-detail'
import { InsightDetailShell } from '@/components/insight-pages/insight-detail-shell'
import { LibraryDetail } from '@/components/insight-pages/library-detail'
import { MeasurementDetail } from '@/components/insight-pages/measurement-detail'
import { RecentDetail } from '@/components/insight-pages/recent-detail'
import { useSearchParams } from './navigation'

export function InsightPage({ slug }: { slug: string }) {
  const tab = useSearchParams().get('tab')
  if (!isInsightSlug(slug)) return <div className="p-8">Insight not found.</div>
  const titles = {
    library: 'Collection library',
    makers: 'Makers',
    'blade-steels': 'Blade steels',
    'blade-shapes': 'Blade shapes',
    locks: 'Lock types',
    'handle-materials': 'Handle materials',
    designers: 'Designers',
    measurements: 'Measurements',
    completeness: 'Data completeness',
    activity: 'Collection activity',
    recent: 'Recently added',
  }
  if (isInsightCategorySlug(slug))
    return (
      <CategoryDetail
        categoryKey={INSIGHT_CATEGORY_SLUGS[slug]}
        title={titles[slug]}
        eyebrow="Collection"
      />
    )
  return (
    <InsightDetailShell title={titles[slug]} eyebrow="Collection">
      {slug === 'library' && <LibraryDetail />}
      {slug === 'measurements' && (
        <MeasurementDetail
          initialTab={tab && isMeasurementKey(tab) ? tab : undefined}
        />
      )}
      {slug === 'completeness' && <CompletenessDetail />}
      {slug === 'activity' && <ActivityDetail />}
      {slug === 'recent' && <RecentDetail />}
    </InsightDetailShell>
  )
}
