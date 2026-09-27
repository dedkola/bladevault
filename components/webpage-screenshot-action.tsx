'use client'
import { useState } from 'react'
import type { Knife } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { readJsonResponse } from '@/lib/api-response'

export function WebpageScreenshotAction({
  knife,
  onCaptured,
}: {
  knife: Knife
  onCaptured: (knife: Knife) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!knife.sourceUrl) return null
  async function capture() {
    if (
      knife.webpageScreenshot &&
      !window.confirm(
        'Replace the saved webpage screenshot with a new capture of the website today?',
      )
    )
      return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(
        `/api/knives/${encodeURIComponent(knife.id)}/screenshot`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ replace: Boolean(knife.webpageScreenshot) }),
        },
      )
      const data = await readJsonResponse<{ knife?: Knife; error?: string }>(
        response,
      )
      if (!response.ok || !data.knife)
        throw new Error(data.error || 'Capture failed')
      onCaptured(data.knife)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Capture failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => void capture()}
      >
        {busy
          ? 'Capturing webpage…'
          : knife.webpageScreenshot
            ? 'Replace webpage screenshot'
            : 'Capture webpage screenshot'}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
