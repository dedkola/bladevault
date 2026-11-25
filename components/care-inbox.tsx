'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useMemo, useState } from 'react'
import { Popover } from '@base-ui/react/popover'
import { Menu } from '@base-ui/react/menu'
import {
  Bell,
  BellOff,
  Check,
  ChevronDown,
  CloudAlert,
  CloudCheck,
  CloudDownload,
  CircleAlert,
  CircleCheck,
  CheckCheck,
  ExternalLink,
  ImageIcon,
  Inbox,
  Lightbulb,
  LineChart,
  Loader2,
  MessageCircleQuestion,
  RotateCcw,
  Settings,
  Sparkles,
  Trophy,
  UploadCloud,
  X,
} from 'lucide-react'
import Image from '@/components/vault-image'
import { Button } from '@/components/ui/button'
import { useKnives } from '@/components/providers/knives-provider'
import {
  useCareInbox,
  type InboxPopup,
} from '@/components/providers/care-inbox-provider'
import { careToneDotClass, careToneTextClass } from '@/components/care-badge'
import { AchievementBadge } from '@/components/achievement-badge'
import {
  ACHIEVEMENTS_HREF,
  achievementIdFromMessageKey,
} from '@/lib/achievements/messages'
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
import {
  getSystemMessageBox,
  isOpenPriceQuestion,
  isSystemMessageUnread,
  sortSystemMessages,
  systemMessageTime,
  type PriceAgentNote,
  type SystemMessage,
  type SystemMessageAction,
} from '@/lib/system-messages'
import {
  getPriceNotificationBox,
  isPriceNotificationUnread,
  PRICE_SNOOZE_OPTIONS,
  PRICE_SOURCE_MUTE_OPTIONS,
  priceNotificationTime,
  sortPriceNotifications,
  type PriceNotificationAction,
  type PriceNotificationView,
} from '@/lib/price-monitor/notifications'
import { CARE_TRACK_NAMES, CARE_TRACK_PAST } from '@/lib/settings-shared'
import { cn } from '@/lib/utils'
import {
  ChangePill,
  KnifeThumb as PriceKnifeThumb,
} from '@/components/price-drops/price-ui'
import { money, storeLabel } from '@/components/price-drops/price-format'
import '@/components/price-drops/price-drops.css'

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
  const { act, actSystem, actPrice, muteSource, logCare } = useCareInbox()
  const { showFeedback } = useKnives()
  const [busyId, setBusyId] = useState<number | null>(null)
  const report = (error: unknown) =>
    showFeedback(
      error instanceof Error ? error.message : 'Could not update the inbox',
      'error',
    )
  const run = async (action: CareNotificationAction) => {
    try {
      await act(action)
    } catch (error) {
      report(error)
    }
  }
  const runSystem = async (action: SystemMessageAction) => {
    try {
      await actSystem(action)
    } catch (error) {
      report(error)
    }
  }
  const runPrice = async (action: PriceNotificationAction) => {
    try {
      await actPrice(action)
    } catch (error) {
      report(error)
    }
  }
  const mutePriceSource = async (row: PriceNotificationView, days: number) => {
    try {
      await muteSource(row.event.knife.id, row.sourceId, days)
      const until = formatShortDate(
        new Date(Date.now() + days * 86_400_000),
        new Date(),
      )
      showFeedback(
        days
          ? `${storeLabel(row.event.storeName)} muted for this knife until ${until}.`
          : `${storeLabel(row.event.storeName)} notifies again.`,
        'success',
      )
    } catch (error) {
      report(error)
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
  return { run, runSystem, runPrice, mutePriceSource, log, busyId }
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

const MENU_ITEM_CLASS =
  'flex cursor-default items-center rounded-md px-2 py-1.5 outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground'
const MENU_LABEL_CLASS =
  'px-2 pt-1 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground'

/** Snooze one price message, or mute its store for this knife for a while. */
function PriceSnoozeMenu({
  onSnooze,
  onMute,
}: {
  onSnooze: (days: number) => void
  onMute: (days: number) => void
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        render={<Button type="button" variant="outline" size="xs" />}
      >
        Snooze
        <ChevronDown className="size-3" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="isolate z-50">
          <Menu.Popup className="w-48 origin-(--transform-origin) rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            <Menu.Group>
              <Menu.GroupLabel className={MENU_LABEL_CLASS}>
                Snooze message until
              </Menu.GroupLabel>
              {PRICE_SNOOZE_OPTIONS.map((option) => (
                <Menu.Item
                  key={option.days}
                  onClick={() => onSnooze(option.days)}
                  className={MENU_ITEM_CLASS}
                >
                  {option.label}
                </Menu.Item>
              ))}
            </Menu.Group>
            <Menu.Separator className="mx-1 my-1 h-px bg-border" />
            <Menu.Group>
              <Menu.GroupLabel className={MENU_LABEL_CLASS}>
                Mute this store for
              </Menu.GroupLabel>
              {PRICE_SOURCE_MUTE_OPTIONS.map((option) => (
                <Menu.Item
                  key={option.days}
                  onClick={() => onMute(option.days)}
                  className={MENU_ITEM_CLASS}
                >
                  {option.label}
                </Menu.Item>
              ))}
            </Menu.Group>
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

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : ''
}

const SYSTEM_MESSAGE_HREF: Record<SystemMessage['kind'], string> = {
  'backup-failed': '/settings?tab=backup',
  'backup-success': '/settings?tab=backup',
  'restore-success': '/settings?tab=backup',
  'price-attention': '/price-drops?section=attention',
  'price-digest': '/price-drops',
  achievement: ACHIEVEMENTS_HREF,
  'price-advice': '/price-drops',
  'price-question': '/price-drops',
}

/** AI supervisor messages open the knife's Price Drops details. */
function systemMessageHref(message: SystemMessage): string {
  return message.payload
    ? `/price-drops?knife=${encodeURIComponent(message.payload.knifeId)}`
    : SYSTEM_MESSAGE_HREF[message.kind]
}

/** Messages written by AI: calm colours instead of the problem red. */
const AI_MESSAGE_KINDS: ReadonlySet<SystemMessage['kind']> = new Set([
  'price-digest',
  'price-advice',
  'price-question',
])

/** Good news, e.g. a finished backup: green instead of the problem red. */
const SUCCESS_MESSAGE_KINDS: ReadonlySet<SystemMessage['kind']> = new Set([
  'backup-success',
  'restore-success',
])

/** The two buttons of an AI question: Yes first. */
function questionAnswers(
  payload: Extract<PriceAgentNote, { type: 'question' }>,
): { yes: string; no: string } {
  switch (payload.ask) {
    case 'set_target':
      return {
        yes: `Set ${money(payload.priceMinor, payload.currency)} target`,
        no: 'No thanks',
      }
    case 'watch_closely':
      return { yes: 'Watch closely', no: 'Not now' }
    case 'keep_listing':
      return { yes: 'Keep listing', no: 'Pause listing' }
    case 'relink':
      return { yes: 'Use new link', no: 'Keep old link' }
  }
}

function systemMessageDetail(message: SystemMessage, now: Date): string {
  const when = `${formatWhen(message.occurredAt, now)}, ${formatTime(message.occurredAt)}`
  const repeats =
    message.occurrences > 1
      ? `Happened ${plural(message.occurrences, 'time')}, last ${when.toLowerCase()}`
      : when
  if (message.kind === 'price-question' && message.resolvedAt) {
    const answers =
      message.payload?.type === 'question'
        ? questionAnswers(message.payload)
        : { yes: 'Yes', no: 'No' }
    return message.answer
      ? `Answered “${message.answer === 'yes' ? answers.yes : answers.no}” on ${formatShortDate(message.resolvedAt, now)}`
      : `Closed unanswered on ${formatShortDate(message.resolvedAt, now)}`
  }
  if (message.kind === 'price-advice' || message.kind === 'price-question') {
    const label = message.kind === 'price-advice' ? 'AI advice' : 'AI question'
    return message.dismissedAt
      ? `${label} · ${when} · dismissed`
      : `${label} · ${when}`
  }
  if (SUCCESS_MESSAGE_KINDS.has(message.kind)) {
    const label = message.kind === 'backup-success' ? 'Backed up' : 'Restored'
    if (message.resolvedAt)
      return `${label} ${formatShortDate(message.occurredAt, now)}, ${formatTime(message.occurredAt)} · replaced by a newer one`
    return message.dismissedAt
      ? `${label} ${when.toLowerCase()} · dismissed`
      : `${label} ${when.toLowerCase()}`
  }
  if (message.resolvedAt) {
    return message.kind === 'backup-failed'
      ? `A later backup worked on ${formatShortDate(message.resolvedAt, now)}, ${formatTime(message.resolvedAt)}`
      : message.kind === 'price-attention'
        ? `Every store page read fine again on ${formatShortDate(message.resolvedAt, now)}, ${formatTime(message.resolvedAt)}`
        : message.kind === 'price-digest'
          ? `AI summary of ${formatShortDate(message.occurredAt, now)}, replaced by a newer one`
          : `Resolved ${formatShortDate(message.resolvedAt, now)}`
  }
  if (message.kind === 'achievement')
    return message.dismissedAt
      ? `Unlocked ${when.toLowerCase()} · dismissed`
      : `Unlocked ${when.toLowerCase()}`
  if (message.kind === 'price-digest')
    return message.dismissedAt
      ? `AI summary · ${when} · dismissed`
      : `AI summary · ${when}`
  if (message.dismissedAt) return `${repeats} · dismissed`
  return repeats
}

function SystemMessageIcon({
  message,
  size = 'md',
}: {
  message: SystemMessage
  size?: 'sm' | 'md'
}) {
  const resolved = Boolean(message.resolvedAt)
  const open = getSystemMessageBox(message) === 'open'
  if (message.kind === 'achievement') {
    const id = achievementIdFromMessageKey(message.key)
    return id ? (
      <AchievementBadge id={id} size={size === 'sm' ? 'sm' : 'md'} />
    ) : (
      <span
        className={cn(
          'grid shrink-0 place-items-center rounded-lg border border-[var(--bladevault-line)]/70 bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400',
          size === 'sm' ? 'size-9' : 'size-11',
        )}
      >
        <Trophy className={size === 'sm' ? 'size-4' : 'size-5'} />
      </span>
    )
  }
  if (SUCCESS_MESSAGE_KINDS.has(message.kind)) {
    const Icon = message.kind === 'restore-success' ? CloudDownload : CloudCheck
    return (
      <span
        className={cn(
          'grid shrink-0 place-items-center rounded-lg border border-[var(--bladevault-line)]/70',
          size === 'sm' ? 'size-9' : 'size-11',
          open
            ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400'
            : 'bg-muted/30 text-muted-foreground',
        )}
      >
        <Icon className={size === 'sm' ? 'size-4' : 'size-5'} />
      </span>
    )
  }
  const digest = AI_MESSAGE_KINDS.has(message.kind)
  const Icon = digest
    ? message.kind === 'price-question'
      ? MessageCircleQuestion
      : message.kind === 'price-advice'
        ? Lightbulb
        : Sparkles
    : message.kind === 'price-attention'
      ? resolved
        ? CircleCheck
        : CircleAlert
      : resolved
        ? CloudCheck
        : CloudAlert
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center rounded-lg border border-[var(--bladevault-line)]/70',
        size === 'sm' ? 'size-9' : 'size-11',
        open && digest
          ? 'bg-sky-50 text-sky-600 dark:bg-sky-950/40 dark:text-sky-400'
          : open
            ? 'bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400'
            : resolved && !digest
              ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400'
              : 'bg-muted/30 text-muted-foreground',
      )}
    >
      <Icon className={size === 'sm' ? 'size-4' : 'size-5'} />
    </span>
  )
}

