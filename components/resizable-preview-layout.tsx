'use client'

import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'

const DIVIDER_WIDTH = 24
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
          <div
            role="separator"
            tabIndex={0}
            aria-label="Knife form width"
            aria-orientation="vertical"
            aria-controls={formPaneId}
            aria-valuemin={Math.round(minShare)}
            aria-valuemax={Math.round(maxShare)}
            aria-valuenow={Math.round(visibleShare)}
            aria-valuetext={`${Math.round(visibleShare)}% form, ${Math.round(100 - visibleShare)}% preview`}
            title="Drag or use Left/Right arrows to resize. Double-click to reset."
            className="group relative hidden cursor-col-resize touch-none select-none justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset lg:flex"
            onDoubleClick={() => setFormShare(DEFAULT_FORM_SHARE)}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 10 : 2
              switch (event.key) {
                case 'ArrowLeft':
                  resize(visibleShare - step)
                  break
                case 'ArrowRight':
                  resize(visibleShare + step)
                  break
                case 'Home':
                  resize(minShare)
                  break
                case 'End':
                  resize(maxShare)
                  break
                default:
                  return
              }
              event.preventDefault()
            }}
            onPointerDown={(event) => {
              if (event.button !== 0 || !event.isPrimary) return
              event.preventDefault()
              event.currentTarget.focus({ preventScroll: true })
              event.currentTarget.setPointerCapture(event.pointerId)
              setIsResizing(true)
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId))
                return
              const bounds = layoutRef.current?.getBoundingClientRect()
              if (!bounds || bounds.width <= DIVIDER_WIDTH) return
              resize(
                ((event.clientX - bounds.left - DIVIDER_WIDTH / 2) /
                  (bounds.width - DIVIDER_WIDTH)) *
                  100,
              )
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId)
              }
              setIsResizing(false)
            }}
            onPointerCancel={() => setIsResizing(false)}
            onLostPointerCapture={() => setIsResizing(false)}
          >
            <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--bladevault-line)] group-hover:bg-primary group-focus-visible:bg-primary" />
            <span className="pointer-events-none sticky top-24 mt-12 flex h-10 w-4 items-center justify-center rounded-full border border-[var(--bladevault-line)] bg-background text-muted-foreground group-hover:border-primary group-hover:text-primary group-focus-visible:border-primary group-focus-visible:text-primary">
              <GripVertical className="size-3.5" />
            </span>
          </div>
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
