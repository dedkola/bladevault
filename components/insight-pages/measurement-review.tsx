'use client'

import { useEffect, useState } from 'react'
import { useKnives } from '@/components/providers/knives-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'
import {
  cleanupMeasurements,
  formatInterpretedMeasurement,
  interpretMeasurement,
  type CleanupQueue,
} from '@/lib/collection-cleanup'
import type { Knife } from '@/lib/data'

function sourceHref(source: string) {
  try {
    const url = new URL(source)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

function ReviewRecord({
  entry,
  field,
  onAdvance,
  onBusy,
}: {
  entry: CleanupQueue['entries'][number]
  field: CleanupQueue['field']
  onAdvance: (saved: boolean) => void
  onBusy: (busy: boolean) => void
}) {
  const { bulkUpdateKnives } = useKnives()
  const [record, setRecord] = useState<Knife | null>(null)
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const label = cleanupMeasurements.find(
    (measurement) => measurement.key === field,
  )!.label

  useEffect(() => {
    const controller = new AbortController()
    void fetch(`/api/knives/${encodeURIComponent(entry.id)}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await readJsonResponse<{ knife: Knife }>(response)
        if (!response.ok)
          throw new Error(
            getApiErrorMessage(payload, 'Could not load this knife.'),
          )
        if (!payload.knife || payload.knife.addedAt !== entry.addedAt)
          throw new Error('This knife is no longer part of this review.')
        if (!controller.signal.aborted) {
          setRecord(payload.knife)
          setValue(payload.knife.specs[field] ?? '')
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : 'Could not load this knife.',
          )
      })
    return () => controller.abort()
  }, [entry.id, entry.addedAt, field])

  const save = async () => {
    if (!record || interpretMeasurement(field, value) === undefined) return
    setSaving(true)
    onBusy(true)
    setError('')
    try {
      await bulkUpdateKnives([record.id], `specs.${field}`, value.trim(), {
        [record.id]: record.updatedAt,
      })
      onAdvance(true)
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not save this measurement.',
      )
    } finally {
      setSaving(false)
      onBusy(false)
    }
  }

  const href = record ? sourceHref(record.sourceUrl) : undefined
  return (
    <div className="space-y-4">
      {record ? (
        <>
          <p className="font-medium break-words">
            {record.brand} {record.name}
          </p>
          <p className="text-sm text-muted-foreground break-words">
            Stored value: {record.specs[field]?.trim() || 'Not set'}
          </p>
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm underline underline-offset-4"
            >
              Open source page
            </a>
          ) : (
            <p className="text-sm text-muted-foreground">
              No source page saved.
            </p>
          )}
          <div className="space-y-2">
            <label
              htmlFor="cleanup-measurement"
              className="text-sm font-medium"
            >
              {label}
            </label>
            <Input
              id="cleanup-measurement"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              disabled={saving}
              placeholder={
                field === 'weight'
                  ? 'e.g. 120 g or 4.2 oz'
                  : 'e.g. 3 mm or .090 inches'
              }
              autoFocus
            />
            <p role="status" className="text-sm text-muted-foreground">
              {formatInterpretedMeasurement(field, value)}
            </p>
            <p className="text-xs text-muted-foreground">
              Your entered text is saved; conversion is used for insights.
            </p>
          </div>
        </>
      ) : (
        !error && <p role="status">Loading knife…</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          disabled={saving}
          onClick={() => onAdvance(false)}
        >
          Skip
        </Button>
        <Button
          disabled={
            !record ||
            saving ||
            interpretMeasurement(field, value) === undefined
          }
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save and next'}
        </Button>
      </div>
    </div>
  )
}

export function MeasurementReview({
  queue,
  open,
  onOpenChange,
  onQueueChange,
}: {
  queue: CleanupQueue
  open: boolean
  onOpenChange: (open: boolean) => void
  onQueueChange: (queue: CleanupQueue | null) => void
}) {
  const { knives, refreshVault, showFeedback } = useKnives()
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  const field = cleanupMeasurements.find(
    (measurement) => measurement.key === queue.field,
  )!
  const entry = queue.entries[queue.index]
  const present =
    entry &&
    knives.some(
      (knife) => knife.id === entry.id && knife.addedAt === entry.addedAt,
    )
  const advance = (saved: boolean) => {
    onQueueChange({
      ...queue,
      index: queue.index + 1,
      saved: queue.saved + Number(saved),
      skipped: queue.skipped + Number(!saved),
    })
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next)
      }}
    >
      <DialogContent
        className="sm:max-w-lg max-h-[85dvh] overflow-y-auto"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>Review {field.label.toLowerCase()}</DialogTitle>
          <DialogDescription>
            {entry
              ? `Knife ${queue.index + 1} of ${queue.entries.length} · ${queue.issue === 'missing' ? 'Missing values' : 'Uninterpretable values'}`
              : 'Review finished'}{' '}
            · {queue.saved} saved · {queue.skipped} skipped
          </DialogDescription>
        </DialogHeader>
        {entry ? (
          present ? (
            <>
              <ReviewRecord
                key={`${entry.id}:${queue.index}:${reload}`}
                entry={entry}
                field={queue.field}
                onAdvance={advance}
                onBusy={setBusy}
              />
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setReload((value) => value + 1)
                  void refreshVault().catch(() =>
                    showFeedback('Could not reload the collection.', 'error'),
                  )
                }}
              >
                Reload record
              </Button>
            </>
          ) : (
            <>
              <p>This knife is no longer in this collection.</p>
              <Button onClick={() => advance(false)}>
                Skip unavailable knife
              </Button>
            </>
          )
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Skipped records remain available in the review lists.
            </p>
            <Button
              onClick={() => {
                onQueueChange(null)
                onOpenChange(false)
              }}
            >
              Finish review
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
