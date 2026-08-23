'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Bot,
  Check,
  ChevronDown,
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
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
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
      return matchesType && matchesQuery
    })
  }, [events, filter, query])

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
        <p className="shrink-0 text-xs tabular-nums text-muted-foreground lg:ml-auto">
          <span className="font-medium text-foreground">
            {filteredEvents.length}
          </span>{' '}
          {filteredEvents.length === 1 ? 'entry' : 'entries'}
          {filter === 'all' && !query.trim() ? (
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
