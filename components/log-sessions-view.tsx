'use client'

import { useEffect, useMemo, useState } from 'react'
import { Popover } from '@base-ui/react/popover'
import { DayPicker, SelectionState, UI, type DateRange } from 'react-day-picker'
import {
  Bot,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Database,
  GitCompareArrows,
  Minus,
  Plus,
  Search,
  ShieldCheck,
  UserRound,
} from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { dayPickerClassNames } from '@/components/ui/date-input'
import { Input } from '@/components/ui/input'
import type { AuditLogEvent } from '@/lib/data'
import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'
import { cn } from '@/lib/utils'

type EventType = AuditLogEvent['type']

type ViewEvent = AuditLogEvent & {
  title: string
  time: string
  dateKey: string
  dateLabel: string
}

const quickRanges = [
  { label: 'Today', days: 1 },
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
] as const

const rangePickerClassNames = {
  ...dayPickerClassNames,
  [UI.Root]: 'relative text-foreground',
  [UI.Months]: 'flex gap-4',
  [SelectionState.selected]: 'bg-transparent',
  [SelectionState.range_start]:
    'range-start [&>button]:bg-[var(--bladevault-gold)] [&>button]:text-[var(--bladevault-olive)] [&>button:hover]:bg-[var(--bladevault-gold)]',
  [SelectionState.range_middle]:
    'range-middle [&>button]:rounded-none [&>button]:bg-[var(--bladevault-gold)]/15 [&>button:hover]:bg-[var(--bladevault-gold)]/25',
  [SelectionState.range_end]:
    'range-end [&>button]:bg-[var(--bladevault-gold)] [&>button]:text-[var(--bladevault-olive)] [&>button:hover]:bg-[var(--bladevault-gold)]',
}

const pendingRangeClassName =
  'range-pending [&>button]:bg-[var(--bladevault-gold)] [&>button]:text-[var(--bladevault-olive)] [&>button:hover]:bg-[var(--bladevault-gold)]'

const typeMeta: Record<EventType, { label: string; className: string }> = {
  created: {
    label: 'Created',
    className: 'text-emerald-700 dark:text-emerald-400',
  },
  updated: { label: 'Updated', className: 'text-[var(--bladevault-title)]' },
  deleted: { label: 'Deleted', className: 'text-destructive' },
  system: { label: 'System', className: 'text-slate-600 dark:text-slate-300' },
}

function eventTitle(type: EventType): string {
  switch (type) {
    case 'created':
      return 'Knife added'
    case 'updated':
      return 'Metadata updated'
    case 'deleted':
      return 'Knife deleted'
    case 'system':
      return 'System event'
  }
}

function formatEventTime(occurredAt: string): string {
  const date = new Date(occurredAt)
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function isSameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

function getEventDate(occurredAt: string): {
  dateKey: string
  dateLabel: string
} {
  const date = new Date(occurredAt)
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)

  const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
  if (isSameDay(date, now)) return { dateKey, dateLabel: 'Today' }
  if (isSameDay(date, yesterday)) return { dateKey, dateLabel: 'Yesterday' }

  return {
    dateKey,
    dateLabel: date.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    }),
  }
}

function formatLastActivity(occurredAt: string | undefined): string {
  if (!occurredAt) return 'No activity'
  const date = new Date(occurredAt)
  const now = new Date()
  const seconds = Math.max(
    0,
    Math.floor((now.getTime() - date.getTime()) / 1000),
  )
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

function isWithinLastWeek(occurredAt: string): boolean {
  const date = new Date(occurredAt)
  const weekAgo = new Date()
  weekAgo.setDate(weekAgo.getDate() - 7)
  return date.getTime() >= weekAgo.getTime()
}

function startOfDay(date: Date): Date {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function createRecentRange(days: number): DateRange {
  const to = startOfDay(new Date())
  const from = new Date(to)
  from.setDate(from.getDate() - (days - 1))
  return { from, to }
}

function rangesMatch(
  left: DateRange | undefined,
  right: DateRange | undefined,
): boolean {
  if (!left?.from || !right?.from) return !left?.from && !right?.from
  const leftTo = left.to ?? left.from
  const rightTo = right.to ?? right.from
  return isSameDay(left.from, right.from) && isSameDay(leftTo, rightTo)
}

function formatDateLabel(date: Date, includeYear = true): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: includeYear ? 'numeric' : undefined,
  }).format(date)
}

