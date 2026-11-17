'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Popover } from '@base-ui/react/popover'
import { DayPicker, SelectionState, UI, type DateRange } from 'react-day-picker'
import { ChevronLeft, ChevronRight, CircleAlert, Search } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { PageHeader } from '@/components/page-header'
import {
  eventTitle,
  HistoryRail,
  HistoryShowMore,
  HistoryYears,
  isMaintenanceEvent,
  isNoteEvent,
  YearRecapCard,
  type HistoryDay,
  type HistoryItem,
  type ViewEvent,
} from '@/components/history-timeline'
import { dayPickerClassNames } from '@/components/ui/date-input'
import { Input } from '@/components/ui/input'
import { useKnives } from '@/components/providers/knives-provider'
import type { AuditLogEvent, KnifeNote, MaintenanceEvent } from '@/lib/data'
import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'
import { buildHistoryStory } from '@/lib/history-story'
import type { TimeFormat } from '@/lib/settings-shared'
import { getHourCycle } from '@/lib/time-format'
import { formatKnifeName } from '@/lib/timeline'
import { buildYearRecap } from '@/lib/timeline-stats'
import { cn } from '@/lib/utils'

type EventType = AuditLogEvent['type']
type LogFilter = 'all' | EventType | 'maintenance' | 'notes'

type TimelinePayload = {
  maintenanceEvents?: MaintenanceEvent[]
  notes?: KnifeNote[]
}

/** Days rendered at first, and added by each "Show earlier days" press. */
const DAY_PAGE = 30

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

function inDateRange(occurredAt: string, range: DateRange | undefined) {
  if (!range?.from) return true
  const day = startOfDay(new Date(occurredAt)).getTime()
  return (
    day >= startOfDay(range.from).getTime() &&
    day <= startOfDay(range.to ?? range.from).getTime()
  )
}

/** The calendar year a range covers exactly, if any. */
function fullYearOf(range: DateRange | undefined): number | null {
  if (!range?.from || !range.to) return null
  const year = range.from.getFullYear()
  return isSameDay(range.from, new Date(year, 0, 1)) &&
    isSameDay(range.to, new Date(year, 11, 31))
    ? year
    : null
}

/**
 * A History link from the knife inspector names a knife and a timestamp.
 * Record and maintenance writes stamp their log entry with that same time,
 * so an exact match is expected; otherwise use the knife's nearest entry.
 */
function findLinkedEntryId(
  events: AuditLogEvent[],
  search: string,
): number | null {
  const params = new URLSearchParams(search)
  const knifeId = params.get('knife')
  const at = params.get('at')
  if (!knifeId || !at) return null
  const target = Date.parse(at)
  let match: AuditLogEvent | undefined
  let bestDistance = Infinity
  for (const event of events) {
    if (event.knifeId !== knifeId) continue
    if (event.occurredAt === at) return event.id
    const distance = Math.abs(Date.parse(event.occurredAt) - target)
    if (distance < bestDistance) {
      bestDistance = distance
      match = event
    }
  }
  return match?.id ?? null
}

