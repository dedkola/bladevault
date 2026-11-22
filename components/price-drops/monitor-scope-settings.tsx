'use client'

import { useMemo, useState } from 'react'
import { Heart, ListChecks, Search, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { SegmentedControl, SettingsRow } from '@/components/settings-panels'
import { useKnives } from '@/components/providers/knives-provider'
import { useWishlist } from '@/components/providers/wishlist-provider'
import type { Knife } from '@/lib/data'
import type {
  PriceMonitorScope,
  PriceMonitorScopeKind,
} from '@/lib/settings-shared'
import { cn } from '@/lib/utils'

const KIND_LABEL: Record<PriceMonitorScopeKind, string> = {
  all: 'Whole collection',
  wishlist: 'Wishlist',
  selected: 'Selected knives',
}

/** Dialog tabs; Wishlist comes first and opens by default. */
type DialogKind = Exclude<PriceMonitorScopeKind, 'all'>
const DIALOG_KINDS: DialogKind[] = ['wishlist', 'selected']
const KIND_OPTIONS = DIALOG_KINDS.map((value) => ({
  value,
  label: KIND_LABEL[value],
}))

const knifeLabel = (knife: Pick<Knife, 'brand' | 'name'>) =>
  `${knife.brand} ${knife.name}`.trim() || 'Untitled knife'

export const knivesLabel = (count: number) =>
  `${count} ${count === 1 ? 'knife' : 'knives'}`

/** Knives the scope covers, counted on the client for the summary. */
function scopeKnifeCount(
  scope: PriceMonitorScope,
  knives: readonly Knife[],
  wishlistIds: readonly string[],
): number | null {
  if (scope.kind === 'all') return null
  const existing = new Set(knives.map((knife) => knife.id))
  const ids = scope.kind === 'selected' ? scope.knifeIds : wishlistIds
  return new Set(ids.filter((id) => existing.has(id))).size
}

export function scopeSummary(
  scope: PriceMonitorScope,
  knives: readonly Knife[],
  wishlistIds: readonly string[],
): string {
  if (scope.kind === 'all') return 'Whole collection'
  const count = scopeKnifeCount(scope, knives, wishlistIds) ?? 0
  if (scope.kind === 'selected')
    return count
      ? `${count} selected ${count === 1 ? 'knife' : 'knives'}`
      : 'Nothing: monitoring is stopped'
  return count ? knivesLabel(count) : 'empty, nothing is monitored'
}

export function MonitorScopeSettings({
  scope,
  disabled,
  onChange,
}: {
  scope: PriceMonitorScope
  disabled?: boolean
  onChange: (next: PriceMonitorScope) => void
}) {
  const { knives } = useKnives()
  const { items: wishlistItems } = useWishlist()
  const wishlistIds = useMemo(
    () => wishlistItems.map((item) => item.knifeId),
    [wishlistItems],
  )
  const [editing, setEditing] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const [undo, setUndo] = useState<PriceMonitorScope | null>(null)

  const stopped = scope.kind === 'selected' && scope.knifeIds.length === 0
  const summary = scopeSummary(scope, knives, wishlistIds)

  const stopAll = () => {
    setUndo(scope)
    onChange({ kind: 'selected', knifeIds: [] })
    setConfirmStop(false)
  }

  return (
    <SettingsRow
      label="What to monitor"
      description="Only these knives are checked on schedule, even with Always monitor. Check now works for any knife."
    >
      <span
        data-monitor-scope={scope.kind}
        className={cn(
          'inline-flex max-w-full items-center gap-2 rounded-full border border-[var(--bladevault-line)] px-2.5 py-1 text-xs',
          stopped && 'text-muted-foreground',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            stopped ? 'bg-muted-foreground' : 'bg-[var(--bladevault-gold)]',
          )}
        />
        <span className="truncate">
          {scope.kind === 'all' ? summary : `${KIND_LABEL[scope.kind]}: `}
          {scope.kind === 'all' ? null : summary}
        </span>
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => setEditing(true)}
      >
        <ListChecks className="size-3.5" />
        Change…
      </Button>
      <Button
        size="sm"
        variant="destructive"
        disabled={disabled || stopped}
        onClick={() => setConfirmStop(true)}
      >
        <Square className="size-3.5" />
        Stop monitoring all
      </Button>
      {undo ? (
        <p role="status" className="w-full text-xs text-muted-foreground">
          Monitoring stopped for every knife. Choose knives with Change….{' '}
          <button
            type="button"
            className="underline"
            disabled={disabled}
            onClick={() => {
              onChange(undo)
              setUndo(null)
            }}
          >
            Undo
          </button>
        </p>
      ) : null}

      {editing ? (
        <ScopeDialog
          scope={scope}
          knives={knives}
          wishlistIds={wishlistIds}
          onClose={() => setEditing(false)}
          onApply={(next) => {
            setUndo(null)
            onChange(next)
            setEditing(false)
          }}
        />
      ) : null}

      <Dialog
        open={confirmStop}
        onOpenChange={(open) => {
          if (!open) setConfirmStop(false)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Stop monitoring{' '}
              {scope.kind === 'all'
                ? `all ${knivesLabel(knives.length)}`
                : 'all knives'}
              ?
            </DialogTitle>
            <DialogDescription>
              Nothing is deleted: store links, price history and alert rules
              stay. Pick the knives to monitor afterwards, or switch back to
              Whole collection at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmStop(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={stopAll}>
              Stop monitoring
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsRow>
  )
}

function ScopeDialog({
  scope,
  knives,
  wishlistIds,
  onClose,
  onApply,
}: {
  scope: PriceMonitorScope
  knives: readonly Knife[]
  wishlistIds: readonly string[]
  onClose: () => void
  onApply: (next: PriceMonitorScope) => void
}) {
  const [draft, setDraft] = useState<{ kind: DialogKind; knifeIds: string[] }>(
    () => ({
      kind: scope.kind === 'selected' ? 'selected' : 'wishlist',
      knifeIds: scope.knifeIds,
    }),
  )
  const [query, setQuery] = useState('')
  const [selectedOnly, setSelectedOnly] = useState(false)

  const picked = useMemo(() => new Set(draft.knifeIds), [draft.knifeIds])
  const sorted = useMemo(
    () =>
      [...knives].sort((a, b) =>
        knifeLabel(a).localeCompare(knifeLabel(b), undefined, {
          sensitivity: 'base',
        }),
      ),
    [knives],
  )
  const visible = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return sorted.filter((knife) => {
      if (selectedOnly && !picked.has(knife.id)) return false
      if (!words.length) return true
      const text = `${knife.brand} ${knife.name}`.toLowerCase()
      return words.every((word) => text.includes(word))
    })
  }, [sorted, query, selectedOnly, picked])
  const existing = useMemo(() => new Set(knives.map((k) => k.id)), [knives])
  const pickedCount = draft.knifeIds.filter((id) => existing.has(id)).length

  const setKnives = (ids: Iterable<string>) =>
    setDraft((current) => ({ ...current, knifeIds: [...new Set(ids)] }))
  const toggleKnife = (id: string) =>
    setKnives(
      picked.has(id)
        ? draft.knifeIds.filter((value) => value !== id)
        : [...draft.knifeIds, id],
    )
  const wishlistKnives = useMemo(() => {
    const ids = new Set(wishlistIds)
    return sorted.filter((knife) => ids.has(knife.id))
  }, [sorted, wishlistIds])

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent data-monitor-scope-dialog className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>What to monitor</DialogTitle>
          <DialogDescription>
            Knives outside this choice keep their stores and history but are not
            checked on schedule.
          </DialogDescription>
        </DialogHeader>

        <SegmentedControl
          aria-label="What to monitor"
          value={draft.kind}
          options={KIND_OPTIONS}
          onValueChange={(kind) =>
            setDraft((current) => ({ ...current, kind }))
          }
        />

        {draft.kind === 'wishlist' ? (
          <div className="min-w-0 rounded-lg border border-[var(--bladevault-line)]">
            {wishlistKnives.length ? (
              <ul
                aria-label="Wishlist knives"
                className="max-h-[min(45vh,22rem)] overflow-y-auto"
              >
                {wishlistKnives.map((knife) => (
                  <li
                    key={knife.id}
                    className="flex items-center gap-2.5 border-t border-[var(--bladevault-line)]/60 px-3 py-2 text-sm first:border-t-0"
                  >
                    <Heart
                      aria-hidden
                      className="size-3.5 shrink-0 text-[var(--bladevault-gold)]"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {knifeLabel(knife)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 py-4 text-sm text-muted-foreground">
                The Wishlist is empty. Add knives to it from a knife page or the
                Wishlist.
              </p>
            )}
            <p className="border-t border-[var(--bladevault-line)] px-3 py-2 text-xs text-muted-foreground">
              Follows the Wishlist: knives added to it later are monitored too.
            </p>
          </div>
        ) : (
          <div className="min-w-0 rounded-lg border border-[var(--bladevault-line)]">
            <div className="flex flex-wrap items-center gap-2 border-b border-[var(--bladevault-line)] p-2">
              <div className="relative min-w-40 flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search brand or model"
                  aria-label="Search knives"
                  className="h-8 pl-7"
                />
              </div>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Checkbox
                  checked={selectedOnly}
                  onCheckedChange={(checked) => setSelectedOnly(checked)}
                />
                Selected only
              </label>
            </div>
            <ul
              aria-label="Knives"
              className="max-h-[min(45vh,22rem)] overflow-y-auto"
            >
              {visible.map((knife) => (
                <li
                  key={knife.id}
                  className="border-t border-[var(--bladevault-line)]/60 first:border-t-0"
                >
                  <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-[var(--bladevault-surface-soft)]">
                    <Checkbox
                      checked={picked.has(knife.id)}
                      onCheckedChange={() => toggleKnife(knife.id)}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {knifeLabel(knife)}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {knife.sold
                        ? 'sold'
                        : knife.specs.price?.trim() || 'no price'}
                    </span>
                  </label>
                </li>
              ))}
              {!visible.length ? (
                <li className="px-3 py-4 text-sm text-muted-foreground">
                  No knives match.
                </li>
              ) : null}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--bladevault-line)] px-3 py-2 text-xs text-muted-foreground">
              <span>
                {pickedCount} of {knives.length} selected
              </span>
              <span className="flex gap-3">
                <button
                  type="button"
                  className="underline disabled:no-underline disabled:opacity-50"
                  disabled={!visible.length}
                  onClick={() =>
                    setKnives([
                      ...draft.knifeIds,
                      ...visible.map((knife) => knife.id),
                    ])
                  }
                >
                  Select all shown
                </button>
                <button
                  type="button"
                  className="underline disabled:no-underline disabled:opacity-50"
                  disabled={!draft.knifeIds.length}
                  onClick={() => setKnives([])}
                >
                  Clear
                </button>
              </span>
            </div>
          </div>
        )}

        <DialogFooter className="sm:items-center">
          {scope.kind !== 'all' ? (
            <button
              type="button"
              className="mr-auto text-xs text-muted-foreground underline hover:text-foreground"
              onClick={() => onApply({ kind: 'all', knifeIds: scope.knifeIds })}
            >
              Monitor whole collection
            </button>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onApply(draft)}>Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
