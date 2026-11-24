'use client'

import { useEffect, useState } from 'react'
import { SettingsRow, SettingsSwitch } from '@/components/settings-panels'

// Desktop-only: native system notifications for price drops and restocks.
// The choice is stored by the Electron main process; an older desktop build
// (or the web app) has no bridge for it, so nothing renders there.
export function DesktopNotificationSettings() {
  const [notify, setNotify] =
    useState<BladeVaultPriceNotificationStatus | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const get = window.bladevaultDesktop?.getPriceNotifications
    if (!get) return
    let active = true
    get()
      .then((next) => {
        if (active) setNotify(next)
      })
      .catch(() => {
        if (active) setError('Could not load the notification setting.')
      })
    return () => {
      active = false
    }
  }, [])

  if (!notify && !error) return null

  async function handleToggle(next: boolean) {
    const set = window.bladevaultDesktop?.setPriceNotifications
    if (!set) return
    setPending(true)
    setError('')
    try {
      setNotify(await set(next))
    } catch {
      setError('Could not save the notification setting.')
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      {notify ? (
        <SettingsRow
          inline
          label="Desktop notifications for price drops"
          description={
            notify.supported
              ? 'While the window is hidden, minimized or in the tray, price drops and restocks that reach the Inbox also show as system notifications. Clicking one opens the knife’s Market tab.'
              : 'This system does not support desktop notifications.'
          }
        >
          <SettingsSwitch
            aria-label="Desktop notifications for price drops"
            checked={notify.enabled}
            disabled={pending || !notify.supported}
            onCheckedChange={(checked) => void handleToggle(checked)}
          />
        </SettingsRow>
      ) : null}
      {error ? (
        <p role="alert" className="py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </>
  )
}