function SystemMessageRow({
  message,
  now,
  compact = false,
  onAction,
  onNavigate,
}: {
  message: SystemMessage
  now: Date
  compact?: boolean
  onAction: (action: SystemMessageAction) => void
  onNavigate?: () => void
}) {
  const { startVaultBackup, cloudBackupJob } = useKnives()
  const box = getSystemMessageBox(message)
  const unread = isSystemMessageUnread(message)
  const ids = [message.id]
  const backingUp = cloudBackupJob.status === 'running'
  const markRead = () => {
    if (unread) onAction({ action: 'read', ids })
  }
  return (
    <li
      data-system-message={box}
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
      <SystemMessageIcon message={message} size={compact ? 'sm' : 'md'} />
      <div className="min-w-0 flex-1">
        <Link
          href={systemMessageHref(message)}
          onClick={() => {
            markRead()
            onNavigate?.()
          }}
          className={cn(
            'block truncate text-sm text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            unread ? 'font-semibold' : 'font-medium',
          )}
        >
          {message.title}
          {unread && <span className="sr-only"> (unread)</span>}
        </Link>
        <p
          className={cn(
            'text-xs font-medium',
            box === 'done'
              ? 'text-muted-foreground'
              : AI_MESSAGE_KINDS.has(message.kind) ||
                  SUCCESS_MESSAGE_KINDS.has(message.kind) ||
                  message.kind === 'achievement'
                ? 'text-foreground/80'
                : 'text-red-600 dark:text-red-400',
            compact && 'truncate',
          )}
        >
          {message.detail}
        </p>
        {!compact && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {systemMessageDetail(message, now)}
          </p>
        )}
        {!compact && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {box === 'open' && message.kind === 'backup-failed' && (
              <>
                <Button
                  type="button"
                  size="xs"
                  disabled={backingUp}
                  onClick={() => {
                    markRead()
                    void startVaultBackup()
                  }}
                >
                  {backingUp ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <UploadCloud className="size-3" />
                  )}
                  {backingUp ? 'Backing up…' : 'Back up now'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  render={
                    <Link href="/settings?tab=backup" onClick={markRead} />
                  }
                  nativeButton={false}
                >
                  <Settings className="size-3" />
                  Backup settings
                </Button>
              </>
            )}
            {box === 'open' && message.kind === 'price-attention' && (
              <Button
                type="button"
                size="xs"
                render={
                  <Link
                    href={SYSTEM_MESSAGE_HREF['price-attention']}
                    onClick={markRead}
                  />
                }
                nativeButton={false}
              >
                <LineChart className="size-3" />
                Open Needs attention
              </Button>
            )}
            {isOpenPriceQuestion(message) &&
              message.payload?.type === 'question' && (
                <>
                  <Button
                    type="button"
                    size="xs"
                    onClick={() =>
                      onAction({
                        action: 'answer',
                        id: message.id,
                        answer: 'yes',
                      })
                    }
                  >
                    <Check className="size-3" />
                    {questionAnswers(message.payload).yes}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() =>
                      onAction({
                        action: 'answer',
                        id: message.id,
                        answer: 'no',
                      })
                    }
                  >
                    {questionAnswers(message.payload).no}
                  </Button>
                </>
              )}
            {box === 'open' && message.kind === 'price-advice' && (
              <Button
                type="button"
                size="xs"
                render={
                  <Link href={systemMessageHref(message)} onClick={markRead} />
                }
                nativeButton={false}
              >
                <LineChart className="size-3" />
                Open market
              </Button>
            )}
            {box === 'open' && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onAction({ action: 'dismiss', ids })}
              >
                <X className="size-3" />
                Dismiss
              </Button>
            )}
            {box === 'done' && message.dismissedAt && !message.resolvedAt && (
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
      <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
        {formatWhen(message.occurredAt, now)}
      </span>
    </li>
  )
}

