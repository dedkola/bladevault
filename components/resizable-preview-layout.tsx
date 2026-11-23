'use client'

import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import {
  ColumnResizeHandle,
  COLUMN_RESIZE_HANDLE_WIDTH,
} from '@/components/column-resize-handle'

const DIVIDER_WIDTH = COLUMN_RESIZE_HANDLE_WIDTH
const MIN_PANE_WIDTH = 320
const DEFAULT_FORM_SHARE = 25

export function ResizablePreviewLayout({
  children,
  preview,
}: {
  children: ReactNode
  preview?: ReactNode
}) {
  const layoutRef = useRef<HTMLDivElement>(null)
  const formPaneId = useId()
  const [layoutWidth, setLayoutWidth] = useState(0)
  const [formShare, setFormShare] = useState(DEFAULT_FORM_SHARE)
  const [isResizing, setIsResizing] = useState(false)
  const hasPreview = Boolean(preview)
  const availableWidth = Math.max(0, layoutWidth - DIVIDER_WIDTH)
  const minShare = availableWidth
    ? Math.min(50, Math.max(25, (MIN_PANE_WIDTH / availableWidth) * 100))
    : 25
  const maxShare = 100 - minShare
  const visibleShare = Math.min(maxShare, Math.max(minShare, formShare))

  useEffect(() => {
    const layout = layoutRef.current
    if (!layout || !hasPreview) return

    const observer = new ResizeObserver(([entry]) => {
      setLayoutWidth(entry.contentRect.width)
    })
    observer.observe(layout)
    return () => observer.disconnect()
  }, [hasPreview])

  const resize = (share: number) => {
    setFormShare(Math.min(maxShare, Math.max(minShare, share)))
  }

  return (
    <div
      ref={layoutRef}
      className={cn(
        'grid min-h-0 flex-1 grid-cols-1 gap-6',
        hasPreview && 'lg:grid-cols-[var(--preview-columns)] lg:gap-x-0',
        isResizing && 'cursor-col-resize select-none',
      )}
      style={
        {
          '--preview-columns': `minmax(0, ${visibleShare}fr) ${DIVIDER_WIDTH}px minmax(0, ${100 - visibleShare}fr)`,
        } as CSSProperties
      }
    >
      <div
        id={formPaneId}
        className="flex min-h-0 min-w-0 flex-col space-y-4 overflow-y-auto pr-1"
      >
        {children}
      </div>

      {hasPreview && (
        <>
          <ColumnResizeHandle
            label="Knife form width"
            controls={formPaneId}
            valueMin={minShare}
            valueMax={maxShare}
            valueNow={visibleShare}
            valueText={`${Math.round(visibleShare)}% form, ${Math.round(100 - visibleShare)}% preview`}
            onReset={() => setFormShare(DEFAULT_FORM_SHARE)}
            onStep={(direction, large) =>
              resize(visibleShare + direction * (large ? 10 : 2))
            }
            onHome={() => resize(minShare)}
            onEnd={() => resize(maxShare)}
            onResizeStart={() => setIsResizing(true)}
            onResizeEnd={() => setIsResizing(false)}
            onPointerX={(clientX) => {
              const bounds = layoutRef.current?.getBoundingClientRect()
              if (!bounds || bounds.width <= DIVIDER_WIDTH) return
              resize(
                ((clientX - bounds.left - DIVIDER_WIDTH / 2) /
                  (bounds.width - DIVIDER_WIDTH)) *
                  100,
              )
            }}
          />
          <div className="relative min-h-0 min-w-0">
            {preview}
            {isResizing && (
              <div
                aria-hidden="true"
                className="absolute inset-0 z-10 cursor-col-resize"
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}
