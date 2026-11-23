'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { COLUMN_RESIZE_HANDLE_WIDTH } from '@/components/column-resize-handle'
import { readJsonResponse, getApiErrorMessage } from '@/lib/api-response'
import {
  KNIFE_DETAIL_PANEL_MAX,
  KNIFE_DETAIL_PANEL_MIN,
  normalizeKnifeDetailPanelWidth,
} from '@/lib/settings-shared'

/** Narrowest the gallery column may get while dragging. */
const MIN_GALLERY_WIDTH = 420
const SAVE_DELAY_MS = 300
/** Matches the `lg` CSS default; used only for the separator's aria value. */
const DEFAULT_PANEL_WIDTH = 380

async function savePanelWidth(width: number | null) {
  const response = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ knifeDetailPanelWidth: width }),
  })
  if (!response.ok) {
    const data = await readJsonResponse<{ error?: string }>(response)
    throw new Error(
      getApiErrorMessage(data, 'Could not save the knife detail panel width'),
    )
  }
}

/**
 * Width of the info panel beside the knife gallery. `null` keeps the
 * responsive default from CSS; a number is the user's dragged width, saved to
 * the vault settings so it survives reloads and restarts.
 */
export function useKnifeDetailPanelWidth(
  gridRef: RefObject<HTMLDivElement | null>,
  initialWidth: number | null,
) {
  const [width, setWidth] = useState<number | null>(initialWidth)
  const [isResizing, setIsResizing] = useState(false)
  const widthRef = useRef(width)
  const saveTimerRef = useRef<number | null>(null)
  const dirtyRef = useRef(false)

  const flushSave = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    if (!dirtyRef.current) return
    dirtyRef.current = false
    savePanelWidth(widthRef.current).catch((error) => {
      console.warn('Could not save knife detail panel width', error)
    })
  }, [])

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = window.setTimeout(flushSave, SAVE_DELAY_MS)
  }, [flushSave])

  // Save a pending change when leaving the page mid-debounce.
  useEffect(() => flushSave, [flushSave])

  /** Largest width that still leaves the gallery its minimum. */
  const getMaxWidth = useCallback(() => {
    const gridWidth = gridRef.current?.getBoundingClientRect().width ?? 0
    const roomy = gridWidth - COLUMN_RESIZE_HANDLE_WIDTH - MIN_GALLERY_WIDTH
    return Math.max(
      KNIFE_DETAIL_PANEL_MIN,
      Math.min(KNIFE_DETAIL_PANEL_MAX, roomy),
    )
  }, [gridRef])

  /** The panel's rendered width, which covers the CSS default when unset. */
  const getRenderedWidth = useCallback(() => {
    const grid = gridRef.current
    if (!grid) return widthRef.current ?? KNIFE_DETAIL_PANEL_MIN
    const columns = getComputedStyle(grid).gridTemplateColumns.split(' ')
    const last = Number.parseFloat(columns[columns.length - 1] ?? '')
    return Number.isFinite(last)
      ? last
      : (widthRef.current ?? KNIFE_DETAIL_PANEL_MIN)
  }, [gridRef])

  const applyWidth = useCallback(
    (next: number | null, { save }: { save: boolean }) => {
      const normalized =
        next === null
          ? null
          : normalizeKnifeDetailPanelWidth(
              Math.min(next, getMaxWidth()),
              widthRef.current,
            )
      if (normalized === widthRef.current) return
      widthRef.current = normalized
      setWidth(normalized)
      if (save) scheduleSave()
    },
    [getMaxWidth, scheduleSave],
  )

  /** Adopt a value loaded later (static app); never overrides a user drag. */
  const adoptSavedWidth = useCallback((saved: unknown) => {
    if (dirtyRef.current) return
    const normalized = normalizeKnifeDetailPanelWidth(saved, null)
    widthRef.current = normalized
    setWidth(normalized)
  }, [])

  const handleProps = {
    valueMin: KNIFE_DETAIL_PANEL_MIN,
    valueMax: KNIFE_DETAIL_PANEL_MAX,
    valueNow: width ?? DEFAULT_PANEL_WIDTH,
    valueText: width === null ? 'Default width' : `${width} pixels`,
    onResizeStart: () => setIsResizing(true),
    onResizeEnd: () => {
      setIsResizing(false)
      flushSave()
    },
    onPointerX: (clientX: number) => {
      const bounds = gridRef.current?.getBoundingClientRect()
      if (!bounds) return
      // Keep dragging local; the save is queued and flushed on release.
      applyWidth(bounds.right - clientX - COLUMN_RESIZE_HANDLE_WIDTH / 2, {
        save: true,
      })
    },
    onStep: (direction: -1 | 1, large: boolean) => {
      // Dragging left widens the panel, which sits on the right.
      const step = large ? 64 : 16
      applyWidth(getRenderedWidth() - direction * step, { save: true })
    },
    onHome: () => applyWidth(getMaxWidth(), { save: true }),
    onEnd: () => applyWidth(KNIFE_DETAIL_PANEL_MIN, { save: true }),
    onReset: () => applyWidth(null, { save: true }),
  }

  return { width, isResizing, handleProps, adoptSavedWidth }
}
