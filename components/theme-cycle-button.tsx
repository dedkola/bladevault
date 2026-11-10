'use client'

import { useCallback, useEffect, useRef } from 'react'
import { Palette } from 'lucide-react'
import { useKnives } from '@/components/providers/knives-provider'
import { readJsonResponse } from '@/lib/api-response'
import {
  applyThemeStyleToElement,
  getNextThemeStyle,
  SETTINGS_UPDATED_EVENT,
  THEME_STYLE_NAMES,
  type AppSettings,
  type ThemeStyle,
} from '@/lib/settings-shared'

function applyThemeStyle(themeStyle: ThemeStyle) {
  applyThemeStyleToElement(document.documentElement, themeStyle)
  window.dispatchEvent(
    new CustomEvent<Partial<AppSettings>>(SETTINGS_UPDATED_EVENT, {
      detail: { themeStyle },
    }),
  )
}

/**
 * Cycles through the Modern-family styles plus the default Classic style.
 * Clicks update the shell right away and queue saves so a later click always
 * wins over an earlier response.
 */
export function ThemeCycleButton() {
  const { themeStyle, showFeedback } = useKnives()
  const pendingThemeRef = useRef<ThemeStyle | null>(null)
  const savingThemeRef = useRef(false)
  const savedThemeRef = useRef(themeStyle)
  const nextThemeStyle = getNextThemeStyle(themeStyle)

  useEffect(() => {
    // Keep the fallback in sync when settings change elsewhere, but ignore the
    // optimistic style while one of this button's saves is still pending.
    if (!savingThemeRef.current && pendingThemeRef.current === null) {
      savedThemeRef.current = themeStyle
    }
  }, [themeStyle])

  const savePendingTheme = useCallback(async () => {
    if (savingThemeRef.current) return
    savingThemeRef.current = true

    try {
      while (pendingThemeRef.current) {
        const target = pendingThemeRef.current
        pendingThemeRef.current = null
        const response = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            themeStyle: target,
          } satisfies Partial<AppSettings>),
        })
        const data = await readJsonResponse<{ error?: string }>(response)
        if (!response.ok) {
          throw new Error(data.error || 'Failed to save theme preference')
        }
        savedThemeRef.current = target
      }
    } catch {
      pendingThemeRef.current = null
      applyThemeStyle(savedThemeRef.current)
      showFeedback('Could not save the appearance preference.', 'error')
    } finally {
      savingThemeRef.current = false
    }
  }, [showFeedback])

  const cycleTheme = () => {
    const target = getNextThemeStyle(themeStyle)
    pendingThemeRef.current = target
    applyThemeStyle(target)
    void savePendingTheme()
  }

  return (
    <button
      type="button"
      data-theme-cycle
      onClick={cycleTheme}
      aria-label={`Switch theme. Current: ${THEME_STYLE_NAMES[themeStyle]}. Next: ${THEME_STYLE_NAMES[nextThemeStyle]}.`}
      title={`Switch theme · ${THEME_STYLE_NAMES[themeStyle]} → ${THEME_STYLE_NAMES[nextThemeStyle]}`}
    >
      <Palette />
    </button>
  )
}
