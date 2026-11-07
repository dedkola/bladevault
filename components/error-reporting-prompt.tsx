'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { startBrowserErrorReporting } from '@/lib/sentry/client'
import type { ErrorReportingConfig } from '@/lib/sentry/shared'

const DOCS_URL =
  'https://github.com/dedkola/bladevault/blob/main/docs/reference/error-reporting.md'

type ConsentResponse = {
  consent?: string | null
  config?: ErrorReportingConfig | null
  error?: string
}

// Shown once per vault on servers running the official image, until someone
// answers. The answer applies to everyone who uses this BladeVault server.
export function ErrorReportingPrompt() {
  const [open, setOpen] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  if (!open) return null

  async function answer(consent: 'granted' | 'declined') {
    setPending(true)
    setError('')
    try {
      const response = await fetch('/api/settings/error-reporting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consent }),
      })
      const data = (await response.json().catch(() => ({}))) as ConsentResponse
      if (!response.ok) throw new Error(data.error || 'Could not save.')
      if (data.config) startBrowserErrorReporting(data.config)
      setOpen(false)
    } catch {
      setError('Could not save your answer. Try again.')
      setPending(false)
    }
  }

  return (
    <section
      role="region"
      aria-labelledby="error-reporting-prompt-title"
      className="bg-popover text-popover-foreground fixed right-4 bottom-4 left-4 z-40 flex flex-col gap-3 rounded-lg border p-4 shadow-lg sm:right-auto sm:max-w-sm"
    >
      <h2
        id="error-reporting-prompt-title"
        className="text-foreground text-sm font-semibold"
      >
        Help improve BladeVault?
      </h2>
      <p className="text-muted-foreground text-xs leading-relaxed">
        Send crash reports and anonymous usage data, such as which shop websites
        imports fail on, to the BladeVault developer through Sentry. Your
        knives, images, notes, and backups are never included. This answer
        applies to everyone using this BladeVault server.{' '}
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground underline underline-offset-2"
        >
          What is sent
        </a>
      </p>
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          className="rounded-lg"
          onClick={() => void answer('granted')}
          disabled={pending}
        >
          Send Reports
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="rounded-lg"
          onClick={() => void answer('declined')}
          disabled={pending}
        >
          Don’t Send
        </Button>
      </div>
      <p className="text-muted-foreground text-[11px]">
        You can change this later in Settings → About.
      </p>
    </section>
  )
}
