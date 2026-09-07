'use client'

import Link from 'next/link'
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Popover } from '@base-ui/react/popover'
import { DayPicker, SelectionState, UI, type DateRange } from 'react-day-picker'
import {
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  GitCompareArrows,
  Search,
  ShieldCheck,
  Wrench,
} from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { LogEventDetails } from '@/components/log-event-details'
import { dayPickerClassNames } from '@/components/ui/date-input'
import { Input } from '@/components/ui/input'
import { useKnives } from '@/components/providers/knives-provider'
import type { AuditLogEvent } from '@/lib/data'
import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'
import type { TimeFormat } from '@/lib/settings-shared'
import { getHourCycle } from '@/lib/time-format'
import { cn } from '@/lib/utils'

type EventType = AuditLogEvent['type']
type LogFilter = 'all' | EventType | 'maintenance'

type ViewEvent = AuditLogEvent & {
  title: string
  shortDate: string
  time: string
  rowTime: string
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

function isMaintenanceEvent(event: AuditLogEvent): boolean {
  return (
    event.source === 'Maintenance' ||
    event.source === 'MCP / add_maintenance_event'
  )
}

function eventMeta(event: AuditLogEvent): {
  label: string
  className: string
} {
  if (isMaintenanceEvent(event)) {
    return {
      label: 'Maintenance',
      className: 'text-amber-700 dark:text-amber-300',
    }
  }
  return typeMeta[event.type]
}

function eventTitle(event: AuditLogEvent): string {
  if (isMaintenanceEvent(event)) {
    if (event.type === 'deleted') return 'Maintenance deleted'
    if (event.summary.endsWith('entry was updated.')) {
      return 'Maintenance updated'
    }
    return 'Maintenance logged'
  }

  switch (event.type) {
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

function formatEventTime(
  occurredAt: string,
  timeFormat: TimeFormat,
  seconds = true,
): string {
  const date = new Date(occurredAt)
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: seconds ? '2-digit' : undefined,
    hourCycle: getHourCycle(timeFormat),
  })
}

function formatEventShortDate(occurredAt: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
  }).format(new Date(occurredAt))
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

