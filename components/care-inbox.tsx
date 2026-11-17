'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { Popover } from '@base-ui/react/popover'
import { Menu } from '@base-ui/react/menu'
import {
  Bell,
  BellOff,
  Check,
  ChevronDown,
  ImageIcon,
  Inbox,
  Loader2,
  RotateCcw,
  X,
} from 'lucide-react'
import Image from '@/components/vault-image'
import { Button } from '@/components/ui/button'
import { useKnives } from '@/components/providers/knives-provider'
import { useCareInbox } from '@/components/providers/care-inbox-provider'
import { careToneDotClass, careToneTextClass } from '@/components/care-badge'
import { getImageUrl, type Knife } from '@/lib/data'
import {
  CARE_SNOOZE_OPTIONS,
  getCareNotificationBox,
  isCareNotificationUnread,
  sortCareNotifications,
  type CareNotification,
  type CareNotificationAction,
  type CareNotificationBox,
} from '@/lib/care-notifications'
import type { CareStatusLevel } from '@/lib/maintenance-due'
import { CARE_TRACK_NAMES, CARE_TRACK_PAST } from '@/lib/settings-shared'
import { cn } from '@/lib/utils'

const DAY_MS = 86_400_000

function calendarDay(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS
}

function parseLocalDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, (month ?? 1) - 1, day ?? 1)
}

function formatShortDate(value: string | Date, now: Date): string {
  const date =
    typeof value === 'string'
      ? /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? parseLocalDate(value)
        : new Date(value)
      : value
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  })
}

function formatWhen(value: string, now: Date): string {
  const date = new Date(value)
  const days = calendarDay(now) - calendarDay(date)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return formatShortDate(date, now)
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/** Days until the stored deadline, counted from today. */
function daysUntilDue(notification: CareNotification, now: Date): number {
  return calendarDay(parseLocalDate(notification.dueOn)) - calendarDay(now)
}

function messageTone(
  notification: CareNotification,
  now: Date,
): CareStatusLevel | null {
  if (notification.resolvedAt)
    return notification.resolution === 'logged' ? 'ok' : null
  if (notification.dismissedAt) return null
  return daysUntilDue(notification, now) < 0 ? 'overdue' : 'due-soon'
}

export function careMessageHeadline(
  notification: CareNotification,
  now: Date,
): string {
  const track = CARE_TRACK_NAMES[notification.track]
  if (notification.resolvedAt) {
    return notification.resolution === 'logged'
      ? `${track} logged`
      : `${track} no longer due`
  }
  if (notification.dismissedAt) return `${track} reminder dismissed`
  const days = daysUntilDue(notification, now)
  if (days < 0) return `${track} overdue by ${plural(-days, 'day')}`
  if (days === 0) return `${track} due today`
  return `${track} due in ${plural(days, 'day')}`
}

export function careMessageDetail(
  notification: CareNotification,
  now: Date,
): string {
  const past = CARE_TRACK_PAST[notification.track]
  const last = `Last ${past} ${formatShortDate(notification.lastAt, now)}`
  if (notification.resolvedAt) {
    return notification.resolution === 'logged'
      ? `Resolved ${formatShortDate(notification.resolvedAt, now)}`
      : `${last} · the reminder changed or was turned off`
  }
  if (notification.dismissedAt) {
    return `${last} · hidden until this care is logged again`
  }
  if (getCareNotificationBox(notification, now) === 'snoozed') {
    return `Snoozed until ${formatShortDate(notification.snoozedUntil!, now)}`
  }
  return `${last} · due ${formatShortDate(notification.dueOn, now)}`
}

function knifeLabel(knife: Knife | undefined): string {
  if (!knife) return 'Removed knife'
  return knife.brand ? `${knife.brand} ${knife.name}` : knife.name
}

function KnifeThumb({
  knife,
  tone,
  size = 'md',
}: {
  knife: Knife | undefined
  tone: CareStatusLevel | null
  size?: 'sm' | 'md'
}) {
  const image = knife?.images[0]
  return (
    <span
      className={cn(
        'relative grid shrink-0 place-items-center rounded-lg border border-[var(--bladevault-line)]/70 bg-white',
        size === 'sm' ? 'size-9' : 'size-11',
      )}
    >
      <span className="absolute inset-0 overflow-hidden rounded-[inherit]">
        {image ? (
          <Image
            src={getImageUrl(image)}
            alt=""
            fill
            sizes="48px"
            className="object-contain p-0.5"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="grid h-full w-full place-items-center bg-muted/30">
            <ImageIcon className="size-4 text-muted-foreground/50" />
          </span>
        )}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          'absolute -right-1 -bottom-1 size-2.5 rounded-full ring-2 ring-popover',
          careToneDotClass(tone),
        )}
      />
    </span>
  )
}