const PRICE_HEADLINE: Record<PriceNotificationView['kind'], string> = {
  drop: 'Price dropped',
  increase: 'Price went up',
  out_of_stock: 'Out of stock',
  back_in_stock: 'Back in stock',
}

const PRICE_REPEAT: Record<PriceNotificationView['kind'], string> = {
  drop: 'Dropped',
  increase: 'Went up',
  out_of_stock: 'Sold out',
  back_in_stock: 'Restocked',
}

const PRICE_RESOLVED: Record<PriceNotificationView['kind'], string> = {
  drop: 'The price went up again',
  increase: 'The price dropped again',
  out_of_stock: 'Back in stock',
  back_in_stock: 'Out of stock again',
}

function priceKnifeLabel(row: PriceNotificationView): string {
  const { knife } = row.event
  return knife.brand ? `${knife.brand} ${knife.name}` : knife.name
}

/** “$129.00 → $109.00” for price changes, the shown price for stock. */
function priceChangeText(row: PriceNotificationView): string {
  const { event } = row
  if (event.type === 'price')
    return `${money(event.previousPriceMinor, event.currency)} → ${money(event.priceMinor, event.currency)}`
  return event.priceMinor !== null && event.currency
    ? money(event.priceMinor, event.currency)
    : ''
}

function priceNotificationDetail(
  row: PriceNotificationView,
  now: Date,
): string {
  const when = `${formatWhen(row.occurredAt, now)}, ${formatTime(row.occurredAt)}`
  const repeats =
    row.occurrences > 1
      ? `${PRICE_REPEAT[row.kind]} ${plural(row.occurrences, 'time')}, last ${when.toLowerCase()}`
      : when
  if (row.resolvedAt)
    return `${PRICE_RESOLVED[row.kind]} on ${formatShortDate(row.resolvedAt, now)}, ${formatTime(row.resolvedAt)}`
  if (row.dismissedAt) return `${repeats} · dismissed`
  if (row.snoozedUntil && Date.parse(row.snoozedUntil) > now.getTime())
    return `${repeats} · snoozed until ${formatShortDate(row.snoozedUntil, now)}`
  return repeats
}

