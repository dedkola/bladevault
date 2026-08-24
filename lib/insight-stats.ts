import type { CategoryKey, MeasurementKey } from '@/lib/collection-stats'

export const INSIGHT_SLUGS = [
  'library',
  'makers',
  'blade-steels',
  'blade-shapes',
  'locks',
  'handle-materials',
  'designers',
  'measurements',
  'completeness',
  'activity',
  'recent',
] as const

export type InsightSlug = (typeof INSIGHT_SLUGS)[number]

export const INSIGHT_SLUG_SET = new Set<string>(INSIGHT_SLUGS)

export function isInsightSlug(value: string): value is InsightSlug {
  return INSIGHT_SLUG_SET.has(value)
}

export const INSIGHT_CATEGORY_SLUGS = {
  makers: 'brand',
  'blade-steels': 'bladeMaterial',
  'blade-shapes': 'bladeStyle',
  locks: 'lockingMechanism',
  'handle-materials': 'handleMaterial',
  designers: 'designer',
} as const satisfies Record<string, CategoryKey>

export type InsightCategorySlug = keyof typeof INSIGHT_CATEGORY_SLUGS

export function isInsightCategorySlug(
  slug: InsightSlug,
): slug is InsightCategorySlug {
  return slug in INSIGHT_CATEGORY_SLUGS
}

const MEASUREMENT_KEY_VALUES: MeasurementKey[] = [
  'bladeLength',
  'overallLength',
  'weight',
  'bladeThickness',
]

export function isMeasurementKey(value: string): value is MeasurementKey {
  return MEASUREMENT_KEY_VALUES.includes(value as MeasurementKey)
}