function formatDateRangeLabel(range: DateRange | undefined): string {
  if (!range?.from) return 'Date'
  const to = range.to ?? range.from
  if (isSameDay(range.from, to)) return formatDateLabel(range.from)

  const sameYear = range.from.getFullYear() === to.getFullYear()
  return `${formatDateLabel(range.from, !sameYear)} – ${formatDateLabel(to)}`
}

function getCalendarStartMonth(date: Date, numberOfMonths: number): Date {
  const month = startOfMonth(date)
  const currentMonth = startOfMonth(new Date())
  if (numberOfMonths > 1 && isSameDay(month, currentMonth)) {
    month.setMonth(month.getMonth() - 1)
  }
  return month
}

function EventIcon({ type }: { type: EventType }) {
  const Icon =
    type === 'created'
      ? Check
      : type === 'deleted'
        ? CircleAlert
        : type === 'system'
          ? ShieldCheck
          : GitCompareArrows
  return <Icon className="size-4" />
}

function ActorIcon({ actor }: { actor: string }) {
  return actor === 'You' ? (
    <UserRound className="size-3.5" />
  ) : actor === 'BladeVault' ? (
    <Database className="size-3.5" />
  ) : (
    <Bot className="size-3.5" />
  )
}

export function LogSessionsView() {
  const [events, setEvents] = useState<ViewEvent[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | EventType>('all')
  const [selectedRange, setSelectedRange] = useState<DateRange | undefined>()
  const [draftRange, setDraftRange] = useState<DateRange | undefined>()
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [calendarMonth, setCalendarMonth] = useState<Date>(new Date())
  const [calendarMonths, setCalendarMonths] = useState(1)
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<number>>(
    () => new Set(),
  )

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        setIsLoading(true)
        setError(null)
        const response = await fetch('/api/logs', { cache: 'no-store' })
        const data = await readJsonResponse<{
          events?: AuditLogEvent[]
          error?: string
        }>(response)
        if (!response.ok) {
          throw new Error(getApiErrorMessage(data, 'Failed to load log events'))
        }
        const loaded = (data.events ?? []).map((event) => ({
          ...event,
          title: eventTitle(event.type),
          time: formatEventTime(event.occurredAt),
          ...getEventDate(event.occurredAt),
        }))
        if (!cancelled) {
          setEvents(loaded)
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : 'Failed to load log events',
          )
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(min-width: 768px)')
    const updateCalendarMonths = () => {
      setCalendarMonths(mediaQuery.matches ? 2 : 1)
    }

    updateCalendarMonths()
    mediaQuery.addEventListener('change', updateCalendarMonths)
    return () => {
      mediaQuery.removeEventListener('change', updateCalendarMonths)
    }
  }, [])

  const filteredEvents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return events.filter((event) => {
      const matchesType = filter === 'all' || event.type === filter
      const matchesQuery =
        !normalizedQuery ||
        [
          event.title,
          event.subject,
          event.actor,
          event.source,
          event.summary,
        ].some((value) => value.toLowerCase().includes(normalizedQuery))
      const eventDay = startOfDay(new Date(event.occurredAt)).getTime()
      const rangeStart = selectedRange?.from
        ? startOfDay(selectedRange.from).getTime()
        : undefined
      const rangeEnd = selectedRange?.from
        ? startOfDay(selectedRange.to ?? selectedRange.from).getTime()
        : undefined
      const matchesDate =
        rangeStart === undefined ||
        rangeEnd === undefined ||
        (eventDay >= rangeStart && eventDay <= rangeEnd)
      return matchesType && matchesQuery && matchesDate
    })
  }, [events, filter, query, selectedRange])

  const eventsThisWeek = useMemo(
    () => events.filter((event) => isWithinLastWeek(event.occurredAt)).length,
    [events],
  )

  const groupedEvents = useMemo(() => {
    const groups: Array<{
      dateKey: string
      dateLabel: string
      events: ViewEvent[]
    }> = []

    for (const event of filteredEvents) {
      const current = groups.at(-1)
      if (current?.dateKey === event.dateKey) {
        current.events.push(event)
      } else {
        groups.push({
          dateKey: event.dateKey,
          dateLabel: event.dateLabel,
          events: [event],
        })
      }
    }

    return groups
  }, [filteredEvents])

  const toggleExpanded = (id: number) => {
    setExpandedIds((previous) => {
      const next = new Set(previous)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const handleCalendarOpenChange = (open: boolean) => {
    setCalendarOpen(open)
    if (!open) return

    setDraftRange(selectedRange)
    setCalendarMonth(
      getCalendarStartMonth(selectedRange?.from ?? new Date(), calendarMonths),
    )
  }

  const applyQuickRange = (days: number) => {
    const range = createRecentRange(days)
    setSelectedRange(range)
    setDraftRange(range)
    setCalendarMonth(getCalendarStartMonth(range.from!, calendarMonths))
    setCalendarOpen(false)
  }

  const clearDateRange = () => {
    setSelectedRange(undefined)
    setDraftRange(undefined)
    setCalendarOpen(false)
  }

  const applyDraftRange = () => {
    if (!draftRange?.from) return
    const from = startOfDay(draftRange.from)
    const to = startOfDay(draftRange.to ?? draftRange.from)
    setSelectedRange({ from, to })
    setDraftRange({ from, to })
    setCalendarOpen(false)
  }

  return (
    <div className="w-full">
      <div className="mb-6 flex flex-col gap-3 border-b border-border pb-5 lg:flex-row lg:items-center">
        <label className="relative min-w-0 flex-1 lg:max-w-md">
          <span className="sr-only">Search logs</span>
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search logs"
            className="pl-9"
            disabled={isLoading}
          />
        </label>
        <div
          className="flex items-center gap-1 overflow-x-auto rounded-lg bg-muted/60 p-0.5"
          aria-label="Filter log event type"
        >
          {(['all', 'created', 'updated', 'deleted'] as const).map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={filter === value ? 'secondary' : 'ghost'}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              disabled={isLoading}
              className={cn(
                'shrink-0 px-3 text-xs capitalize',
                filter === value &&
                  'bg-[var(--bladevault-olive)] text-[var(--bladevault-gold)] hover:bg-[var(--bladevault-olive)] hover:text-[var(--bladevault-gold)]',
              )}
            >
              {value}
            </Button>
          ))}
        </div>
        <Popover.Root
          open={calendarOpen}
          onOpenChange={handleCalendarOpenChange}
        >
          <Popover.Trigger
            type="button"
            disabled={isLoading}
            aria-label={
              selectedRange?.from
                ? `Change date range, ${formatDateRangeLabel(selectedRange)}`
                : 'Filter logs by date range'
            }
            aria-expanded={calendarOpen}
            className={cn(
              buttonVariants({
                variant: selectedRange ? 'secondary' : 'ghost',
                size: 'sm',
              }),
              'shrink-0 px-2.5 tabular-nums',
            )}
          >
            <Calendar className="size-3.5" />
            <span>{formatDateRangeLabel(selectedRange)}</span>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner side="bottom" align="end" sideOffset={6}>
              <Popover.Popup
                data-testid="log-date-range-picker"
                className="z-50 max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] overflow-auto rounded-xl border border-[var(--bladevault-line)] bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
              >
                <div className="grid md:grid-cols-[8.5rem_auto]">
                  <aside
                    aria-label="Quick date ranges"
                    className="border-b border-[var(--bladevault-line)]/60 p-2 md:border-r md:border-b-0"
                  >
                    <p className="px-2 pt-1 pb-1.5 text-[10px] font-medium text-muted-foreground">
                      Quick ranges
                    </p>
                    <div className="grid grid-cols-3 gap-1 md:grid-cols-1">
                      {quickRanges.map((range) => {
                        const active = rangesMatch(
                          selectedRange,
                          createRecentRange(range.days),
                        )
                        return (
                          <Button
                            key={range.days}
                            type="button"
                            size="sm"
                            variant={active ? 'secondary' : 'ghost'}
                            aria-pressed={active}
                            onClick={() => applyQuickRange(range.days)}
                            className="justify-start px-2"
                          >
                            {range.label}
                          </Button>
                        )
                      })}
                    </div>
                  </aside>

                  <div className="p-3">
                    <DayPicker
                      mode="range"
                      month={calendarMonth}
                      onMonthChange={setCalendarMonth}
                      numberOfMonths={calendarMonths}
                      pagedNavigation={calendarMonths > 1}
                      fixedWeeks
                      resetOnSelect
                      endMonth={startOfMonth(new Date())}
                      disabled={{ after: new Date() }}
                      selected={draftRange}
                      onSelect={setDraftRange}
                      modifiers={{
                        range_pending:
                          draftRange?.from && !draftRange.to
                            ? draftRange.from
                            : undefined,
                      }}
                      modifiersClassNames={{
                        range_pending: pendingRangeClassName,
                      }}
                      showOutsideDays={calendarMonths === 1}
                      classNames={rangePickerClassNames}
                      components={{
                        Chevron: ({
                          orientation,
                          className: chevronClassName,
                        }) => {
                          const chevronClass = cn('size-4', chevronClassName)
                          switch (orientation) {
                            case 'left':
                              return <ChevronLeft className={chevronClass} />
                            case 'right':
                              return <ChevronRight className={chevronClass} />
                            case 'up':
                              return (
                                <ChevronRight
                                  className={cn(
                                    chevronClass,
                                    'rotate-[-90deg]',
                                  )}
                                />
                              )
                            case 'down':
                              return (
                                <ChevronRight
                                  className={cn(chevronClass, 'rotate-90')}
                                />
                              )
                            default:
                              return <ChevronRight className={chevronClass} />
                          }
                        },
                      }}
                    />

                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--bladevault-line)]/60 pt-3">
                      <p className="mr-auto min-w-0 truncate text-xs tabular-nums text-muted-foreground">
                        {draftRange?.from
                          ? formatDateRangeLabel(draftRange)
                          : 'Choose dates'}
                      </p>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={clearDateRange}
                        disabled={!selectedRange && !draftRange?.from}
                      >
                        Clear
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => {
                          setDraftRange(selectedRange)
                          setCalendarOpen(false)
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        onClick={applyDraftRange}
                        disabled={!draftRange?.from}
                      >
                        Apply
                      </Button>
                    </div>
                  </div>
                </div>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
        <p className="shrink-0 text-xs tabular-nums text-muted-foreground lg:ml-auto">
          <span className="font-medium text-foreground">
            {filteredEvents.length}
          </span>{' '}
          {filteredEvents.length === 1 ? 'entry' : 'entries'}
          {!selectedRange && filter === 'all' && !query.trim() ? (
            <>
              <span className="mx-2 text-border" aria-hidden>
                /
              </span>
              {eventsThisWeek} this week
              <span className="mx-2 text-border" aria-hidden>
                /
              </span>
              {formatLastActivity(events[0]?.occurredAt)}
            </>
          ) : null}
        </p>
      </div>

      {error ? (
        <div className="rounded-xl border border-destructive/50 bg-destructive/10 p-10 text-center text-sm text-destructive">
          {error}
        </div>
      ) : isLoading ? (
        <div aria-label="Loading logs" className="space-y-4">
          {[0, 1, 2].map((item) => (
            <div key={item} className="flex animate-pulse gap-3">
              <div className="mt-3 size-8 shrink-0 rounded-full bg-muted" />
              <div className="h-24 flex-1 rounded-xl bg-muted" />
            </div>
          ))}
        </div>
      ) : (
        <section aria-label="Log entries">
          {groupedEvents.length ? (
            <div className="space-y-7">
              {groupedEvents.map((group) => (
                <section
                  key={group.dateKey}
                  aria-labelledby={`log-date-${group.dateKey}`}
                >
                  <div className="mb-3 flex items-baseline gap-2">
                    <h2
                      id={`log-date-${group.dateKey}`}
                      className="text-xs font-semibold text-foreground"
                    >
                      {group.dateLabel}
                    </h2>
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {group.events.length}
                    </span>
                  </div>
                  <ol className="relative list-none before:absolute before:top-6 before:bottom-6 before:left-5 before:hidden before:w-px before:-translate-x-1/2 before:bg-border before:content-[''] md:before:block">
                    {group.events.map((event) => {
                      const meta = typeMeta[event.type]
                      const expanded = expandedIds.has(event.id)
                      const detailId = `log-detail-${event.id}`
                      return (
                        <li
                          key={event.id}
                          className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-3 pb-4 last:pb-0"
                        >
                          <span
                            className={cn(
                              'relative z-10 mt-4 grid size-8 place-items-center rounded-full border border-border bg-card',
                              meta.className,
                            )}
                          >
                            <EventIcon type={event.type} />
                          </span>
                          <Card className="gap-0 py-0 shadow-sm">
                            <button
                              type="button"
                              onClick={() => toggleExpanded(event.id)}
                              aria-expanded={expanded}
                              aria-controls={detailId}
                              className="w-full p-4 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                            >
                              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                                <div className="min-w-0">
                                  <div className="flex items-center justify-between gap-3">
                                    <span
                                      className={cn(
                                        'text-[10px] font-semibold uppercase tracking-[0.14em]',
                                        meta.className,
                                      )}
                                    >
                                      {meta.label}
                                    </span>
                                    <time
                                      dateTime={event.occurredAt}
                                      className="font-mono text-[10px] text-muted-foreground"
                                    >
                                      {event.time}
                                    </time>
                                  </div>
                                  <strong className="mt-1 block truncate text-sm">
                                    {event.title}{' '}
                                    <span className="font-normal text-muted-foreground">
                                      · {event.subject}
                                    </span>
                                  </strong>
                                  <span className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted-foreground">
                                    <span className="flex items-center gap-1.5">
                                      <ActorIcon actor={event.actor} />
                                      {event.actor}
                                    </span>
                                    <span aria-hidden>·</span>
                                    <span className="truncate">
                                      {event.source}
                                    </span>
                                  </span>
                                  <span className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                    <GitCompareArrows className="size-3 shrink-0" />
                                    <span className="truncate">
                                      {event.changes
                                        .map((change) => change.field)
                                        .join(', ')}
                                    </span>
                                  </span>
                                </div>
                                <ChevronDown
                                  className={cn(
                                    'mt-1 size-4 shrink-0 text-muted-foreground transition-transform',
                                    expanded && 'rotate-180',
                                  )}
                                />
                              </div>
                            </button>
                            {expanded ? (
                              <div
                                id={detailId}
                                className="border-t border-border bg-[var(--bladevault-surface-soft)] p-4"
                              >
                                <p className="text-xs text-muted-foreground">
                                  {event.summary}
                                </p>
                                {event.changes.length ? (
                                  <div className="mt-3 overflow-hidden rounded-lg border border-border bg-card">
                                    {event.changes.map((change) => (
                                      <div
                                        key={change.field}
                                        className="border-b border-border p-3 last:border-0"
                                      >
                                        <span className="block text-[11px] font-medium">
                                          {change.field}
                                        </span>
                                        <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 font-mono text-[10px]">
                                          <span className="flex min-w-0 items-center gap-1 rounded bg-muted px-2 py-1 text-muted-foreground">
                                            <Minus className="size-3 shrink-0" />
                                            <span className="truncate">
                                              {change.before}
                                            </span>
                                          </span>
                                          <ChevronRight className="size-3 text-muted-foreground" />
                                          <span className="flex min-w-0 items-center gap-1 rounded bg-emerald-500/10 px-2 py-1 text-emerald-700 dark:text-emerald-400">
                                            <Plus className="size-3 shrink-0" />
                                            <span className="truncate">
                                              {change.after}
                                            </span>
                                          </span>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                ) : null}
                                <code className="mt-3 block truncate font-mono text-[10px] text-muted-foreground">
                                  {event.operationId}
                                </code>
                              </div>
                            ) : null}
                          </Card>
                        </li>
                      )
                    })}
                  </ol>
                </section>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
              {events.length ? 'No matching entries' : 'No log entries yet'}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