/**
 * “$10.00 below regular price ($120.00) · Lowest seen $99.00”: how the new
 * price compares, in the event's currency only, plus any mute.
 */
function priceContextParts(row: PriceNotificationView, now: Date): string[] {
  const { event, context } = row
  const parts: string[] = []
  if (event.currency && event.priceMinor !== null) {
    if (context.paidMinor !== null) {
      const diff = event.priceMinor - context.paidMinor
      parts.push(
        diff === 0
          ? `Same as regular price (${money(context.paidMinor, event.currency)})`
          : `${money(Math.abs(diff), event.currency)} ${diff < 0 ? 'below' : 'above'} regular price (${money(context.paidMinor, event.currency)})`,
      )
    }
    if (context.lowestMinor !== null) {
      parts.push(
        event.priceMinor <= context.lowestMinor
          ? 'Lowest price seen at this store'
          : `Lowest seen ${money(context.lowestMinor, event.currency)}`,
      )
    }
  }
  if (event.previousStoreName)
    parts.push(
      row.kind === 'drop'
        ? `Cheaper than ${storeLabel(event.previousStoreName)}`
        : `${storeLabel(event.previousStoreName)} is out of stock`,
    )
  if (
    row.kind === 'out_of_stock' &&
    !row.resolvedAt &&
    (context.storeCount ?? 0) > 1
  )
    parts.push(`Out of stock at all ${context.storeCount} stores`)
  if (context.knifeMuted) parts.push('Knife muted')
  else if (
    context.sourceMutedUntil &&
    Date.parse(context.sourceMutedUntil) > now.getTime()
  )
    parts.push(
      `Store muted until ${formatShortDate(context.sourceMutedUntil, now)}`,
    )
  return parts
}

