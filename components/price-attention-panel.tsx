'use client'

import Link from 'next/link'
import { useEffect, useEffectEvent, useState } from 'react'
import {
  AppWindow,
  Lightbulb,
  Loader2,
  Pause,
  RotateCw,
  Search,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  AttentionButtons,
  attentionResultText,
  fetchAttentionList,
  LaterMenu,
  postAttentionAction,
} from '@/components/price-drops/attention-actions'
import {
  SolveInBrowserDialog,
  type SolveTarget,
} from '@/components/price-drops/solve-in-browser'
import { SourceReviewCard } from '@/components/price-drops/source-review'
import {
  ATTENTION_PROBLEM_LABEL,
  type AttentionActionRequest,
  type AttentionFix,
  type AttentionItem,
  type AttentionList,
} from '@/lib/price-monitor/attention-filter'
import { SYSTEM_MESSAGES_REFRESH_EVENT } from '@/lib/system-messages'

const DAY_MS = 86_400_000

function sinceLabel(since: string | null, now: number): string | null {
  if (!since) return null
  const days = Math.floor((now - Date.parse(since)) / DAY_MS)
  if (!Number.isFinite(days) || days < 1) return 'today'
  return days === 1 ? 'for 1 day' : `for ${days} days`
}

const FIX_ICON = {
  solve: AppWindow,
  find_other_stores: Search,
  retry: RotateCw,
} as const

function fixLabel(fix: Exclude<AttentionFix, 'pause'>, blocked: boolean) {
  if (fix === 'solve') return blocked ? 'Solve in browser' : 'Fix in browser'
  if (fix === 'find_other_stores') return 'Find at other stores'
  return blocked ? 'Retry with fresh cookies' : 'Retry now'
}

/**
 * The suggested fix for a page that cannot be read, in a sentence, with a
 * button for each fix that works on this server (the suggested one filled).
 * Pause stays with the row's other buttons.
 */
function SuggestedFix({
  item,
  busy,
  onAction,
  onSolve,
}: {
  item: AttentionItem
  busy: boolean
  onAction: (request: AttentionActionRequest) => void
  onSolve: () => void
}) {
  const suggestion = item.suggestion
  if (!suggestion) return null
  const blocked = item.status === 'blocked'
  const label = `${item.knife} at ${item.storeName}`
  return (
    <div
      data-attention-fix={suggestion.fix}
      className="basis-full space-y-1.5 pb-1 text-xs sm:pl-7"
    >
      <p className="flex gap-1.5 text-muted-foreground">
        <Lightbulb
          className="mt-0.5 size-3 shrink-0 text-foreground"
          aria-hidden="true"
        />
        <span>
          <b className="font-medium text-foreground">Suggested:</b>{' '}
          {suggestion.text}
        </span>
      </p>
      <div className="flex flex-wrap gap-1.5">
        {suggestion.fixes.map((fix) => {
          if (fix === 'pause') return null
          const Icon = FIX_ICON[fix]
          const text = fixLabel(fix, blocked)
          return (
            <Button
              key={fix}
              type="button"
              variant={fix === suggestion.fix ? 'default' : 'outline'}
              size="xs"
              disabled={busy}
              aria-label={`${text}: ${label}`}
              onClick={() =>
                fix === 'solve'
                  ? onSolve()
                  : onAction({ action: fix, sourceIds: [item.sourceId] })
              }
            >
              <Icon className="size-3" aria-hidden="true" />
              {text}
            </Button>
          )
        })}
      </div>
    </div>
  )
}

/** Price Drops, Needs attention, with the item's knife open at its store. */
export function attentionItemHref(
  item: Pick<AttentionItem, 'knifeId' | 'sourceId'>,
): string {
  return `/price-drops?section=attention&knife=${encodeURIComponent(item.knifeId)}&source=${item.sourceId}`
}

/**
 * The store pages behind the Needs attention message, each with Later,
 * Pause and, for a doubted price, AI's page next to the knife with the
 * answers; plus bulk actions for every ticked page. Read live, so it never
 * lists a page that was already fixed. `onFirstItem` gets the first page
 * still listed, for the message's Open Needs attention link.
 */