function useInboxKnives() {
  const { knives } = useKnives()
  return useMemo(
    () => new Map(knives.map((knife) => [knife.id, knife])),
    [knives],
  )
}

/** Runs an inbox action and reports failures through the app's feedback toast. */
function useInboxAction() {
  const { act, logCare } = useCareInbox()
  const { showFeedback } = useKnives()
  const [busyId, setBusyId] = useState<number | null>(null)
  const run = async (action: CareNotificationAction) => {
    try {
      await act(action)
    } catch (error) {
      showFeedback(
        error instanceof Error ? error.message : 'Could not update the inbox',
        'error',
      )
    }
  }
  const log = async (notification: CareNotification) => {
    setBusyId(notification.id)
    try {
      await logCare(notification.knifeId, notification.track)
      showFeedback(
        `${CARE_TRACK_NAMES[notification.track]} logged for today.`,
        'success',
      )
    } catch (error) {
      showFeedback(
        error instanceof Error ? error.message : 'Could not log the care',
        'error',
      )
    } finally {
      setBusyId(null)
    }
  }
  return { run, log, busyId }
}

function SnoozeMenu({
  onSnooze,
  compact = false,
}: {
  onSnooze: (days: number) => void
  compact?: boolean
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-label={compact ? 'Snooze' : undefined}
          />
        }
      >
        {compact ? <BellOff className="size-3" /> : 'Snooze'}
        {!compact && <ChevronDown className="size-3" />}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="isolate z-50">
          <Menu.Popup className="w-36 origin-(--transform-origin) rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            <div className="px-2 pt-1 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Snooze until
            </div>
            {CARE_SNOOZE_OPTIONS.map((option) => (
              <Menu.Item
                key={option.days}
                onClick={() => onSnooze(option.days)}
                className="flex cursor-default items-center rounded-md px-2 py-1.5 outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
              >
                {option.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

function CareMessageRow({
  notification,
  knife,
  now,
  compact = false,
  busy,
  onAction,
  onLog,
  onNavigate,
}: {
  notification: CareNotification
  knife: Knife | undefined
  now: Date
  compact?: boolean
  busy: boolean
  onAction: (action: CareNotificationAction) => void
  onLog: () => void
  onNavigate?: () => void
}) {
  const box = getCareNotificationBox(notification, now)
  const unread = isCareNotificationUnread(notification, now)
  const tone = messageTone(notification, now)
  const ids = [notification.id]
  const href = knife
    ? `/collection/${encodeURIComponent(knife.id)}?tab=maintenance`
    : '/collection'
  return (
    <li
      data-care-message={box}
      data-unread={unread || undefined}
      className={cn(
        'flex items-start gap-3',
        compact ? 'px-3 py-2.5' : 'px-4 py-3.5',
        box === 'done' && 'bg-muted/25',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-2 size-1.5 shrink-0 rounded-full',
          unread ? 'bg-[var(--bladevault-title)]' : 'bg-transparent',
        )}
      />
      <KnifeThumb knife={knife} tone={tone} size={compact ? 'sm' : 'md'} />
      <div className="min-w-0 flex-1">
        <Link
          href={href}
          onClick={() => {
            if (unread) onAction({ action: 'read', ids })
            onNavigate?.()
          }}
          className={cn(
            'block truncate text-sm text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            unread ? 'font-semibold' : 'font-medium',
          )}
        >
          {knifeLabel(knife)}
          {unread && <span className="sr-only"> (unread)</span>}
        </Link>
        <p
          className={cn(
            'text-xs font-medium',
            box === 'done' ? 'text-muted-foreground' : careToneTextClass(tone),
          )}
        >
          {careMessageHeadline(notification, now)}
        </p>
        {!compact && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {careMessageDetail(notification, now)}
          </p>
        )}
        {!compact && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {box === 'open' && (
              <>
                <Button
                  type="button"
                  size="xs"
                  onClick={onLog}
                  disabled={busy}
                  data-care-log
                >
                  {busy ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Check className="size-3" />
                  )}
                  Log {CARE_TRACK_NAMES[notification.track].toLowerCase()} today
                </Button>
                <SnoozeMenu
                  onSnooze={(days) => onAction({ action: 'snooze', ids, days })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => onAction({ action: 'dismiss', ids })}
                >
                  <X className="size-3" />
                  Dismiss
                </Button>
              </>
            )}
            {box === 'snoozed' && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => onAction({ action: 'unsnooze', ids })}
              >
                <Bell className="size-3" />
                Show now
              </Button>
            )}
            {box === 'done' &&
              notification.dismissedAt &&
              !notification.resolvedAt && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => onAction({ action: 'restore', ids })}
                >
                  <RotateCcw className="size-3" />
                  Move back to inbox
                </Button>
              )}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {formatWhen(notification.createdAt, now)}
        </span>
        {compact && box === 'open' && (
          <Button
            type="button"
            size="xs"
            onClick={onLog}
            disabled={busy}
            aria-label={`Log ${CARE_TRACK_NAMES[notification.track].toLowerCase()} for ${knifeLabel(knife)} today`}
            title="Log this care for today"
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : 'Log'}
          </Button>
        )}
      </div>
    </li>
  )
}

