'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Cloud, CloudOff, Settings } from 'lucide-react'
import { CareInboxBell } from '@/components/care-inbox'
import { useKnives } from '@/components/providers/knives-provider'
import { ThemeModeButton } from '@/components/theme-mode-button'
import { getThemeFamily, hasFixedColorMode } from '@/lib/settings-shared'

/**
 * Workspace shortcuts at the right end of the shared footer in every style: the
 * Inbox bell, Cloud backup, Settings and, for styles that offer both modes,
 * the light/dark toggle.
 */
export function FooterActions() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { isAutoBackupActive, themeStyle } = useKnives()
  const isClassic = getThemeFamily(themeStyle) === 'classic'
  const isSettingsActive = pathname === '/settings'
  const isCloudBackupSettingsActive =
    isSettingsActive && searchParams.get('tab') === 'backup'

  return (
    <div data-workspace-footer-actions>
      <CareInboxBell data-footer-action="" popupSide="top" popupAlign="end" />

      <Link
        href="/settings?tab=backup"
        data-footer-action
        data-backup={isAutoBackupActive ? 'on' : 'off'}
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
          <Cloud
            style={
              isClassic
                ? { stroke: 'url(#classic-footer-cloud-gradient)' }
                : undefined
            }
          />
        ) : (
          <CloudOff />
        )}
      </Link>

      <Link
        href="/settings"
        data-footer-action
        aria-label="Settings"
        aria-current={isSettingsActive ? 'page' : undefined}
        data-active={isSettingsActive ? '' : undefined}
      >
        <Settings />
      </Link>

      {/* Light-only and dark-only styles have no other mode to switch to. */}
      {!hasFixedColorMode(themeStyle) && (
        <ThemeModeButton data-footer-action="" />
      )}

      {isClassic && (
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
      )}
    </div>
  )
}
