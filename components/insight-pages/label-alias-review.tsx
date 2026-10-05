'use client'

import Link from 'next/link'
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
import {
  affectedLabelCollections,
  type LabelAliasGroup,
} from '@/lib/collection-cleanup'
import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'
import { normalizeSingleLineText } from '@/lib/knife-text'
import type { SmartCollection } from '@/lib/smart-collections'

export function LabelAliasReview({
  group,
  onClose,
}: {
  group: LabelAliasGroup
  onClose: () => void
}) {
  const { bulkUpdateKnives, refreshVault, showFeedback } = useKnives()
  const [value, setValue] = useState(group.suggestedValue)
  const [collections, setCollections] = useState<SmartCollection[] | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const target = normalizeSingleLineText(value)
  const changed = group.values.filter((item) => item.value !== target)
  const affectedKnives = changed.flatMap((item) => item.knives)
  const affectedCollections = affectedLabelCollections(
    collections ?? [],
    group.field,
    changed.map((item) => item.value),
  )

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/smart-collections', {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await readJsonResponse<{
          collections: SmartCollection[]
        }>(response)
        if (!response.ok)
          throw new Error(
            getApiErrorMessage(payload, 'Could not check saved filters.'),
          )
        if (!Array.isArray(payload.collections))
          throw new Error('Could not check saved filters.')
        if (!controller.signal.aborted) setCollections(payload.collections)
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : 'Could not check saved filters.',
          )
      })
    return () => controller.abort()
  }, [])

  const apply = async () => {
    if (
      !target ||
      !collections ||
      !affectedKnives.length ||
      (affectedCollections.length && !acknowledged)
    )
      return
    setSaving(true)
    setError('')
    try {
      await bulkUpdateKnives(
        affectedKnives.map((knife) => knife.id),
        group.field.field,
        target,
        Object.fromEntries(
          affectedKnives.map((knife) => [knife.id, knife.updatedAt]),
        ),
      )
      showFeedback(
        `Updated ${group.field.label.toLowerCase()} for ${affectedKnives.length} ${affectedKnives.length === 1 ? 'knife' : 'knives'}.`,
      )
      onClose()
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not update these labels.',
      )
      void refreshVault().catch(() =>
        showFeedback('Could not reload the collection.', 'error'),
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
    >
      <DialogContent
        className="sm:max-w-lg max-h-[85dvh] overflow-y-auto"
        showCloseButton={!saving}
      >
        <DialogHeader>
          <DialogTitle>
            Review {group.field.label.toLowerCase()} labels
          </DialogTitle>
          <DialogDescription>
            Choose one label, then review exactly which knives will change.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label htmlFor="cleanup-label" className="text-sm font-medium">
            Use this label
          </label>
          <Input
            id="cleanup-label"
            value={value}
            disabled={saving}
            onChange={(event) => {
              setValue(event.target.value)
              setAcknowledged(false)
            }}
          />
        </div>
        <div className="rounded-md bg-muted p-3 text-sm space-y-2">
          {group.values.map((item) => (
            <p key={item.value} className="break-words">
              {item.value} · {item.knives.length}{' '}
              {item.knives.length === 1 ? 'knife' : 'knives'} →{' '}
              {item.value === target ? 'Keep' : target || 'Choose a label'}
            </p>
          ))}
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">
            {affectedKnives.length}{' '}
            {affectedKnives.length === 1 ? 'knife' : 'knives'} will change
          </p>
          <ul
            aria-label="Knives to update"
            className="max-h-40 overflow-y-auto space-y-1 text-sm"
          >
            {affectedKnives.map((knife) => (
              <li key={knife.id} className="break-words">
                <Link
                  href={`/collection/${encodeURIComponent(knife.id)}`}
                  target="_blank"
                  className="underline underline-offset-4"
                >
                  {knife.brand} {knife.name}
                </Link>{' '}
                ·{' '}
                {
                  group.values.find((item) =>
                    item.knives.some((entry) => entry.id === knife.id),
                  )!.value
                }
              </li>
            ))}
          </ul>
        </div>
        <details className="text-sm space-y-2">
          <summary className="cursor-pointer">
            Inspect all knives in this group
          </summary>
          <p className="text-muted-foreground">
            Compare source pages and saved notes before changing a factual
            value.
          </p>
          <ul className="max-h-40 overflow-y-auto space-y-1">
            {group.values.flatMap((item) =>
              item.knives.map((knife) => (
                <li key={knife.id} className="break-words">
                  <Link
                    href={`/collection/${encodeURIComponent(knife.id)}`}
                    target="_blank"
                    className="underline underline-offset-4"
                  >
                    {knife.brand} {knife.name}
                  </Link>{' '}
                  · {item.value}
                </li>
              )),
            )}
          </ul>
        </details>
        {collections === null && !error && (
          <p role="status" className="text-sm">
            Checking saved filters…
          </p>
        )}
        {affectedCollections.length > 0 && (
          <div className="space-y-2 rounded-md border p-3 text-sm">
            <p>These smart collections filter by a label that will change:</p>
            <ul className="space-y-1">
              {affectedCollections.map((collection) => (
                <li key={collection.id}>
                  <Link
                    className="underline underline-offset-4 break-words"
                    href={`/collection?${collection.query}`}
                    target="_blank"
                  >
                    {collection.name}
                  </Link>
                </li>
              ))}
            </ul>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={saving}
                onChange={(event) => setAcknowledged(event.target.checked)}
                className="mt-1 accent-[var(--bladevault-gold)]"
              />
              I will update these saved filters after applying the label change.
            </label>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error} Close and reopen this preview to review the latest
            collection.
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              !target ||
              !collections ||
              !affectedKnives.length ||
              saving ||
              Boolean(error) ||
              Boolean(affectedCollections.length && !acknowledged)
            }
            onClick={() => void apply()}
          >
            {saving
              ? 'Applying…'
              : `Apply to ${affectedKnives.length} ${affectedKnives.length === 1 ? 'knife' : 'knives'}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