/** Unread count for nav rows; renders nothing when there is nothing new. */
export function CareInboxCount({ className }: { className?: string }) {
  const { enabled, unreadCount } = useCareInbox()
  if (!enabled || unreadCount === 0) return null
  return (
    <span
      data-care-inbox-count
      className={cn(
        'inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white',
        className,
      )}
    >
      {unreadCount > 99 ? '99+' : unreadCount}
      <span className="sr-only"> unread</span>
    </span>
  )
}

const POPOVER_LIMIT = 5

/**
 * Header bell with the unread count; opens the newest open messages. Extra
 * props style the trigger like its neighbours in each shell's header.
 */
export function CareInboxBell({
  className,
  ...triggerProps
}: Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'type' | 'onClick' | 'children'
> & { [dataAttribute: `data-${string}`]: string | undefined }) {
  const { enabled, notifications, now, unreadCount, counts } = useCareInbox()
  const knivesById = useInboxKnives()
  const { run, log, busyId } = useInboxAction()
  const [open, setOpen] = useState(false)
  const openMessages = useMemo(
    () =>
      sortCareNotifications(
        notifications.filter(
          (row) => getCareNotificationBox(row, now) === 'open',
        ),
        'open',
      ),
    [notifications, now],
  )
  if (!enabled) return null
  const label =
    unreadCount > 0
      ? `Care inbox, ${plural(unreadCount, 'unread message')}`
      : 'Care inbox'
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        {...triggerProps}
        data-care-inbox-bell
        aria-label={label}
        title={label}
        className={cn('relative', className)}
      >
        <Bell />
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-none text-white ring-2 ring-background"
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={8} className="z-50">
          <Popover.Popup
            aria-label="Care inbox"
            className="w-[min(24rem,calc(100vw-1.5rem))] origin-(--transform-origin) overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
              <Popover.Title className="text-sm font-semibold">
                Care inbox
              </Popover.Title>
              <span className="text-xs text-muted-foreground">
                {counts.open
                  ? `${counts.open} open${unreadCount ? ` · ${unreadCount} unread` : ''}`
                  : 'All caught up'}
              </span>
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={() => void run({ action: 'read-all' })}
                  className="ml-auto rounded text-xs font-medium text-[var(--bladevault-title)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Mark all read
                </button>
              )}
            </div>
            {openMessages.length ? (
              <ul className="max-h-[min(22rem,60dvh)] divide-y divide-border overflow-y-auto">
                {openMessages.slice(0, POPOVER_LIMIT).map((notification) => (
                  <CareMessageRow
                    key={notification.id}
                    notification={notification}
                    knife={knivesById.get(notification.knifeId)}
                    now={now}
                    compact
                    busy={busyId === notification.id}
                    onAction={(action) => void run(action)}
                    onLog={() => void log(notification)}
                    onNavigate={() => setOpen(false)}
                  />
                ))}
              </ul>
            ) : (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                Nothing is due. Every tracked knife is inside its care interval.
              </p>
            )}
            <div className="flex items-center justify-between gap-2 border-t border-border bg-muted/30 px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                {openMessages.length > POPOVER_LIMIT
                  ? `${openMessages.length - POPOVER_LIMIT} more in the inbox`
                  : counts.snoozed
                    ? `${counts.snoozed} snoozed`
                    : ''}
              </span>
              <Link
                href="/inbox"
                onClick={() => setOpen(false)}
                className="font-medium text-[var(--bladevault-title)] underline-offset-2 hover:underline"
              >
                Open inbox →
              </Link>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

