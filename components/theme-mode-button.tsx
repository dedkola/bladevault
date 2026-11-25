'use client'

import { useSyncExternalStore } from 'react'
import { Moon, Sun } from 'lucide-react'
import { useKnives } from '@/components/providers/knives-provider'
import { readJsonResponse } from '@/lib/api-response'
import {
  applyThemeModeToElement,
  SETTINGS_UPDATED_EVENT,
  type AppSettings,
  type AppTheme,
} from '@/lib/settings-shared'

function subscribeToRootClass(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  })
  return () => observer.disconnect()
}

function isRootDark() {
  return document.documentElement.classList.contains('dark')
}

/**
 * Light/dark toggle in the shared footer. Switches the root
 * right away, saves the mode, and switches back if the save fails.
 */
export function ThemeModeButton(
  props: Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    'type' | 'onClick' | 'aria-label' | 'title' | 'children'
  >,
) {
  const { showFeedback } = useKnives()
  // One icon at a time: the footer forces its icons to display:block, so
  // CSS-based hiding can't be used to swap them.
  const isDark = useSyncExternalStore(
    subscribeToRootClass,
    isRootDark,
    () => false,
  )

  async function toggleMode() {
    const root = document.documentElement
    const previous: AppTheme = root.classList.contains('dark')
      ? 'dark'
      : 'light'
    const theme: AppTheme = previous === 'dark' ? 'light' : 'dark'
    applyThemeModeToElement(root, theme)
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme } satisfies Partial<AppSettings>),
      })
      const data = await readJsonResponse<{ error?: string }>(response)
      if (!response.ok)
        throw new Error(data.error || 'Failed to save theme preference')
      window.dispatchEvent(
        new CustomEvent<Partial<AppSettings>>(SETTINGS_UPDATED_EVENT, {
          detail: { theme },
        }),
      )
    } catch {
      applyThemeModeToElement(root, previous)
      showFeedback('Could not save the appearance preference.', 'error')
    }
  }

  return (
    <button
      {...props}
      type="button"
      data-theme-mode-toggle
      onClick={toggleMode}
      aria-label="Switch between light and dark"
      title="Light / dark"
    >
      {isDark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
    </button>
  )
}
