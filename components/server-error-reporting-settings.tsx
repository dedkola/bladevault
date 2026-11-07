'use client'

import { useEffect, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { SettingsRow, SettingsSection } from '@/components/settings-panels'
import {
  startBrowserErrorReporting,
  stopBrowserErrorReporting,
} from '@/lib/sentry/client'
import type { ErrorReportingConfig } from '@/lib/sentry/shared'

const DOCS_URL =
  'https://github.com/dedkola/bladevault/blob/main/docs/reference/error-reporting.md'

type Status = {
  mode: 'managed' | 'consent' | 'off'
  consent: 'unset' | 'granted' | 'declined' | null
  config: ErrorReportingConfig | null
}

// Error reporting for the browser and self-hosted servers. Shown only when
// the server can report: with the official image's default DSN (the vault's
// answer decides), or with an operator-set SENTRY_DSN (read-only here).
export function ServerErrorReportingSettings() {
  const [status, setStatus] = useState<Status | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    fetch('/api/settings/error-reporting', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return null
        return (await response.json()) as Status
      })
      .then((next) => {
        if (active && next) setStatus(next)
      })
      .catch(() => {
        // The static preview has no server API; leave the section hidden.
      })
    return () => {
      active = false
    }
  }, [])

  if (!status || status.mode === 'off') return null

  async function handleToggle(enabled: boolean) {
    setPending(true)
    setError('')
    try {
      const response = await fetch('/api/settings/error-reporting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consent: enabled ? 'granted' : 'declined' }),
      })
      if (!response.ok) throw new Error('Could not save.')
      const next = (await response.json()) as Status
      setStatus(next)
      if (next.config) startBrowserErrorReporting(next.config)
      else await stopBrowserErrorReporting()
    } catch {
      setError('Could not save the error reporting setting.')
    } finally {
      setPending(false)
    }
  }

  const whatIsSent = (
    <a
      href={DOCS_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:text-foreground underline underline-offset-2"
    >
      What is sent
    </a>
  )

  return (
    <SettingsSection title="Error reporting">
      {status.mode === 'managed' ? (
        <SettingsRow
          label="Send error reports"
          description={
            <>
              Turned on by this server’s <code>SENTRY_DSN</code> setting. Ask
              the person who runs it to change it. {whatIsSent}
            </>
          }
        />
      ) : (
        <SettingsRow
          label="Send error reports"
          description={
            <>
              Sends crash reports and anonymous usage data, such as which shop
              websites imports fail on, to the BladeVault developer through
              Sentry. This applies to everyone using this BladeVault server.
              Your knives, images, notes, and backups are never included.{' '}
              {whatIsSent}
            </>
          }
        >
          <Checkbox
            checked={status.consent === 'granted'}
            disabled={pending}
            onCheckedChange={(checked) => void handleToggle(checked === true)}
            aria-label="Send error reports"
          />
        </SettingsRow>
      )}
      {error ? (
        <p role="alert" className="text-destructive py-2 text-xs">
          {error}
        </p>
      ) : null}
    </SettingsSection>
  )
}
