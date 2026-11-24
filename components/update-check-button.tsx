'use client'

import { useSyncExternalStore } from 'react'
import { CircleArrowDown, Loader2 } from 'lucide-react'
import { useKnives } from '@/components/providers/knives-provider'
import { useDesktopUpdates } from '@/hooks/use-desktop-updates'

const subscribeNoop = () => () => {}

/**
 * Desktop-only footer button that checks GitHub for a newer release. When one
 * is available the icon takes the theme accent and shows a small dot; the next
 * click downloads it (or restarts to install an updater-managed download).
 */
export function UpdateCheckButton() {
  const isDesktop = useSyncExternalStore(
    subscribeNoop,
    () => Boolean(window.bladevaultDesktop),
    () => false,
  )
  const { showFeedback } = useKnives()
  const { update, checkForUpdates, downloadUpdate, installUpdate } =
    useDesktopUpdates()

  if (!isDesktop) return null

  const isBusy =
    update.status === 'checking' ||
    update.status === 'downloading' ||
    update.status === 'installing'
  // Manual installers (macOS DMG, Linux deb) are handed off to the OS, so only
  // updater-managed downloads (Windows, Linux AppImage) restart in place.
  const canInstall = update.status === 'downloaded' && !update.path
  const hasUpdate = update.status === 'available' || canInstall

  const label =
    update.status === 'checking'
      ? 'Checking for updates…'
      : update.status === 'downloading'
        ? `Downloading update${update.percent != null ? ` (${update.percent}%)` : '…'}`
        : update.status === 'installing'
          ? 'Installing update…'
          : update.status === 'available'
            ? `Download BladeVault ${update.version ?? 'update'}`
            : canInstall
              ? 'Restart BladeVault to install the update'
              : 'Check for updates'

  const handleClick = async () => {
    if (isBusy) return
    try {
      if (canInstall) {
        await installUpdate()
        return
      }
      if (update.status === 'available') {
        await downloadUpdate()
        return
      }
      const status = await checkForUpdates()
      if (status?.status === 'not-available') {
        showFeedback('BladeVault is up to date.', 'success')
      } else if (status?.status === 'error') {
        showFeedback(status.message || 'Could not check for updates.', 'error')
      }
    } catch {
      showFeedback(
        update.status === 'available'
          ? 'Could not download the update. Try again.'
          : 'Could not check for updates. Try again.',
        'error',
      )
    }
  }

  return (
    <button
      type="button"
      data-update-check
      data-update-available={hasUpdate ? '' : undefined}
      onClick={() => void handleClick()}
      disabled={isBusy}
      aria-label={label}
      title={label}
    >
      {isBusy ? (
        <Loader2 className="motion-safe:animate-spin" />
      ) : (
        <CircleArrowDown />
      )}
      {hasUpdate && !isBusy && <span data-update-dot aria-hidden="true" />}
    </button>
  )
}
