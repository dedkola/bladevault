'use client'

import { useEffect, useState } from 'react'
import {
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from '@/components/settings-panels'

// Desktop-only: keep BladeVault in the tray after its window closes, so the
// embedded server and price checks keep running. Off by default; the choice is
// stored by the Electron main process and applies right away.
export function DesktopBackgroundSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const get = window.bladevaultDesktop?.getBackgroundMode
    if (!get) return

    let active = true
    get()
      .then((next) => {
        if (active) setEnabled(next)
      })
      .catch(() => {
        if (active) setError('Could not load the background setting.')
      })
    return () => {
      active = false
    }
  }, [])

  if (enabled === null && !error) return null

  async function handleToggle(next: boolean) {
    const set = window.bladevaultDesktop?.setBackgroundMode
    if (!set) return
    setPending(true)
    setError('')
    try {
      setEnabled(await set(next))
    } catch {
      setError('Could not save the background setting.')
    } finally {
      setPending(false)
    }
  }

  return (
    <SettingsSection title="Desktop app">
      <SettingsRow
        inline
        label="Keep running in the background"
        description="Closing the window keeps BladeVault in the menu bar or system tray, so prices are still checked. Quit it from the tray icon."
      >
        {enabled !== null ? (
          <SettingsSwitch
            aria-label="Keep running in the background"
            checked={enabled}
            disabled={pending}
            onCheckedChange={(checked) => void handleToggle(checked)}
          />
        ) : null}
      </SettingsRow>
      {error ? (
        <p role="alert" className="py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsSection>
  )
}
