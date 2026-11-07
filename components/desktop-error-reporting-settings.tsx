'use client'

import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { SettingsRow, SettingsSection } from '@/components/settings-panels'

const DOCS_URL =
  'https://github.com/dedkola/bladevault/blob/main/docs/reference/error-reporting.md'

// Desktop-only opt-in for crash and error reports. Off by default; the choice
// is stored by the Electron main process and applies after a restart.
export function DesktopErrorReportingSettings() {
  const [status, setStatus] = useState<BladeVaultErrorReportingStatus | null>(
    null,
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const bridge = window.bladevaultDesktop?.errorReporting
    if (!bridge) return

    let active = true
    bridge
      .get()
      .then((next) => {
        if (active) setStatus(next)
      })
      .catch(() => {
        if (active) setError('Could not load the error reporting setting.')
      })
    return () => {
      active = false
    }
  }, [])

  if (!status) {
    return error ? (
      <SettingsSection title="Error reporting">
        <SettingsRow label="Send error reports" description={error} />
      </SettingsSection>
    ) : null
  }

  async function handleToggle(enabled: boolean) {
    const bridge = window.bladevaultDesktop?.errorReporting
    if (!bridge) return
    setPending(true)
    setError('')
    try {
      setStatus(await bridge.set(enabled))
    } catch {
      setError('Could not save the error reporting setting.')
    } finally {
      setPending(false)
    }
  }

  async function handleRestart() {
    setPending(true)
    try {
      await window.bladevaultDesktop?.errorReporting?.restart()
    } catch {
      setPending(false)
      setError('Could not restart BladeVault. Quit and reopen it instead.')
    }
  }

  return (
    <SettingsSection title="Error reporting">
      <SettingsRow
        label="Send error reports"
        description={
          status.available ? (
            <>
              Sends crash and error details to the BladeVault developer through
              Sentry. Your knives, images, notes, and backups are never
              included.{' '}
              <a
                href={DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                What is sent
              </a>
            </>
          ) : (
            'Not available in this build.'
          )
        }
      >
        {status.available ? (
          <Checkbox
            checked={status.enabled}
            disabled={pending}
            onCheckedChange={(checked) => void handleToggle(checked === true)}
            aria-label="Send error reports"
          />
        ) : null}
      </SettingsRow>
      {status.available && status.restartRequired ? (
        <SettingsRow
          label="Restart required"
          description={
            status.enabled
              ? 'Error reporting starts after BladeVault restarts.'
              : 'Error reporting stops after BladeVault restarts.'
          }
        >
          <Button
            type="button"
            variant="outline"
            className="rounded-lg"
            onClick={() => void handleRestart()}
            disabled={pending}
          >
            <RefreshCw />
            Restart now
          </Button>
        </SettingsRow>
      ) : null}
      {error ? (
        <p role="alert" className="py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsSection>
  )
}
