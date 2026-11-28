'use client'

import { Menu } from '@base-ui/react/menu'
import { Check, ChevronDown, Clock, Pause, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ATTENTION_SNOOZE_DAYS,
  QUIET_REASON_TEXT,
  type AttentionActionRequest,
  type AttentionActionResult,
  type AttentionList,
  type AttentionSnoozeDays,
  type AttentionVerdict,
} from '@/lib/price-monitor/attention-filter'
import type { PriceSourceStatus } from '@/lib/price-monitor/shared'

/** Sends one Needs attention action; returns the updated list. */
export async function postAttentionAction(
  request: AttentionActionRequest,
): Promise<AttentionList & { result: AttentionActionResult }> {
  const response = await fetch('/api/prices/attention', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  const data = (await response.json().catch(() => ({}))) as Partial<
    AttentionList & { result: AttentionActionResult; error: string }
  >
  if (!response.ok || !data.result || !data.items || !data.counts)
    throw new Error(data.error ?? 'The action did not go through.')
  return data as AttentionList & { result: AttentionActionResult }
}

export async function fetchAttentionList(): Promise<AttentionList> {
  const response = await fetch('/api/prices/attention', { cache: 'no-store' })
  const data = (await response.json().catch(() => ({}))) as Partial<
    AttentionList & { error: string }
  >
  if (!response.ok || !data.items || !data.counts)
    throw new Error(data.error ?? 'Could not load Needs attention.')
  return data as AttentionList
}

const LATER_LABEL: Record<AttentionSnoozeDays, string> = {
  1: 'Tomorrow',
  7: 'In a week',
}

/** What an action did, in one line for a notice. */
export function attentionResultText(
  request: AttentionActionRequest,
  result: AttentionActionResult,
): string {
  const pages = (count: number) =>
    `${count} store ${count === 1 ? 'page' : 'pages'}`
  const done: Record<AttentionActionRequest['action'], string> = {
    snooze: `${pages(result.applied)} put off; checked again ${request.days === 7 ? 'in a week' : 'tomorrow'}.`,
    unsnooze: `${pages(result.applied)} back in Needs attention.`,
    accept: `Price confirmed for ${pages(result.applied)}.`,
    same_product: `Kept ${pages(result.applied)} as your knife; AI won’t ask about another version there again.`,
    wrong_page: `Removed ${pages(result.applied - result.pausedInstead)}.`,
    pause: `Paused ${pages(result.applied)}. Resume them in each knife's edit mode.`,
    remove: `Removed ${pages(result.applied - result.pausedInstead)}.`,
  }
  const paused = result.pausedInstead
    ? ` ${pages(result.pausedInstead)} from the knife's own product link ${result.pausedInstead === 1 ? 'was' : 'were'} paused instead.`
    : ''
  const skipped = result.skipped
    ? ` ${result.skipped} skipped: the action does not apply to ${result.skipped === 1 ? 'it' : 'them'}.`
    : ''
  return `${done[request.action]}${paused}${skipped}`
}

/** Later ▾: put a problem off for a day or a week. */
export function LaterMenu({
  onLater,
  disabled,
  compact = false,
  label = 'Later',
}: {
  onLater: (days: AttentionSnoozeDays) => void
  disabled?: boolean
  compact?: boolean
  /** Accessible name; compact buttons show only the clock. */
  label?: string
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        disabled={disabled}
        render={
          <Button
            type="button"
            variant={compact ? 'ghost' : 'outline'}
            size={compact ? 'icon-xs' : 'xs'}
            aria-label={label}
            title={compact ? 'Later' : undefined}
            data-attention-later
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        <Clock className={compact ? 'size-3.5' : 'size-3'} />
        {compact ? null : (
          <>
            Later
            <ChevronDown className="size-3" />
          </>
        )}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="isolate z-50">
          <Menu.Popup className="w-40 origin-(--transform-origin) rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            <div className="px-2 pt-1 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Check again
            </div>
            {ATTENTION_SNOOZE_DAYS.map((days) => (
              <Menu.Item
                key={days}
                onClick={(event) => {
                  event.stopPropagation()
                  onLater(days)
                }}
                className="flex cursor-default items-center rounded-md px-2 py-1.5 outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
              >
                {LATER_LABEL[days]}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

/**
 * The buttons for one store page in trouble: Later, Price is right and
 * Wrong page (AI doubts the price), Pause. Compact shows icons only.
 */
export function AttentionButtons({
  sourceId,
  status,
  verdict,
  label,
  busy,
  compact = false,
  answersShown = false,
  onAction,
}: {
  sourceId: number
  status: PriceSourceStatus
  verdict: AttentionVerdict | null
  /** The review card beside it already offers the answers. */
  answersShown?: boolean
  /** "Knife at store", for accessible names. */
  label: string
  busy?: boolean
  compact?: boolean
  onAction: (request: AttentionActionRequest) => void
}) {
  const ids = [sourceId]
  const stop = (event: React.SyntheticEvent) => event.stopPropagation()
  if (verdict?.class === 'snoozed')
    return (
      <Button
        type="button"
        variant={compact ? 'ghost' : 'outline'}
        size="xs"
        disabled={busy}
        title={`Put off until ${new Date(verdict.until).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}
        aria-label={`Show ${label} in Needs attention now`}
        onClick={(event) => {
          stop(event)
          onAction({ action: 'unsnooze', sourceIds: ids })
        }}
      >
        Show now
      </Button>
    )
  const review = status === 'needs_review' && !answersShown
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {review ? (
        <>
          <Button
            type="button"
            variant={compact ? 'ghost' : 'outline'}
            size={compact ? 'icon-xs' : 'xs'}
            disabled={busy}
            title="The price is right: stop doubting it"
            aria-label={`The price of ${label} is right`}
            data-attention-accept
            onClick={(event) => {
              stop(event)
              onAction({ action: 'accept', sourceIds: ids })
            }}
          >
            <Check className={compact ? 'size-3.5' : 'size-3'} />
            {compact ? null : 'Price is right'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size={compact ? 'icon-xs' : 'xs'}
            disabled={busy}
            title="Wrong page: remove this store from the knife"
            aria-label={`Wrong page: remove ${label}`}
            data-attention-wrong-page
            onClick={(event) => {
              stop(event)
              onAction({ action: 'wrong_page', sourceIds: ids })
            }}
          >
            <X className={compact ? 'size-3.5' : 'size-3'} />
            {compact ? null : 'Wrong page'}
          </Button>
        </>
      ) : null}
      <LaterMenu
        compact={compact}
        disabled={busy}
        label={`Check ${label} again later`}
        onLater={(days) => onAction({ action: 'snooze', sourceIds: ids, days })}
      />
      {compact ? null : (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={busy}
          title="Stop checking this store page"
          aria-label={`Pause ${label}`}
          onClick={(event) => {
            stop(event)
            onAction({ action: 'pause', sourceIds: ids })
          }}
        >
          <Pause className="size-3" />
          Pause
        </Button>
      )}
    </span>
  )
}

/** Tooltip for a quiet or snoozed problem's grey mark. */
export function verdictTitle(verdict: AttentionVerdict | null): string | null {
  if (!verdict || verdict.class === 'attention') return null
  if (verdict.class === 'snoozed')
    return `Put off until ${new Date(verdict.until).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}; checked again then.`
  return QUIET_REASON_TEXT[verdict.reason]
}