function PriceNotificationRow({
  notification,
  now,
  compact = false,
  onAction,
  onMuteSource,
  onNavigate,
}: {
  notification: PriceNotificationView
  now: Date
  compact?: boolean
  onAction: (action: PriceNotificationAction) => void
  onMuteSource?: (days: number) => void
  onNavigate?: () => void
}) {
  const box = getPriceNotificationBox(notification, now)
  const unread = isPriceNotificationUnread(notification, now)
  const contextParts = compact ? [] : priceContextParts(notification, now)
  const ids = [notification.id]
  const { event } = notification
  // The knife's Price Drops details: chart and every store in one place.
  const marketHref = `/price-drops?knife=${encodeURIComponent(event.knife.id)}`
  const markRead = () => {
    if (unread) onAction({ action: 'read', ids })
  }
  const change = priceChangeText(notification)
  return (
    <li
      data-price-notification={box}
      data-price-kind={notification.kind}
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
      <PriceKnifeThumb
        knife={event.knife}
        className={cn(
          'border border-[var(--bladevault-line)]/70',
          compact ? 'size-9' : 'size-11',
        )}
      />
      <div className="min-w-0 flex-1">
        <Link
          href={marketHref}
          onClick={() => {
            markRead()
            onNavigate?.()
          }}
          className={cn(
            'block truncate text-sm text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            unread ? 'font-semibold' : 'font-medium',
          )}
        >
          {priceKnifeLabel(notification)}
          {unread && <span className="sr-only"> (unread)</span>}
        </Link>
        <p
          className={cn(
            'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs',
            box === 'done' ? 'text-muted-foreground' : 'text-foreground',
          )}
        >
          <span className="sr-only">{PRICE_HEADLINE[notification.kind]}: </span>
          <span className="truncate text-muted-foreground">
            {storeLabel(event.storeName)}
          </span>
          {change && (
            <span className="font-medium whitespace-nowrap tabular-nums">
              {change}
            </span>
          )}
          <ChangePill event={event} />
        </p>
        {!compact && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {priceNotificationDetail(notification, now)}
          </p>
        )}
        {contextParts.length > 0 && (
          <p
            data-price-context
            className="mt-0.5 text-xs text-muted-foreground"
          >
            {contextParts.join(' · ')}
          </p>
        )}
        {!compact && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="xs"
              render={<Link href={marketHref} onClick={markRead} />}
              nativeButton={false}
            >
              <LineChart className="size-3" />
              Market
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              render={
                <a
                  href={event.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={markRead}
                />
              }
              nativeButton={false}
            >
              <ExternalLink className="size-3" />
              Store page
              <span className="sr-only"> (opens in a new tab)</span>
            </Button>
            {unread && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={markRead}
              >
                <Check className="size-3" />
                Mark read
              </Button>
            )}
            {box === 'open' && onMuteSource && (
              <PriceSnoozeMenu
                onSnooze={(days) => onAction({ action: 'snooze', ids, days })}
                onMute={onMuteSource}
              />
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
            {box !== 'done' && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onAction({ action: 'dismiss', ids })}
              >
                <X className="size-3" />
                Dismiss
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
      <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
        {formatWhen(notification.occurredAt, now)}
      </span>
    </li>
  )
}

/** Unread count for nav rows; renders nothing when there is nothing new. */
export function CareInboxCount({ className }: { className?: string }) {
  const { visible, unreadCount } = useCareInbox()
  if (!visible || unreadCount === 0) return null
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

type InboxItem =
  | { type: 'care'; at: string; row: CareNotification }
  | { type: 'system'; at: string; row: SystemMessage }
  | { type: 'price'; at: string; row: PriceNotificationView }

function inboxItemKey(item: InboxItem) {
  return `${item.type}-${item.row.id}`
}

/**
 * Footer bell with the unread count; opens the newest open messages, system
 * problems first. Extra props style the trigger like its footer neighbours.
 */
export function CareInboxBell({
  className,
  popupSide = 'bottom',
  popupAlign = 'end',
  ...triggerProps
}: Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'type' | 'onClick' | 'children'
> & {
  /** Where the panel opens: below a header bell, above a footer one. */
  popupSide?: 'top' | 'bottom'
  popupAlign?: 'start' | 'end'
} & { [dataAttribute: `data-${string}`]: string | undefined }) {
  const {
    visible,
    enabled,
    notifications,
    systemMessages,
    priceNotifications,
    now,
    unreadCount,
    careUnreadCount,
    systemUnreadCount,
    achievementUnreadCount,
    priceUnreadCount,
    counts,
    systemCounts,
    achievementCounts,
    priceCounts,
  } = useCareInbox()
  const knivesById = useInboxKnives()
  const { run, runSystem, runPrice, log, busyId } = useInboxAction()
  const [open, setOpen] = useState(false)
  const openItems = useMemo<InboxItem[]>(
    () => [
      ...sortSystemMessages(
        systemMessages.filter((row) => getSystemMessageBox(row) === 'open'),
      ).map((row) => ({ type: 'system' as const, at: row.occurredAt, row })),
      ...sortPriceNotifications(
        priceNotifications.filter(
          (row) => getPriceNotificationBox(row, now) === 'open',
        ),
      ).map((row) => ({ type: 'price' as const, at: row.occurredAt, row })),
      ...(enabled
        ? sortCareNotifications(
            notifications.filter(
              (row) => getCareNotificationBox(row, now) === 'open',
            ),
            'open',
          ).map((row) => ({ type: 'care' as const, at: row.createdAt, row }))
        : []),
    ],
    [enabled, notifications, systemMessages, priceNotifications, now],
  )
  if (!visible) return null
  const openCount =
    (enabled ? counts.open : 0) +
    systemCounts.open +
    achievementCounts.open +
    priceCounts.open
  const label =
    unreadCount > 0
      ? `Inbox, ${plural(unreadCount, 'unread message')}`
      : 'Inbox'
  const markAllRead = () => {
    if (enabled && careUnreadCount > 0) void run({ action: 'read-all' })
    if (systemUnreadCount + achievementUnreadCount > 0)
      void runSystem({ action: 'read-all' })
    if (priceUnreadCount > 0) void runPrice({ action: 'read-all' })
  }
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
        <Popover.Positioner
          side={popupSide}
          align={popupAlign}
          sideOffset={8}
          className="z-50"
        >
          <Popover.Popup
            aria-label="Inbox"
            className="w-[min(24rem,calc(100vw-1.5rem))] origin-(--transform-origin) overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
              <Popover.Title className="text-sm font-semibold">
                Inbox
              </Popover.Title>
              <span className="text-xs text-muted-foreground">
                {openCount
                  ? `${openCount} open${unreadCount ? ` · ${unreadCount} unread` : ''}`
                  : 'All caught up'}
              </span>
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={markAllRead}
                  className="ml-auto rounded text-xs font-medium text-[var(--bladevault-title)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Mark all read
                </button>
              )}
            </div>
            {openItems.length ? (
              <ul className="max-h-[min(22rem,60dvh)] divide-y divide-border overflow-y-auto">
                {openItems
                  .slice(0, POPOVER_LIMIT)
                  .map((item) =>
                    item.type === 'system' ? (
                      <SystemMessageRow
                        key={inboxItemKey(item)}
                        message={item.row}
                        now={now}
                        compact
                        onAction={(action) => void runSystem(action)}
                        onNavigate={() => setOpen(false)}
                      />
                    ) : item.type === 'price' ? (
                      <PriceNotificationRow
                        key={inboxItemKey(item)}
                        notification={item.row}
                        now={now}
                        compact
                        onAction={(action) => void runPrice(action)}
                        onNavigate={() => setOpen(false)}
                      />
                    ) : (
                      <CareMessageRow
                        key={inboxItemKey(item)}
                        notification={item.row}
                        knife={knivesById.get(item.row.knifeId)}
                        now={now}
                        compact
                        busy={busyId === item.row.id}
                        onAction={(action) => void run(action)}
                        onLog={() => void log(item.row)}
                        onNavigate={() => setOpen(false)}
                      />
                    ),
                  )}
              </ul>
            ) : (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                {enabled
                  ? 'Nothing needs attention. Every tracked knife is inside its care interval.'
                  : 'Nothing needs attention.'}
              </p>
            )}
            <div className="flex items-center justify-between gap-2 border-t border-border bg-muted/30 px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                {openItems.length > POPOVER_LIMIT
                  ? `${openItems.length - POPOVER_LIMIT} more in the inbox`
                  : enabled && counts.snoozed
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

/** How many pop-ups stack before the rest collapse into “+N more”. */
const POPUP_LIMIT = 3

const POPUP_LABEL: Record<InboxPopup['type'], string> = {
  price: 'Prices',
  care: 'Care',
  system: 'System',
}

function popupTime(popup: InboxPopup): string {
  return popup.type === 'care' ? popup.row.createdAt : popup.row.occurredAt
}

/** “now”, “5m ago”, “2h ago”, then the date. */
function formatPopupAge(value: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(value)) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`
  return formatWhen(value, now)
}

function InboxPopupCard({
  popup,
  now,
  onClose,
}: {
  popup: InboxPopup
  now: Date
  onClose: () => void
}) {
  const knivesById = useInboxKnives()
  const { run, runSystem, runPrice, log, busyId } = useInboxAction()
  // The whole card opens the message, like the title link inside it.
  const openFromCard = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('a, button')) return
    event.currentTarget.querySelector<HTMLAnchorElement>('a[href]')?.click()
  }
  return (
    <div
      data-inbox-popup={popup.type}
      onClick={openFromCard}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
      }}
      className={cn(
        'group pointer-events-auto relative w-full cursor-pointer rounded-xl border border-border bg-popover text-popover-foreground',
        'shadow-[0_14px_40px_rgba(0,0,0,0.18),0_2px_8px_rgba(0,0,0,0.08)] transition-colors hover:border-[var(--bladevault-line)]',
        'animate-in fade-in slide-in-from-right-8 duration-300 motion-reduce:animate-none',
      )}
    >
      <div className="flex items-center justify-between px-3 pt-2 text-[11px] text-muted-foreground">
        <span className="font-semibold uppercase tracking-[0.08em]">
          {POPUP_LABEL[popup.type]}
        </span>
        <span>{formatPopupAge(popupTime(popup), now)}</span>
      </div>
      <ul className="[&>li]:pt-1.5">
        {popup.type === 'system' ? (
          <SystemMessageRow
            message={popup.row}
            now={now}
            compact
            onAction={(action) => void runSystem(action)}
            onNavigate={onClose}
          />
        ) : popup.type === 'price' ? (
          <PriceNotificationRow
            notification={popup.row}
            now={now}
            compact
            onAction={(action) => void runPrice(action)}
            onNavigate={onClose}
          />
        ) : (
          <CareMessageRow
            notification={popup.row}
            knife={knivesById.get(popup.row.knifeId)}
            now={now}
            compact
            busy={busyId === popup.row.id}
            onAction={(action) => void run(action)}
            onLog={() => void log(popup.row)}
            onNavigate={onClose}
          />
        )}
      </ul>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close notification"
        title="Close"
        className={cn(
          'absolute -top-2 -left-2 grid size-5 place-items-center rounded-full border border-border bg-popover text-muted-foreground shadow-sm',
          'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100',
          'hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

/**
 * New Inbox messages as cards at the top right, newest first, like macOS
 * notifications. Each stays until closed or opened; opening marks it read.
 * Pop-ups are turned off in Settings → Notifications.
 */
export function InboxPopups() {
  const { popups, now, dismissPopup, clearPopups } = useCareInbox()
  if (popups.length === 0) return null
  const more = popups.length - POPUP_LIMIT
  return (
    <section
      aria-label="New notifications"
      aria-live="polite"
      data-inbox-popups
      className="pointer-events-none fixed top-4 right-4 left-4 z-[58] flex flex-col items-end gap-2.5 sm:left-auto sm:w-[22rem]"
    >
      {popups.slice(0, POPUP_LIMIT).map((popup) => (
        <InboxPopupCard
          key={popup.key}
          popup={popup}
          now={now}
          onClose={() => dismissPopup(popup.key)}
        />
      ))}
      {more > 0 && (
        <div className="pointer-events-auto flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-popover px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
          <Link
            href="/inbox"
            onClick={clearPopups}
            className="font-medium underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            +{more} more in the Inbox
          </Link>
          <button
            type="button"
            onClick={clearPopups}
            className="rounded font-medium text-[var(--bladevault-title)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Clear all
          </button>
        </div>
      )}
    </section>
  )
}

type InboxFilter = 'all' | 'maintenance' | 'prices' | 'system' | 'achievements'

const FILTER_TABS: readonly { filter: InboxFilter; label: string }[] = [
  { filter: 'all', label: 'All' },
  { filter: 'maintenance', label: 'Maintenance' },
  { filter: 'prices', label: 'Prices' },
  { filter: 'system', label: 'System' },
  { filter: 'achievements', label: 'Achievements' },
]

function isInboxFilter(value: string | null): value is InboxFilter {
  return (
    value === 'all' ||
    value === 'maintenance' ||
    value === 'prices' ||
    value === 'system' ||
    value === 'achievements'
  )
}

const BOX_TABS: readonly { box: CareNotificationBox; label: string }[] = [
  { box: 'open', label: 'Open' },
  { box: 'snoozed', label: 'Snoozed' },
  { box: 'done', label: 'Done' },
]

const EMPTY_TEXT: Record<InboxFilter, Record<CareNotificationBox, string>> = {
  all: {
    open: 'All caught up. Nothing needs attention right now.',
    snoozed: 'No snoozed messages.',
    done: 'Resolved and dismissed messages show up here for 90 days.',
  },
  maintenance: {
    open: 'All caught up. Nothing is due right now.',
    snoozed: 'No snoozed reminders.',
    done: 'Logged, dismissed and expired reminders show up here for 90 days.',
  },
  prices: {
    open: 'No price changes. Drops and restocks found by price monitoring show up here.',
    snoozed: 'No snoozed price messages.',
    done: 'Resolved and dismissed price messages show up here for 90 days.',
  },
  system: {
    open: 'No problems. Failed backups and other app events show up here.',
    snoozed: 'System messages can’t be snoozed.',
    done: 'Resolved and dismissed system messages show up here for 90 days.',
  },
  achievements: {
    open: 'No new achievements. Unlocked badges show up here.',
    snoozed: 'Achievement messages can’t be snoozed.',
    done: 'Dismissed achievement messages show up here for 90 days.',
  },
}

const FOOTNOTE: Record<InboxFilter, string> = {
  all: 'Care reminders, price changes and app events, such as a failed Google Drive backup, land here. Each one resolves itself once the problem is fixed.',
  maintenance:
    'A reminder arrives when a knife turns due soon or overdue, and resolves itself once that care is logged.',
  prices:
    'A message arrives when a monitored store changes a price or its stock. A later change the other way closes it. Choose which changes notify in Settings → Notifications, and set a target price or mute a knife in its Price monitoring editor.',
  system:
    'A failed Google Drive backup stays here until a later backup works. Successful backups only show a short notice.',
  achievements:
    'Each unlocked achievement leaves a note here. Badges stay unlocked when you dismiss the note. Turn the notes off in Settings → Notifications, or achievements off in Settings → Achievements.',
}

/** Newest first, like mail. Done messages sort by when they closed. */
function sortInboxItems(items: InboxItem[]): InboxItem[] {
  return [...items].sort(
    (left, right) =>
      right.at.localeCompare(left.at) ||
      inboxItemKey(left).localeCompare(inboxItemKey(right)),
  )
}

/**
 * Full Inbox page: care reminders, price changes and system messages in one
 * list, with
 * filters for each kind and Open/Snoozed/Done boxes.
 */
export function CareInboxView() {
  const {
    enabled,
    isLoading,
    notifications,
    systemMessages,
    priceNotifications,
    pricesAvailable,
    now,
    careUnreadCount,
    systemUnreadCount,
    achievementUnreadCount,
    achievementsAvailable,
    priceUnreadCount,
    counts,
    systemCounts,
    achievementCounts,
    priceCounts,
  } = useCareInbox()
  const knivesById = useInboxKnives()
  const { run, runSystem, runPrice, mutePriceSource, log, busyId } =
    useInboxAction()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  // The filter lives in the URL, so links such as the backup notice's
  // “Details” open the System filter directly.
  const requestedFilter = searchParams.get('filter')
  // The static web app has no price monitoring, so no Prices filter.
  const filter: InboxFilter =
    isInboxFilter(requestedFilter) &&
    (requestedFilter !== 'prices' || pricesAvailable) &&
    (requestedFilter !== 'achievements' || achievementsAvailable)
      ? requestedFilter
      : 'all'
  const setFilter = (next: InboxFilter) => {
    const params = new URLSearchParams(searchParams.toString())
    if (next === 'all') params.delete('filter')
    else params.set('filter', next)
    const query = params.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }
  const [box, setBox] = useState<CareNotificationBox>('open')

  const showCare = enabled && (filter === 'all' || filter === 'maintenance')
  const showSystem = filter === 'all' || filter === 'system'
  const showAchievements = filter === 'all' || filter === 'achievements'
  const showPrices =
    pricesAvailable && (filter === 'all' || filter === 'prices')
  // System and achievement messages have no snoozed box.
  const unsnoozable = filter === 'system' || filter === 'achievements'
  const activeBox = unsnoozable && box === 'snoozed' ? 'open' : box

  const visible = useMemo<InboxItem[]>(() => {
    const care = showCare
      ? notifications
          .filter((row) => getCareNotificationBox(row, now) === activeBox)
          .map((row) => ({
            type: 'care' as const,
            at:
              activeBox === 'done'
                ? (row.resolvedAt ?? row.dismissedAt ?? row.updatedAt)
                : row.createdAt,
            row,
          }))
      : []
    const system =
      activeBox !== 'snoozed'
        ? systemMessages
            .filter((row) =>
              row.kind === 'achievement' ? showAchievements : showSystem,
            )
            .filter((row) => getSystemMessageBox(row) === activeBox)
            .map((row) => ({
              type: 'system' as const,
              at: systemMessageTime(row),
              row,
            }))
        : []
    const prices = showPrices
      ? priceNotifications
          .filter((row) => getPriceNotificationBox(row, now) === activeBox)
          .map((row) => ({
            type: 'price' as const,
            at: priceNotificationTime(row),
            row,
          }))
      : []
    // Maintenance alone keeps its deadline order: most overdue first.
    if (filter === 'maintenance') {
      const sorted = sortCareNotifications(
        care.map((item) => item.row),
        activeBox,
      )
      return sorted.map((row) => ({ type: 'care' as const, at: '', row }))
    }
    return sortInboxItems([...care, ...system, ...prices])
  }, [
    showCare,
    showSystem,
    showAchievements,
    showPrices,
    filter,
    notifications,
    systemMessages,
    priceNotifications,
    now,
    activeBox,
  ])

  const boxCount = (target: CareNotificationBox) =>
    (showCare ? counts[target] : 0) +
    (showSystem && target !== 'snoozed' ? systemCounts[target] : 0) +
    (showAchievements && target !== 'snoozed' ? achievementCounts[target] : 0) +
    (showPrices ? priceCounts[target] : 0)
  const filterUnread: Record<InboxFilter, number> = {
    all:
      careUnreadCount +
      systemUnreadCount +
      achievementUnreadCount +
      priceUnreadCount,
    maintenance: careUnreadCount,
    prices: priceUnreadCount,
    system: systemUnreadCount,
    achievements: achievementUnreadCount,
  }
  const unread = filterUnread[filter]
  const boxTabs = BOX_TABS.filter(
    (tab) => tab.box !== 'snoozed' || !unsnoozable,
  )
  const filterTabs = FILTER_TABS.filter(
    (tab) =>
      (tab.filter !== 'prices' || pricesAvailable) &&
      (tab.filter !== 'achievements' || achievementsAvailable),
  )

  const markAllRead = () => {
    if (showCare && careUnreadCount > 0) void run({ action: 'read-all' })
    if (filter === 'all') {
      if (systemUnreadCount + achievementUnreadCount > 0)
        void runSystem({ action: 'read-all' })
    } else if (showSystem || showAchievements) {
      // Only the messages this filter shows.
      const ids = systemMessages
        .filter(
          (row) =>
            isSystemMessageUnread(row) &&
            (row.kind === 'achievement' ? showAchievements : showSystem),
        )
        .map((row) => row.id)
      if (ids.length > 0) void runSystem({ action: 'read', ids })
    }
    if (showPrices && priceUnreadCount > 0)
      void runPrice({ action: 'read-all' })
  }

  return (
    <div data-care-inbox className="w-full max-w-3xl">
      <div
        role="tablist"
        aria-label="Message type"
        className="mb-3 flex gap-1 overflow-x-auto border-b border-border"
      >
        {filterTabs.map((tab) => {
          const selected = filter === tab.filter
          const count = filterUnread[tab.filter]
          return (
            <button
              key={tab.filter}
              type="button"
              role="tab"
              aria-selected={selected}
              data-inbox-filter={tab.filter}
              onClick={() => setFilter(tab.filter)}
              className={cn(
                '-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                selected
                  ? 'border-[var(--bladevault-title)] font-semibold text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.label}
              {count > 0 && (
                <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white tabular-nums">
                  {count > 99 ? '99+' : count}
                  <span className="sr-only"> unread</span>
                </span>
              )}
            </button>
          )
        })}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <div
          role="group"
          aria-label="Show messages"
          className="flex flex-wrap gap-1.5"
        >
          {boxTabs.map((tab) => (
            <button
              key={tab.box}
              type="button"
              aria-pressed={activeBox === tab.box}
              onClick={() => setBox(tab.box)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                activeBox === tab.box &&
                  'border-transparent bg-[var(--bladevault-nav-active-bg)] text-[var(--bladevault-nav-active-fg)] hover:text-[var(--bladevault-nav-active-fg)]',
              )}
            >
              {tab.label}
              <span className="font-semibold tabular-nums">
                {boxCount(tab.box)}
              </span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-1.5">
          {unread > 0 && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={markAllRead}
            >
              <Check className="size-3" />
              Mark all read
            </Button>
          )}
          {filter === 'prices' &&
            activeBox === 'open' &&
            priceCounts.open > 0 && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                data-price-dismiss-all
                onClick={() => void runPrice({ action: 'dismiss-all' })}
              >
                <CheckCheck className="size-3" />
                Dismiss all
              </Button>
            )}
        </div>
      </div>
      {filter === 'maintenance' && !enabled ? (
        <p className="rounded-xl border border-[var(--bladevault-line)]/70 bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          Care reminders are off. Turn them on in{' '}
          <Link
            href="/settings?tab=notifications"
            className="underline underline-offset-2"
          >
            Settings → Notifications
          </Link>{' '}
          to get messages when a knife is due.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--bladevault-line)]/70 bg-card">
          {isLoading && showCare && notifications.length === 0 ? (
            <p
              role="status"
              className="px-4 py-10 text-center text-sm text-muted-foreground"
            >
              Checking messages…
            </p>
          ) : visible.length ? (
            <ul className="divide-y divide-border" aria-live="polite">
              {visible.map((item) =>
                item.type === 'system' ? (
                  <SystemMessageRow
                    key={inboxItemKey(item)}
                    message={item.row}
                    now={now}
                    onAction={(action) => void runSystem(action)}
                  />
                ) : item.type === 'price' ? (
                  <PriceNotificationRow
                    key={inboxItemKey(item)}
                    notification={item.row}
                    now={now}
                    onAction={(action) => void runPrice(action)}
                    onMuteSource={(days) =>
                      void mutePriceSource(item.row, days)
                    }
                  />
                ) : (
                  <CareMessageRow
                    key={inboxItemKey(item)}
                    notification={item.row}
                    knife={knivesById.get(item.row.knifeId)}
                    now={now}
                    busy={busyId === item.row.id}
                    onAction={(action) => void run(action)}
                    onLog={() => void log(item.row)}
                  />
                ),
              )}
            </ul>
          ) : (
            <div className="flex flex-col items-center gap-2 px-4 py-12 text-center text-sm text-muted-foreground">
              <Inbox className="size-6 opacity-60" aria-hidden="true" />
              {EMPTY_TEXT[filter][activeBox]}
            </div>
          )}
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        {FOOTNOTE[filter]}
        {filter === 'all' && !enabled && (
          <>
            {' '}
            Care reminders are off; turn them on in{' '}
            <Link
              href="/settings?tab=notifications"
              className="underline underline-offset-2"
            >
              Settings → Notifications
            </Link>
            .
          </>
        )}
      </p>
    </div>
  )
}
