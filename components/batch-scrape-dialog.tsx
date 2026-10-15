'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Check,
  ClipboardCopy,
  Layers,
  Loader2,
  RefreshCw,
  Square,
} from 'lucide-react'
import { useKnives } from '@/components/providers/knives-provider'
import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'
import {
  type BatchScrapeItem,
  createBatchItems,
  isBotProtectionMessage,
  parseBatchLinks,
  runBatchScrape,
} from '@/lib/batch-scrape'
import type { ScrapedProduct } from '@/lib/scrape'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type BatchScrapeDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const STATUS_LABELS: Record<BatchScrapeItem['status'], string> = {
  pending: 'Waiting',
  scraping: 'Scraping',
  saving: 'Saving',
  saved: 'Saved',
  failed: 'Failed',
}

export function BatchScrapeDialog({
  open,
  onOpenChange,
}: BatchScrapeDialogProps) {
  const { addKnife } = useKnives()
  const [input, setInput] = useState('')
  const [items, setItems] = useState<BatchScrapeItem[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [isCopied, setIsCopied] = useState(false)
  const stopRef = useRef(false)
  const runningRef = useRef(false)

  const parsed = useMemo(() => parseBatchLinks(input), [input])
  const failedItems = items.filter((item) => item.status === 'failed')
  const savedCount = items.filter((item) => item.status === 'saved').length
  const handledCount = savedCount + failedItems.length
  const needsInteractive = failedItems.some((item) =>
    isBotProtectionMessage(item.error),
  )

  useEffect(() => {
    return () => {
      stopRef.current = true
    }
  }, [])

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      if (isRunning) return
      setIsCopied(false)
    }
    onOpenChange(nextOpen)
  }

  const scrapeUrl = async (url: string) => {
    const response = await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
    const data = await readJsonResponse<{
      error?: string
      product: ScrapedProduct
      finalUrl?: string
    }>(response)

    if (!response.ok) {
      throw new Error(getApiErrorMessage(data, 'Failed to scrape product page'))
    }

    return { product: data.product, finalUrl: data.finalUrl }
  }

  const run = async (batch: BatchScrapeItem[]) => {
    if (runningRef.current || batch.length === 0) return

    runningRef.current = true
    stopRef.current = false
    setIsCopied(false)
    setIsRunning(true)

    try {
      await runBatchScrape(batch, {
        scrape: scrapeUrl,
        save: (draft) => addKnife(draft),
        onUpdate: (item) => {
          setItems((prev) =>
            prev.map((current) => (current.id === item.id ? item : current)),
          )
        },
        shouldStop: () => stopRef.current,
      })
    } finally {
      runningRef.current = false
      setIsRunning(false)
    }
  }

  const handleStart = () => {
    const next = createBatchItems(parsed.urls)
    setItems(next)
    void run(next)
  }

  const handleRetryFailed = () => {
    void run(items.filter((item) => item.status === 'failed'))
  }

  const handleStop = () => {
    stopRef.current = true
  }

  const handleCopyFailed = async () => {
    try {
      await navigator.clipboard.writeText(
        failedItems.map((item) => item.url).join('\n'),
      )
      setIsCopied(true)
    } catch {
      // Clipboard access can be unavailable; the failed links stay on screen.
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-muted-foreground" />
            Batch scrape
          </DialogTitle>
          <DialogDescription>
            Paste one link per line. Links are imported one at a time — never in
            parallel — so retailers do not block the run.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            rows={5}
            disabled={isRunning}
            aria-label="Product links"
            placeholder={
              'https://retailer.com/knife-one\nhttps://retailer.com/knife-two'
            }
          />

          <p className="text-xs text-muted-foreground" aria-live="polite">
            {parsed.urls.length} {parsed.urls.length === 1 ? 'link' : 'links'}{' '}
            ready
            {parsed.duplicates > 0
              ? ` · ${parsed.duplicates} duplicate${
                  parsed.duplicates === 1 ? '' : 's'
                } skipped`
              : ''}
            {parsed.invalid.length > 0
              ? ` · ${parsed.invalid.length} ignored`
              : ''}
          </p>

          {parsed.invalid.length > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              <p className="font-medium">Not imported:</p>
              <ul className="mt-1 space-y-0.5 break-all">
                {parsed.invalid.slice(0, 5).map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
              {parsed.invalid.length > 5 && (
                <p>…and {parsed.invalid.length - 5} more.</p>
              )}
            </div>
          )}
        </div>

        {items.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium" aria-live="polite">
                {handledCount} of {items.length} handled · {savedCount} added
              </p>
              {isRunning && (
                <Button variant="outline" size="sm" onClick={handleStop}>
                  <Square className="h-3.5 w-3.5" />
                  Stop
                </Button>
              )}
            </div>

            <progress
              className="h-2 w-full accent-[var(--bladevault-gold)]"
              aria-label="Batch scrape progress"
              max={items.length || 1}
              value={handledCount}
            />

            <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-[var(--bladevault-line)]">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-start gap-2 border-b border-[var(--bladevault-line)] px-3 py-2 text-xs last:border-b-0"
                >
                  <span className="mt-0.5 shrink-0">
                    {item.status === 'saved' && (
                      <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    )}
                    {item.status === 'failed' && (
                      <AlertCircle className="h-3.5 w-3.5 text-destructive" />
                    )}
                    {(item.status === 'scraping' ||
                      item.status === 'saving') && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    )}
                    {item.status === 'pending' && (
                      <span className="block h-3.5 w-3.5 rounded-full border border-muted-foreground/40" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">
                      {item.name || item.url}
                    </span>
                    {item.status === 'saved' && item.name ? (
                      <span className="block truncate text-muted-foreground">
                        {item.url}
                      </span>
                    ) : null}
                    {item.status === 'failed' && (
                      <span className="block break-words text-destructive">
                        {item.error}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {STATUS_LABELS[item.status]}
                  </span>
                </li>
              ))}
            </ul>

            {failedItems.length > 0 && (
              <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <p className="font-medium">
                  {failedItems.length}{' '}
                  {failedItems.length === 1 ? 'link was' : 'links were'} not
                  added.
                </p>
                <ul className="space-y-0.5 break-all">
                  {failedItems.map((item) => (
                    <li key={item.id}>{item.url}</li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCopyFailed}
                    disabled={isRunning}
                  >
                    {isCopied ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <ClipboardCopy className="h-3.5 w-3.5" />
                    )}
                    {isCopied ? 'Copied' : 'Copy failed links'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRetryFailed}
                    disabled={isRunning}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Retry failed
                  </Button>
                </div>
                {needsInteractive && (
                  <p className="text-amber-700 dark:text-amber-400">
                    Retailers that ask for a verification page cannot be
                    imported in a batch. Scrape those links one by one on the
                    Add page and use the interactive browser.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenChange(false)}
            disabled={isRunning}
          >
            Close
          </Button>
          <Button
            size="sm"
            onClick={handleStart}
            disabled={isRunning || parsed.urls.length === 0}
          >
            {isRunning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Layers className="h-3.5 w-3.5" />
            )}
            {isRunning
              ? 'Importing'
              : items.length > 0
                ? 'Import again'
                : 'Start batch'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