export function LogSessionsView() {
  const {
    knives,
    timeFormat,
    themeStyle,
    isLoading: knivesLoading,
  } = useKnives()
  const [rawEvents, setRawEvents] = useState<AuditLogEvent[]>([])
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
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [timeline, setTimeline] = useState<TimelinePayload | null>(null)
  const [visibleDays, setVisibleDays] = useState(DAY_PAGE)
  const entryButtons = useRef(new Map<number, HTMLButtonElement>())
  const pendingRowPosition = useRef<{ id: number; top: number } | null>(null)
  const pendingLinkedEntry = useRef<number | null>(null)

  useLayoutEffect(() => {
    const pending = pendingRowPosition.current
    pendingRowPosition.current = null
    if (!pending) return

    const row = entryButtons.current
      .get(pending.id)
      ?.closest<HTMLElement>('[data-log-entry]')
    if (!row) return

    // Keep the clicked row fixed when details above it leave the table.
    const offset = row.getBoundingClientRect().top - pending.top
    if (Math.abs(offset) > 0.5) window.scrollBy(0, offset)
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
          throw new Error(getApiErrorMessage(data, 'Failed to load history'))
        }
        if (!cancelled) {
          const loaded = data.events ?? []
          setRawEvents(loaded)
          const linkedId = findLinkedEntryId(loaded, window.location.search)
          if (linkedId !== null) {
            pendingLinkedEntry.current = linkedId
            setSelectedId(linkedId)
          }
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : 'Failed to load history',
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
  }, [loadAttempt])

  // Maintenance and notes feed milestones and the Year in review; History
  // still works from its own log if they cannot load.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch('/api/timeline', { cache: 'no-store' })
        const data = await readJsonResponse<TimelinePayload>(response)
        if (!cancelled) setTimeline(response.ok ? data : {})
      } catch {
        if (!cancelled) setTimeline({})
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [loadAttempt])

  const events = useMemo<ViewEvent[]>(
    () =>
      rawEvents.map((event) => ({
        ...event,
        title: eventTitle(event),
        shortDate: formatEventShortDate(event.occurredAt),
        time: formatEventTime(event.occurredAt, timeFormat),
        rowTime: formatEventTime(event.occurredAt, timeFormat, false),
        ...getEventDate(event.occurredAt),
      })),
    [rawEvents, timeFormat],
  )

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

  const maintenanceEvents = useMemo(
    () =>
      Array.isArray(timeline?.maintenanceEvents)
        ? timeline.maintenanceEvents
        : [],
    [timeline],
  )
  const notes = useMemo(
    () => (Array.isArray(timeline?.notes) ? timeline.notes : []),
    [timeline],
  )
  const story = useMemo(
    () => buildHistoryStory(rawEvents, knives, maintenanceEvents, notes),
    [rawEvents, knives, maintenanceEvents, notes],
  )
  const storyItems = useMemo<HistoryItem[]>(
    () =>
      story.entries.map((entry) => ({
        kind: 'story',
        key: entry.id,
        entry,
        time: entry.time,
        shortDate: formatEventShortDate(entry.occurredAt),
        rowTime: formatEventTime(entry.occurredAt, timeFormat, false),
        ...getEventDate(entry.occurredAt),
      })),
    [story, timeFormat],
  )

  const filteredStory = useMemo(() => {
    if (filter !== 'all' && filter !== 'created') return []
    const normalizedQuery = query.trim().toLowerCase()
    return storyItems.filter((item) => {
      if (item.kind !== 'story') return false
      const { entry } = item
      if (filter === 'created' && entry.type !== 'added') return false
      const matchesQuery =
        !normalizedQuery ||
        [
          entry.title,
          entry.detail ?? '',
          entry.knife ? formatKnifeName(entry.knife) : '',
          entry.type === 'added' ? 'Collection record' : 'Milestone',
        ].some((value) => value.toLowerCase().includes(normalizedQuery))
      return matchesQuery && inDateRange(entry.occurredAt, selectedRange)
    })
  }, [storyItems, filter, query, selectedRange])

  const filteredEvents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return events.filter((event) => {
      const matchesType =
        filter === 'all' ||
        (filter === 'maintenance'
          ? isMaintenanceEvent(event)
          : filter === 'notes'
            ? isNoteEvent(event)
            : event.type === filter && !isNoteEvent(event))
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
      return (
        matchesType &&
        matchesQuery &&
        inDateRange(event.occurredAt, selectedRange)
      )
    })
  }, [events, filter, query, selectedRange])

  useEffect(() => {
    const id = pendingLinkedEntry.current
    if (id === null || selectedId !== id) return
    pendingLinkedEntry.current = null
    const button = entryButtons.current.get(id)
    button
      ?.closest<HTMLElement>('[data-log-entry]')
      ?.scrollIntoView({ block: 'center' })
    button?.focus({ preventScroll: true })
  }, [selectedId])

  const knivesById = useMemo(
    () => new Map(knives.map((knife) => [knife.id, knife])),
    [knives],
  )

  const days = useMemo<HistoryDay[]>(() => {
    const items: HistoryItem[] = [
      ...filteredEvents.map<HistoryItem>((event) => ({
        kind: 'event',
        key: `event:${event.id}`,
        event,
        time: Date.parse(event.occurredAt),
        shortDate: event.shortDate,
        rowTime: event.rowTime,
        dateKey: event.dateKey,
        dateLabel: event.dateLabel,
      })),
      ...filteredStory,
    ]
    // Newest first; at the same moment the log event leads its milestone.
    items.sort(
      (left, right) =>
        right.time - left.time ||
        Number(left.kind === 'story') - Number(right.kind === 'story'),
    )
    const groups: HistoryDay[] = []
    for (const item of items) {
      const current = groups.at(-1)
      if (current?.dateKey === item.dateKey) current.items.push(item)
      else
        groups.push({
          dateKey: item.dateKey,
          dateLabel: item.dateLabel,
          items: [item],
        })
    }
    return groups
  }, [filteredEvents, filteredStory])
  // Story entries need the knife list and the maintenance and notes data.
  const showLoading = isLoading || knivesLoading || timeline === null
  const registerButton = (id: number, node: HTMLButtonElement | null) => {
    if (node) entryButtons.current.set(id, node)
    else entryButtons.current.delete(id)
  }
  const entryCount = filteredEvents.length + filteredStory.length
  const hasAnyEntries = events.length + storyItems.length > 0
  // A deep-linked or selected entry stays rendered even when it is old.
  const selectedDay =
    selectedId === null
      ? -1
      : days.findIndex((day) =>
          day.items.some(
            (item) => item.kind === 'event' && item.event.id === selectedId,
          ),
        )
  const shownDays = days.slice(0, Math.max(visibleDays, selectedDay + 1))

  const years = useMemo(() => {
    const all = new Set<number>()
    for (const event of events)
      all.add(new Date(event.occurredAt).getFullYear())
    for (const item of storyItems) all.add(new Date(item.time).getFullYear())
    return [...all].sort((left, right) => right - left)
  }, [events, storyItems])
  const recapYear = fullYearOf(selectedRange)
  const recap = useMemo(
    () =>
      recapYear === null
        ? undefined
        : buildYearRecap(knives, maintenanceEvents, notes, recapYear),
    [recapYear, knives, maintenanceEvents, notes],
  )

  const selectedEvent = selectedId
    ? filteredEvents.find((event) => event.id === selectedId)
    : undefined
  // Plain totals for the collection as it is now, plus the size of the log.
  const summary = useMemo(() => {
    const sessions = maintenanceEvents.filter((event) =>
      knivesById.has(event.knifeId),
    )
    return [
      ['Knives', knives.length],
      [
        'Maintained knives',
        new Set(sessions.map((event) => event.knifeId)).size,
      ],
      ['Care sessions', sessions.length],
      ['History entries', events.length],
    ] as const
  }, [knives, knivesById, maintenanceEvents, events])
  const chooseYear = (year: number | 'all') => {
    const range =
      year === 'all'
        ? undefined
        : { from: new Date(year, 0, 1), to: new Date(year, 11, 31) }
    setSelectedRange(range)
    setDraftRange(range)
    setVisibleDays(DAY_PAGE)
  }
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

  const exportLogs = () => {
    const ids = new Set(filteredEvents.map((event) => event.id))
    const blob = new Blob(
      [
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            events: rawEvents.filter((event) => ids.has(event.id)),
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    )
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `bladevault-history-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
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
    <>
      {themeStyle === 'alloy' ? (
        <h1 className="sr-only">History</h1>
      ) : (
        <PageHeader
          title="History"
          description="Changes, maintenance, and system activity from your vault."
          actions={
            <Button
              data-logs-export
              variant="outline"
              size="sm"
              disabled={
                isLoading || Boolean(error) || filteredEvents.length === 0
              }
              onClick={exportLogs}
            >
              Export history
            </Button>
          }
        />
      )}
      <div
        data-modern-logs
        data-alloy-logs={themeStyle === 'alloy' || undefined}
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
        <dl data-logs-summary aria-label="Collection totals">
          {summary.map(([label, count]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{showLoading || error ? '—' : count.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
        <Card
          data-logs-card
          size="sm"
          className="min-w-0 gap-0 border border-border/65 py-0 ring-0"
        >
          <div data-logs-toolbar className="px-3 pt-3 sm:px-5">
            <div
              data-logs-search-row
              className="mb-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2"
            >
              <label className="relative min-w-0">
                <span className="sr-only">Search history</span>
                <Search className="pointer-events-none absolute left-0 top-2.5 size-3.5 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search knives, fields, sources…"
                  className="border-0 bg-transparent pl-6 text-xs shadow-none"
                  disabled={isLoading}
                />
              </label>
              <Popover.Root
                open={calendarOpen}
                onOpenChange={handleCalendarOpenChange}
              >
                <Popover.Trigger
                  data-logs-date
                  type="button"
                  disabled={isLoading}
                  aria-label={
                    selectedRange?.from
                      ? `Change date range, ${formatDateRangeLabel(selectedRange)}`
                      : 'Filter history by date range'
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
                  <span>
                    {selectedRange
                      ? formatDateRangeLabel(selectedRange)
                      : 'All dates'}
                  </span>
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
                                        className={cn(
                                          chevronClass,
                                          'rotate-90',
                                        )}
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
            <div
              data-logs-filter-row
              className="flex flex-wrap items-center justify-between gap-x-3"
            >
              <div
                className="flex flex-wrap gap-x-2 sm:gap-x-5"
                aria-label="Filter history event type"
              >
                {(
                  [
                    'all',
                    'created',
                    'updated',
                    'maintenance',
                    'notes',
                    'deleted',
                  ] as const
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
              <p aria-live="polite" className="sr-only">
                {!showLoading && !error
                  ? `${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}`
                  : ''}
              </p>
            </div>
          </div>
          {!error && !showLoading && (
            <HistoryYears
              years={years}
              activeYear={recapYear}
              showingAll={!selectedRange}
              disabled={false}
              onChoose={chooseYear}
            />
          )}
          {!error && !showLoading && recap && <YearRecapCard recap={recap} />}
          {error ? (
            <div
              data-logs-state
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
          ) : showLoading ? (
            <div
              data-logs-state
              role="status"
              aria-label="Loading history"
              className="space-y-3 border-t border-border/60 p-5"
            >
              {[0, 1, 2, 3].map((item) => (
                <div
                  key={item}
                  className="h-12 animate-pulse rounded bg-muted motion-reduce:animate-none"
                />
              ))}
            </div>
          ) : entryCount ? (
            <div data-logs-list className="min-w-0 [overflow-anchor:none]">
              <p className="sr-only">
                Collection activity, newest first. Select an event to inspect
                its changes.
              </p>
              <HistoryRail
                days={shownDays}
                knivesById={knivesById}
                firstOfBrand={story.firstOfBrand}
                selectedId={selectedEvent?.id ?? null}
                knivesLoading={knivesLoading}
                registerButton={registerButton}
                onToggle={(id) => {
                  toggleDetails(id)
                  entryButtons.current.get(id)?.focus({ preventScroll: true })
                }}
                onClose={closeDetails}
              />
              <HistoryShowMore
                hiddenDays={days.length - shownDays.length}
                onShowMore={() => setVisibleDays((count) => count + DAY_PAGE)}
              />
              <div
                data-logs-footer
                className="flex flex-wrap justify-between gap-2 border-t border-border/60 px-5 py-3 text-[10px] text-muted-foreground"
              >
                <span>
                  {entryCount} {entryCount === 1 ? 'entry' : 'entries'} · Newest
                  first
                </span>
                <span>Local time</span>
              </div>
            </div>
          ) : (
            <div
              data-logs-state
              className="border-t border-border/60 p-10 text-center"
            >
              <h2 className="text-sm font-medium">
                {hasAnyEntries ? 'No matching entries' : 'No history yet'}
              </h2>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {hasAnyEntries
                  ? 'Try another search or clear your filters.'
                  : 'Changes to your collection will appear here.'}
              </p>
              {hasAnyEntries && (
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
    </>
  )
}