function EventIcon({ event }: { event: ViewEvent }) {
  if (isMaintenanceEvent(event)) return <Wrench className="size-4" />

  const { type } = event
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

export function LogSessionsView() {
  const { knives, timeFormat, isLoading: knivesLoading } = useKnives()
  const [events, setEvents] = useState<ViewEvent[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<LogFilter>('all')
  const [selectedRange, setSelectedRange] = useState<DateRange | undefined>()
  const [draftRange, setDraftRange] = useState<DateRange | undefined>()
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [calendarMonth, setCalendarMonth] = useState<Date>(new Date())
  const [calendarMonths, setCalendarMonths] = useState(1)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [showSummary, setShowSummary] = useState(false)
  const [showSource, setShowSource] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const entryButtons = useRef(new Map<number, HTMLButtonElement>())
  const pendingRowPosition = useRef<{ id: number; top: number } | null>(null)

  useEffect(() => {
    const summary = window.matchMedia('(min-width: 1024px)')
    const source = window.matchMedia('(min-width: 1280px)')
    const update = () => {
      setShowSummary(summary.matches)
      setShowSource(source.matches)
    }
    update()
    summary.addEventListener('change', update)
    source.addEventListener('change', update)
    return () => {
      summary.removeEventListener('change', update)
      source.removeEventListener('change', update)
    }
  }, [])

  useLayoutEffect(() => {
    const pending = pendingRowPosition.current
    pendingRowPosition.current = null
    if (!pending) return

    const row = entryButtons.current
      .get(pending.id)
      ?.closest<HTMLElement>('[data-log-entry]')
    const scrollContainer = row?.closest<HTMLElement>('main')
    if (!row || !scrollContainer) return

    // Keep the clicked row fixed when details above it leave the table.
    const offset = row.getBoundingClientRect().top - pending.top
    if (Math.abs(offset) > 0.5) scrollContainer.scrollTop += offset
  }, [selectedId])

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
          title: eventTitle(event),
          shortDate: formatEventShortDate(event.occurredAt),
          time: formatEventTime(event.occurredAt, timeFormat),
          rowTime: formatEventTime(event.occurredAt, timeFormat, false),
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
  }, [timeFormat, loadAttempt])

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
      const matchesType =
        filter === 'all' ||
        (filter === 'maintenance'
          ? isMaintenanceEvent(event)
          : event.type === filter)
      const matchesQuery =
        !normalizedQuery ||
        [
          event.title,
          event.subject,
          event.actor,
          event.source,
          event.summary,
          ...event.changes.flatMap((change) => [
            change.field,
            change.before,
            change.after,
          ]),
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

  const currentKnifeIds = useMemo(
    () => new Set(knives.map((knife) => knife.id)),
    [knives],
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

  const selectedEvent = selectedId
    ? filteredEvents.find((event) => event.id === selectedId)
    : undefined
  const columnCount = 4 + Number(showSummary) + Number(showSource)
  const getKnifeHref = (event: AuditLogEvent) =>
    event.knifeId && currentKnifeIds.has(event.knifeId)
      ? `/collection/${encodeURIComponent(event.knifeId)}`
      : null
  const closeDetails = () => {
    if (selectedEvent)
      entryButtons.current.get(selectedEvent.id)?.focus({ preventScroll: true })
    setSelectedId(null)
  }
  const toggleDetails = (id: number) => {
    const button = entryButtons.current.get(id)
    const row = button?.closest<HTMLElement>('[data-log-entry]')
    if (row) {
      pendingRowPosition.current = {
        id,
        top: row.getBoundingClientRect().top,
      }
    }
    setSelectedId((current) => (current === id ? null : id))
  }
  const clearFilters = () => {
    setQuery('')
    setFilter('all')
    setSelectedRange(undefined)
    setDraftRange(undefined)
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
    <div
      className="grid w-full min-w-0 items-start gap-5"
      onKeyDown={(event) => {
        if (
          event.key === 'Escape' &&
          !calendarOpen &&
          !event.defaultPrevented
        ) {
          event.preventDefault()
          closeDetails()
        }
      }}
    >
      <Card
        size="sm"
        className="min-w-0 gap-0 border border-border/65 py-0 ring-0"
      >
        <div className="px-3 pt-3 sm:px-5">
          <div className="mb-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
            <label className="relative min-w-0">
              <span className="sr-only">Search logs</span>
              <Search className="pointer-events-none absolute left-0 top-2.5 size-3.5 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search knives, fields, or sources…"
                className="border-0 bg-transparent pl-6 text-xs shadow-none"
                disabled={isLoading}
              />
            </label>
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
                  'w-24 justify-start px-2 text-[11px] tabular-nums sm:w-44 [&>span]:truncate',
                )}
              >
                <Calendar className="size-3.5" />
                <span>{formatDateRangeLabel(selectedRange)}</span>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Positioner
                  side="bottom"
                  align="end"
                  sideOffset={6}
                  className="z-50"
                >
                  <Popover.Popup
                    data-testid="log-date-range-picker"
                    className="max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] overflow-auto rounded-xl border border-[var(--bladevault-line)] bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
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
                              const chevronClass = cn(
                                'size-4',
                                chevronClassName,
                              )
                              switch (orientation) {
                                case 'left':
                                  return (
                                    <ChevronLeft className={chevronClass} />
                                  )
                                case 'right':
                                  return (
                                    <ChevronRight className={chevronClass} />
                                  )
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
                                  return (
                                    <ChevronRight className={chevronClass} />
                                  )
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
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-3">
            <div
              className="flex flex-wrap gap-x-2 sm:gap-x-5"
              aria-label="Filter log event type"
            >
              {(
                ['all', 'created', 'updated', 'deleted', 'maintenance'] as const
              ).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                  disabled={isLoading}
                  className={cn(
                    'border-b-2 border-transparent px-0 py-3 text-[10px] capitalize sm:text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50',
                    filter === value &&
                      'border-[var(--bladevault-gold)] font-medium text-[var(--bladevault-title)] dark:text-[var(--bladevault-gold)]',
                  )}
                >
                  {value === 'all' ? 'All activity' : value}
                </button>
              ))}
            </div>
            <p
              aria-live="polite"
              className="hidden py-2 text-[10px] tabular-nums text-muted-foreground sm:block"
            >
              {!isLoading && !error
                ? `${filteredEvents.length} ${filteredEvents.length === 1 ? 'entry' : 'entries'}`
                : ''}
            </p>
          </div>
        </div>
        {error ? (
          <div
            role="alert"
            className="border-t border-border/60 px-5 py-12 text-center"
          >
            <CircleAlert className="mx-auto mb-3 size-5 text-destructive" />
            <h2 className="text-sm font-medium">Couldn’t load activity</h2>
            <p className="mt-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {error}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => setLoadAttempt((attempt) => attempt + 1)}
            >
              Try again
            </Button>
          </div>
        ) : isLoading ? (
          <div
            role="status"
            aria-label="Loading logs"
            className="space-y-3 border-t border-border/60 p-5"
          >
            {[0, 1, 2, 3].map((item) => (
              <div
                key={item}
                className="h-12 animate-pulse rounded bg-muted motion-reduce:animate-none"
              />
            ))}
          </div>
        ) : filteredEvents.length ? (
          <>
            <Table
              className="table-fixed text-xs [overflow-anchor:none]"
              containerClassName="overflow-x-clip"
            >
              <caption className="sr-only">
                Collection activity, newest first. Select an event to inspect
                its changes.
              </caption>
              <TableHeader className="border-t border-border/60 bg-muted/40">
                <TableRow className="hover:bg-transparent [&_th]:h-8 [&_th]:text-[10px] [&_th]:text-muted-foreground">
                  <TableHead scope="col" className="w-16 pl-3 sm:w-24 sm:pl-5">
                    Time
                  </TableHead>
                  <TableHead scope="col">Knife / subject</TableHead>
                  <TableHead scope="col" className="w-[104px] sm:w-28">
                    Event
                  </TableHead>
                  {showSummary && (
                    <TableHead scope="col" className="w-[27%]">
                      Changes
                    </TableHead>
                  )}
                  {showSource && (
                    <TableHead scope="col" className="w-28">
                      Source
                    </TableHead>
                  )}
                  <TableHead scope="col" className="w-8 sm:w-10">
                    <span className="sr-only">Details</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              {groupedEvents.map((group) => (
                <TableBody key={group.dateKey}>
                  <TableRow className="border-0 hover:bg-transparent">
                    <TableHead
                      scope="rowgroup"
                      colSpan={columnCount}
                      className="h-auto whitespace-normal px-3 pb-2 pt-4 text-[10px] sm:px-5"
                    >
                      <span className="font-semibold">{group.dateLabel}</span>
                      <span className="ml-2 font-normal text-muted-foreground">
                        ·{' '}
                        {new Date(
                          group.events[0].occurredAt,
                        ).toLocaleDateString(undefined, {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </span>
                    </TableHead>
                  </TableRow>
                  {group.events.map((event) => {
                    const meta = eventMeta(event)
                    const selected = selectedEvent?.id === event.id
                    const knifeHref = getKnifeHref(event)
                    const detailId = `log-detail-${event.id}`
                    return (
                      <Fragment key={event.id}>
                        <TableRow
                          data-log-entry
                          data-event-type={event.type}
                          data-event-title={event.title}
                          data-maintenance={
                            isMaintenanceEvent(event) || undefined
                          }
                          data-state={selected ? 'selected' : undefined}
                          className="cursor-pointer border-border/60 hover:bg-muted/60 data-[state=selected]:bg-accent/60 [&_td]:whitespace-normal [&_td]:py-3"
                          onClick={(click) => {
                            if (
                              (click.target as HTMLElement).closest('a, button')
                            )
                              return
                            toggleDetails(event.id)
                            entryButtons.current
                              .get(event.id)
                              ?.focus({ preventScroll: true })
                          }}
                        >
                          <TableCell className="pl-3 align-top sm:pl-5">
                            <time
                              dateTime={event.occurredAt}
                              title={`${event.shortDate} · ${event.time}`}
                              className="block text-[10px] leading-relaxed tabular-nums text-muted-foreground sm:text-[11px]"
                            >
                              <span className="sr-only">
                                {event.shortDate} ·{' '}
                              </span>
                              {event.rowTime}
                            </time>
                          </TableCell>
                          <TableCell className="[overflow-wrap:anywhere]">
                            {knifeHref ? (
                              <Link
                                href={knifeHref}
                                aria-label={`View ${event.subject}`}
                                className="rounded-sm text-xs font-medium leading-relaxed underline-offset-4 hover:text-[var(--bladevault-title)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring dark:hover:text-[var(--bladevault-gold)]"
                              >
                                {event.subject}
                              </Link>
                            ) : (
                              <span className="text-xs font-medium leading-relaxed text-muted-foreground">
                                {event.subject}
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            <span className="flex items-center gap-1.5 text-[10px] sm:text-[11px]">
                              <span
                                aria-hidden
                                className={cn(
                                  'shrink-0 [&_svg]:size-3',
                                  meta.className,
                                )}
                              >
                                <EventIcon event={event} />
                              </span>
                              {meta.label}
                            </span>
                          </TableCell>
                          {showSummary && (
                            <TableCell className="text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                              <span className="line-clamp-2">
                                {event.changes
                                  .map((change) => change.field)
                                  .join(', ') || event.summary}
                              </span>
                            </TableCell>
                          )}
                          {showSource && (
                            <TableCell className="text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
                              {event.source}
                            </TableCell>
                          )}
                          <TableCell className="px-0 pr-1 sm:pr-2">
                            <button
                              type="button"
                              ref={(node) => {
                                if (node)
                                  entryButtons.current.set(event.id, node)
                                else entryButtons.current.delete(event.id)
                              }}
                              onClick={() => toggleDetails(event.id)}
                              aria-expanded={selected}
                              aria-controls={selected ? detailId : undefined}
                              aria-label={`${selected ? 'Collapse' : 'Expand'} ${event.title} details for ${event.subject}`}
                              className="flex size-7 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                            >
                              <ChevronRight
                                className={cn(
                                  'size-3.5 transition-transform',
                                  selected &&
                                    'rotate-90 text-[var(--bladevault-title)] dark:text-[var(--bladevault-gold)]',
                                )}
                              />
                            </button>
                          </TableCell>
                        </TableRow>
                        {selected && (
                          <TableRow className="hover:bg-transparent">
                            <TableCell
                              colSpan={columnCount}
                              className="whitespace-normal border-b border-border/60 bg-muted/30 p-0"
                            >
                              <section
                                id={detailId}
                                aria-label={`Event details for ${event.subject}`}
                              >
                                <LogEventDetails
                                  event={event}
                                  title={event.title}
                                  time={event.time}
                                  knifeHref={knifeHref}
                                  knifeUnavailable={
                                    !knivesLoading &&
                                    !!event.knifeId &&
                                    !knifeHref
                                  }
                                  onClose={closeDetails}
                                />
                              </section>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })}
                </TableBody>
              ))}
            </Table>
            <div className="flex flex-wrap justify-between gap-2 border-t border-border/60 px-5 py-3 text-[10px] text-muted-foreground">
              <span>
                {filteredEvents.length}{' '}
                {filteredEvents.length === 1 ? 'entry' : 'entries'} · Newest
                first
              </span>
              <span>Local time</span>
            </div>
          </>
        ) : (
          <div className="border-t border-border/60 p-10 text-center">
            <h2 className="text-sm font-medium">
              {events.length ? 'No matching entries' : 'No log entries yet'}
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {events.length
                ? 'Try another search or clear your filters.'
                : 'Changes to your collection will appear here.'}
            </p>
            {events.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={clearFilters}
              >
                Clear filters
              </Button>
            )}
          </div>
        )}
      </Card>
    </div>
  )
}
