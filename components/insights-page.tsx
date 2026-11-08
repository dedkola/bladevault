'use client'

import { isModernThemeFamily } from '@/lib/settings-shared'
import { CollectionInsights } from '@/components/collection-insights'
import { ModernInsights } from '@/components/modern-insights'
import { useKnives } from '@/components/providers/knives-provider'

export function InsightsPage() {
  const { themeStyle } = useKnives()

  return isModernThemeFamily(themeStyle) || themeStyle === 'alloy' ? (
    <ModernInsights />
  ) : (
    <CollectionInsights />
  )
}
