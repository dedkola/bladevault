'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Cloud, CloudOff, Moon, Settings, Sun } from 'lucide-react'
import { useKnives } from '@/components/providers/knives-provider'
import { readJsonResponse } from '@/lib/api-response'
import { SETTINGS_UPDATED_EVENT, type AppSettings } from '@/lib/settings-shared'

/**
 * Classic keeps its workspace shortcuts in the footer instead of the sidebar,
 * so the full-width bar carries the same controls as the rest of the shell.
 */
export function ClassicFooterActions() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { isAutoBackupActive, showFeedback } = useKnives()
  const isSettingsActive = pathname === '/settings'
  const isCloudBackupSettingsActive =
    isSettingsActive && searchParams.get('tab') === 'backup'

  const toggleTheme = async () => {
    const root = document.documentElement
    const nextIsDark = !root.classList.contains('dark')

    root.classList.toggle('dark', nextIsDark)

    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          theme: nextIsDark ? 'dark' : 'light',
        } satisfies Pick<AppSettings, 'theme'>),
      })

      const data = await readJsonResponse<{ error?: string }>(response)
      if (!response.ok) {
        throw new Error(data.error || 'Failed to save theme preference')
      }

      window.dispatchEvent(
        new CustomEvent<Partial<AppSettings>>(SETTINGS_UPDATED_EVENT, {
          detail: { theme: nextIsDark ? 'dark' : 'light' },
        }),
      )
    } catch (error) {
      root.classList.toggle('dark', !nextIsDark)
      showFeedback('Could not save the appearance preference.', 'error')
      console.error('Failed to save theme preference', error)
    }
  }

  return (
    <div data-workspace-footer-actions>
      <button
        type="button"
        data-footer-action
        onClick={toggleTheme}
        aria-label="Toggle color theme"
        title="Toggle light and dark mode"
      >
        <Sun className="dark:hidden" />
        <Moon className="hidden dark:block" />
      </button>

      <Link
        href="/settings"
        data-footer-action
        aria-label="Settings"
        data-active={isSettingsActive ? '' : undefined}
      >
        <Settings />
      </Link>

      <Link
        href="/settings?tab=backup"
        data-footer-action
        aria-label="Cloud backup"
        data-active={isCloudBackupSettingsActive ? '' : undefined}
        title={
          isAutoBackupActive
            ? 'Cloud auto backup is active. Open Cloud backup settings.'
            : 'Cloud auto backup is inactive. Open Cloud backup settings.'
        }
        onClick={() =>
          window.dispatchEvent(
            new Event('bladevault:open-cloud-backup-settings'),
          )
        }
      >
        {isAutoBackupActive ? (
          <Cloud style={{ stroke: 'url(#classic-footer-cloud-gradient)' }} />
        ) : (
          <CloudOff />
        )}
      </Link>

      <svg
        width="0"
        height="0"
        aria-hidden="true"
        focusable="false"
        style={{ position: 'absolute', width: 0, height: 0 }}
      >
        <defs>
          <linearGradient
            id="classic-footer-cloud-gradient"
            x1="0%"
            y1="0%"
            x2="100%"
            y2="100%"
          >
            <stop offset="0%" stopColor="#e2c86e" />
            <stop offset="55%" stopColor="#c89c3d" />
            <stop offset="100%" stopColor="#9e6e1b" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  )
}