export function PriceAttentionPanel({
  onFirstItem,
}: {
  onFirstItem?: (item: AttentionItem | null) => void
} = {}) {
  const [list, setList] = useState<AttentionList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ticked, setTicked] = useState<Set<number>>(new Set())
  const [solveTarget, setSolveTarget] = useState<SolveTarget | null>(null)
  const [now] = useState(() => Date.now())
  const reportFirst = useEffectEvent((item: AttentionItem | null) =>
    onFirstItem?.(item),
  )
  const first =
    list?.items.find((item) => item.verdict.class === 'attention') ?? null
  const firstKey = first ? `${first.knifeId}|${first.sourceId}` : ''
  const loaded = list !== null
  useEffect(() => {
    if (loaded) reportFirst(first)
    // Only when the first page changes, not on every list reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstKey, loaded])

  const reload = () => {
    fetchAttentionList()
      .then(setList)
      .catch(() => {})
    window.dispatchEvent(new Event(SYSTEM_MESSAGES_REFRESH_EVENT))
  }

  useEffect(() => {
    let live = true
    fetchAttentionList()
      .then((next) => {
        if (live) setList(next)
      })
      .catch((err: unknown) => {
        if (live)
          setError(
            err instanceof Error ? err.message : 'Could not load the list.',
          )
      })
    return () => {
      live = false
    }
  }, [])

  const run = async (request: AttentionActionRequest) => {
    setBusy(true)
    setNotice(null)
    try {
      const { result, items, counts } = await postAttentionAction(request)
      setList({ items, counts })
      setTicked(new Set())
      setNotice(attentionResultText(request, result))
      // The message itself may have closed or changed.
      window.dispatchEvent(new Event(SYSTEM_MESSAGES_REFRESH_EVENT))
    } catch (err) {
      setNotice(
        err instanceof Error ? err.message : 'The action did not go through.',
      )
    } finally {
      setBusy(false)
    }
  }

  if (error)
    return <p className="mt-2 text-xs text-muted-foreground">{error}</p>
  if (!list)
    return (
      <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> Loading the store pages…
      </p>
    )

  const items = list.items.filter((item) => item.verdict.class === 'attention')
  const ids = items.map((item) => item.sourceId)
  const chosen = ids.filter((id) => ticked.has(id))
  const reviewChosen = items
    .filter(
      (item) => ticked.has(item.sourceId) && item.status === 'needs_review',
    )
    .map((item) => item.sourceId)
  const all = chosen.length === ids.length && ids.length > 0
  const toggle = (id: number) =>
    setTicked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div data-price-attention-panel className="mt-3 space-y-2">
      {items.length ? (
        <>
          <div
            role="toolbar"
            aria-label="Actions for ticked store pages"
            className="flex flex-wrap items-center gap-1.5 text-xs"
          >
            <label className="inline-flex items-center gap-1.5 pr-1">
              <Checkbox
                checked={all}
                indeterminate={chosen.length > 0 && !all}
                onCheckedChange={() =>
                  setTicked(all ? new Set() : new Set(ids))
                }
                aria-label="Select all store pages"
              />
              {chosen.length ? `${chosen.length} selected` : 'Select all'}
            </label>
            {chosen.length ? (
              <>
                <LaterMenu
                  disabled={busy}
                  label="Check the selected pages again later"
                  onLater={(days) =>
                    void run({ action: 'snooze', days, sourceIds: chosen })
                  }
                />
                {reviewChosen.length ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={busy}
                    onClick={() =>
                      void run({ action: 'accept', sourceIds: reviewChosen })
                    }
                  >
                    Price is right ({reviewChosen.length})
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() =>
                    void run({ action: 'pause', sourceIds: chosen })
                  }
                >
                  <Pause className="size-3" />
                  Pause
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  title="Remove the selected store pages; the knife's own product link is paused instead"
                  onClick={() =>
                    void run({ action: 'remove', sourceIds: chosen })
                  }
                >
                  <Trash2 className="size-3" />
                  Remove
                </Button>
              </>
            ) : null}
            {busy ? (
              <Loader2
                className="size-3.5 animate-spin text-muted-foreground"
                aria-label="Working"
              />
            ) : null}
          </div>
          <ul className="divide-y divide-[var(--bladevault-line)]/60 rounded-lg border border-[var(--bladevault-line)]/70">
            {items.map((item) => {
              const label = `${item.knife} at ${item.storeName}`
              const since = sinceLabel(item.since, now)
              return (
                <li
                  key={item.sourceId}
                  data-attention-item={item.sourceId}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-2.5 py-2"
                >
                  <Checkbox
                    checked={ticked.has(item.sourceId)}
                    onCheckedChange={() => toggle(item.sourceId)}
                    aria-label={`Select ${label}`}
                  />
                  <div className="min-w-0 flex-1 text-xs">
                    <Link
                      href={attentionItemHref(item)}
                      className="font-medium text-foreground underline-offset-2 hover:underline"
                    >
                      {item.knife}
                    </Link>{' '}
                    <span className="text-muted-foreground">
                      at {item.storeName}
                    </span>
                    <div className="text-muted-foreground">
                      {ATTENTION_PROBLEM_LABEL[item.status] ?? item.status}
                      {since ? ` · ${since}` : ''}
                    </div>
                  </div>
                  <AttentionButtons
                    sourceId={item.sourceId}
                    status={item.status}
                    verdict={item.verdict}
                    label={label}
                    busy={busy}
                    answersShown={item.status === 'needs_review'}
                    onAction={(request) => void run(request)}
                  />
                  <SuggestedFix
                    item={item}
                    busy={busy}
                    onAction={(request) => void run(request)}
                    onSolve={() =>
                      setSolveTarget({
                        sourceId: item.sourceId,
                        url: item.url,
                        storeName: item.storeName,
                        status: item.status,
                      })
                    }
                  />
                  {item.status === 'needs_review' ? (
                    <SourceReviewCard
                      className="basis-full pb-1 sm:pl-7"
                      review={item.review}
                      knifeId={item.knifeId}
                      sourceId={item.sourceId}
                      storeName={item.storeName}
                      url={item.url}
                      priceMinor={item.priceMinor}
                      currency={item.currency}
                      origin={item.origin}
                      lastError={item.lastError}
                      busy={busy}
                      onAction={(request) => void run(request)}
                    />
                  ) : null}
                </li>
              )
            })}
          </ul>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Nothing needs a look right now.
        </p>
      )}
      {notice ? (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {list.counts.quiet || list.counts.snoozed ? (
        <p className="text-xs text-muted-foreground">
          <Link
            href="/price-drops?section=all"
            className="underline-offset-2 hover:underline"
          >
            {[
              list.counts.quiet
                ? `${list.counts.quiet} quiet (no action needed)`
                : null,
              list.counts.snoozed ? `${list.counts.snoozed} put off` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Link>
        </p>
      ) : null}
      <SolveInBrowserDialog
        target={solveTarget}
        onClose={() => setSolveTarget(null)}
        onSolved={reload}
      />
    </div>
  )
}