const BOX_TABS: readonly { box: CareNotificationBox; label: string }[] = [
  { box: 'open', label: 'Open' },
  { box: 'snoozed', label: 'Snoozed' },
  { box: 'done', label: 'Done' },
]

const EMPTY_TEXT: Record<CareNotificationBox, string> = {
  open: 'All caught up. Nothing is due right now.',
  snoozed: 'No snoozed reminders.',
  done: 'Logged, dismissed and expired reminders show up here for 90 days.',
}

/** Full Inbox page: open, snoozed and done care reminders. */
export function CareInboxView() {
  const { enabled, isLoading, notifications, now, unreadCount, counts } =
    useCareInbox()
  const knivesById = useInboxKnives()
  const { run, log, busyId } = useInboxAction()
  const [box, setBox] = useState<CareNotificationBox>('open')
  const visible = useMemo(
    () =>
      sortCareNotifications(
        notifications.filter((row) => getCareNotificationBox(row, now) === box),
        box,
      ),
    [notifications, now, box],
  )

  if (!enabled) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        Care reminders are off. Turn them on in{' '}
        <Link href="/settings" className="underline underline-offset-2">
          Settings → Maintenance
        </Link>{' '}
        to get messages when a knife is due.
      </p>
    )
  }

  return (
    <div data-care-inbox className="w-full max-w-3xl">
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <div
          role="group"
          aria-label="Show reminders"
          className="flex flex-wrap gap-1.5"
        >
          {BOX_TABS.map((tab) => (
            <button
              key={tab.box}
              type="button"
              aria-pressed={box === tab.box}
              onClick={() => setBox(tab.box)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                box === tab.box &&
                  'border-transparent bg-[var(--bladevault-nav-active-bg)] text-[var(--bladevault-nav-active-fg)] hover:text-[var(--bladevault-nav-active-fg)]',
              )}
            >
              {tab.label}
              <span className="font-semibold tabular-nums">
                {counts[tab.box]}
              </span>
            </button>
          ))}
        </div>
        {unreadCount > 0 && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="ml-auto"
            onClick={() => void run({ action: 'read-all' })}
          >
            <Check className="size-3" />
            Mark all read
          </Button>
        )}
      </div>
      <div className="overflow-hidden rounded-xl border border-[var(--bladevault-line)]/70 bg-card">
        {isLoading && notifications.length === 0 ? (
          <p
            role="status"
            className="px-4 py-10 text-center text-sm text-muted-foreground"
          >
            Checking care reminders…
          </p>
        ) : visible.length ? (
          <ul className="divide-y divide-border" aria-live="polite">
            {visible.map((notification) => (
              <CareMessageRow
                key={notification.id}
                notification={notification}
                knife={knivesById.get(notification.knifeId)}
                now={now}
                busy={busyId === notification.id}
                onAction={(action) => void run(action)}
                onLog={() => void log(notification)}
              />
            ))}
          </ul>
        ) : (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center text-sm text-muted-foreground">
            <Inbox className="size-6 opacity-60" aria-hidden="true" />
            {EMPTY_TEXT[box]}
          </div>
        )}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        A reminder arrives when a knife turns due soon or overdue, and resolves
        itself once that care is logged.
      </p>
    </div>
  )
}
