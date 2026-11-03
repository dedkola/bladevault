'use client'

import { useEffect, useRef, type MouseEvent } from 'react'
import type { Knife } from '@/lib/data'

export function useCollectionItemNavigation(
  onOpen?: (knife: Knife) => void,
  onOpenDetail?: (knife: Knife) => void,
) {
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelPreview = () => {
    if (previewTimer.current !== null) {
      clearTimeout(previewTimer.current)
      previewTimer.current = null
    }
  }

  useEffect(
    () => () => {
      if (previewTimer.current !== null) clearTimeout(previewTimer.current)
    },
    [],
  )

  return {
    onClick(event: MouseEvent, knife: Knife) {
      cancelPreview()
      if (!onOpenDetail || event.detail === 0) {
        onOpen?.(knife)
      } else if (event.detail === 1) {
        // A narrow-screen preview can cover the item before the second click.
        previewTimer.current = setTimeout(() => {
          previewTimer.current = null
          onOpen?.(knife)
        }, 500)
      }
    },
    onDoubleClick(knife: Knife) {
      cancelPreview()
      onOpenDetail?.(knife)
    },
  }
}
