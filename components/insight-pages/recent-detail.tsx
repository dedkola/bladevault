'use client'

import { useMemo } from 'react'
import { RecentKnife } from '@/components/collection-insights'
import { useKnives } from '@/components/providers/knives-provider'

export function RecentDetail() {
  const { knives } = useKnives()
  const recent = useMemo(
    () =>
      [...knives].sort(
        (left, right) =>
          new Date(right.addedAt).getTime() - new Date(left.addedAt).getTime(),
      ),
    [knives],
  )

  return (
    <div className="grid gap-1">
      {recent.map((knife) => (
        <RecentKnife key={knife.id} knife={knife} />
      ))}
    </div>
  )
}
