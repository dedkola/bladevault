'use client'

import { useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { HistoryRange } from '@/lib/price-monitor/insights'
import { hasServerRuntime } from '@/lib/runtime-capabilities'

function filenameFrom(response: Response): string {
  const header = response.headers.get('Content-Disposition') ?? ''
  return header.match(/filename="([^"]+)"/)?.[1] ?? 'bladevault-prices.csv'
}

/**
 * Downloads price history as CSV from /api/prices/export. A blob link is
 * used so errors can be shown here; the desktop app shows its save dialog.
 */
export function PriceExportButton({
  knifeId,
  range,
  label = 'Export CSV',
}: {
  knifeId?: string
  range?: HistoryRange
  label?: string
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The static web app has no server to export from.
  const [serverRuntime] = useState(hasServerRuntime)
  if (!serverRuntime) return null

  const exportCsv = async () => {
    setBusy(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (knifeId) params.set('knifeId', knifeId)
      if (range) params.set('range', range)
      const response = await fetch(`/api/prices/export?${params}`, {
        cache: 'no-store',
      })
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string
        }
        throw new Error(data.error ?? 'Could not export price history.')
      }
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = filenameFrom(response)
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not export price history.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <span data-price-export className="inline-flex items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        title={
          knifeId
            ? 'Download this knife’s price history as a CSV file'
            : 'Download the price history of every knife as a CSV file'
        }
        onClick={() => void exportCsv()}
      >
        {busy ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Download className="size-3.5" />
        )}
        {label}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  )
}
