import type { KeyboardEvent } from 'react'
import { GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'

export const COLUMN_RESIZE_HANDLE_WIDTH = 24

/**
 * Vertical drag handle between two grid columns. Owns pointer capture and
 * keyboard input; the parent owns the size and reports it through aria values.
 * Hidden below `lg`, where layouts collapse to a single column.
 */
export function ColumnResizeHandle({
  label,
  controls,
  valueNow,
  valueMin,
  valueMax,
  valueText,
  onResizeStart,
  onPointerX,
  onResizeEnd,
  onStep,
  onHome,
  onEnd,
  onReset,
  className,
}: {
  label: string
  controls?: string
  valueNow: number
  valueMin: number
  valueMax: number
  valueText?: string
  onResizeStart?: () => void
  /** Called with the pointer's clientX while dragging. */
  onPointerX: (clientX: number) => void
  onResizeEnd?: () => void
  /** Arrow keys: -1 for left, +1 for right; `large` when Shift is held. */
  onStep: (direction: -1 | 1, large: boolean) => void
  onHome: () => void
  onEnd: () => void
  onReset: () => void
  className?: string
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowLeft':
        onStep(-1, event.shiftKey)
        break
      case 'ArrowRight':
        onStep(1, event.shiftKey)
        break
      case 'Home':
        onHome()
        break
      case 'End':
        onEnd()
        break
      default:
        return
    }
    event.preventDefault()
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-controls={controls}
      aria-valuemin={Math.round(valueMin)}
      aria-valuemax={Math.round(valueMax)}
      aria-valuenow={Math.round(valueNow)}
      aria-valuetext={valueText}
      title="Drag or use Left/Right arrows to resize. Double-click to reset."
      className={cn(
        'group relative hidden cursor-col-resize touch-none select-none justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset lg:flex',
        className,
      )}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.setPointerCapture(event.pointerId)
        onResizeStart?.()
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        onPointerX(event.clientX)
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        onResizeEnd?.()
      }}
      onPointerCancel={() => onResizeEnd?.()}
      onLostPointerCapture={() => onResizeEnd?.()}
    >
      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--bladevault-line)] group-hover:bg-primary group-focus-visible:bg-primary" />
      <span className="pointer-events-none sticky top-24 mt-12 flex h-10 w-4 items-center justify-center rounded-full border border-[var(--bladevault-line)] bg-background text-muted-foreground group-hover:border-primary group-hover:text-primary group-focus-visible:border-primary group-focus-visible:text-primary">
        <GripVertical className="size-3.5" />
      </span>
    </div>
  )
}
