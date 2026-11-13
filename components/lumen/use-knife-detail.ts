'use client'

import { useEffect, useState } from 'react'
import type { Knife } from '@/lib/data'

/**
 * Loads a knife's full record (description and every photo). Collection
 * summaries only carry the first photo, so detail views start from the
 * summary and switch to the full record once it arrives.
 */
export function useKnifeDetail(summary: Knife | null | undefined) {
  const id = summary?.id
  const [state, setState] = useState<{ id: string; knife: Knife } | null>(null)

  useEffect(() => {
    if (!id) return
    const controller = new AbortController()
    void fetch(`/api/knives/${encodeURIComponent(id)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return
        const data = (await response.json()) as { knife?: Knife }
        if (data.knife) setState({ id, knife: data.knife })
      })
      .catch(() => {
        // Keep showing the summary if the full record cannot load.
      })
    return () => controller.abort()
  }, [id, summary?.updatedAt])

  if (!summary) return null
  const full = state?.id === summary.id ? state.knife : null
  // Pin, sold and edits come from the summary, which the provider keeps current.
  return full
    ? {
        ...full,
        ...summary,
        description: full.description,
        images: full.images,
      }
    : summary
}
