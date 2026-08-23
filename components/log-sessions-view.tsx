'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Database,
  Filter,
  GitCompareArrows,
  Loader2,
  Minus,
  Plus,
  Search,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
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
  const now = new Date()
  const isSameDay = (left: Date, right: Date) =>
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const time = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  if (isSameDay(date, now)) return `Today, ${time}`
  if (isSameDay(date, yesterday)) return `Yesterday, ${time}`
  const datePart = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
  return `${datePart}, ${time}`
}

function formatLastActivity(occurredAt: string | undefined): string {
  if (!occurredAt) return 'No activity'
  const date = new Date(occurredAt)
  const now = new Date()
  const seconds = Math.max(
    0,
    Math.floor((now.getTime() - date.getTime()) / 1000),
  )
  if (seconds < 60) return 'Just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
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
        }))
        if (!cancelled) {
          setEvents(loaded)
          if (loaded.length > 0) {
            setExpandedIds(new Set([loaded[0].id]))
          }
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

  const summaryItems = useMemo<
    Array<{ value: string; label: string; icon: LucideIcon }>
  >(() => {
    const eventsThisWeek = events.filter((event) =>
      isWithinLastWeek(event.occurredAt),
    ).length
    const aiAssisted = events.filter(
      (event) => event.actor === 'MCP client',
    ).length
    const totalWrites = events.filter(
      (event) =>
        event.type === 'created' ||
        event.type === 'updated' ||
        event.type === 'deleted',
    ).length
    const lastActivity = events[0]?.occurredAt
    return [
      {
        value: String(eventsThisWeek),
        label: 'Events this week',
        icon: Activity,
      },
      { value: String(aiAssisted), label: 'AI-assisted changes', icon: Bot },
      { value: String(totalWrites), label: 'Total writes', icon: Check },
      {
        value: formatLastActivity(lastActivity),
        label: 'Last activity',
        icon: Clock3,
      },
    ]
  }, [events])

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
      <section
        aria-label="Log summary"
        className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4"
      >
        {summaryItems.map(({ value, label, icon: Icon }) => (
          <Card key={label} className="gap-0 py-0 shadow-sm">
            <div className="p-4">
              <Icon className="mb-5 size-4 text-[var(--bladevault-title)]" />
              <strong className="block text-xl font-semibold tracking-tight">
                {value}
              </strong>
              <span className="mt-1 block text-[11px] text-muted-foreground">
                {label}
              </span>
            </div>
          </Card>
        ))}
      </section>

      <div className="mb-5 flex flex-col gap-3 rounded-xl border border-border bg-card p-3 shadow-sm sm:flex-row">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search logs</span>
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search event, knife, actor, or source"
            className="pl-9"
            disabled={isLoading}
          />
        </label>
        <div
          className="flex items-center gap-1 overflow-x-auto"
          aria-label="Filter log event type"
        >
          <Filter className="mx-2 size-4 shrink-0 text-muted-foreground" />
          {(['all', 'created', 'updated', 'deleted', 'system'] as const).map(
            (value) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={filter === value ? 'secondary' : 'ghost'}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                disabled={isLoading}
                className={cn(
                  'shrink-0 text-xs capitalize',
                  filter === value &&
                    'bg-[var(--bladevault-olive)] text-[var(--bladevault-gold)] hover:bg-[var(--bladevault-olive)] hover:text-[var(--bladevault-gold)]',
                )}
              >
                {value}
              </Button>
            ),
          )}
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-destructive/50 bg-destructive/10 p-10 text-center text-sm text-destructive">
          {error}
        </div>
      ) : isLoading ? (
        <div className="flex items-center justify-center rounded-xl border border-border bg-card p-10 text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          Loading audit log…
        </div>
      ) : (
        <section aria-labelledby="event-stream-title">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 id="event-stream-title" className="text-sm font-semibold">
                Change timeline
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {filteredEvents.length} changes · newest first · open any change
                to inspect its diff
              </p>
            </div>
            {events.length === 0 ? null : (
              <Badge variant="outline" className="font-mono text-[10px]">
                LOCAL DATA
              </Badge>
            )}
          </div>
          {filteredEvents.length ? (
            <ol className="relative list-none before:absolute before:top-6 before:bottom-6 before:left-5 before:hidden before:w-px before:-translate-x-1/2 before:bg-border before:content-[''] md:before:block">
              {filteredEvents.map((event) => {
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
                              <span className="truncate">{event.source}</span>
                              <span aria-hidden>·</span>
                              <code className="font-mono">
                                {event.operationId}
                              </code>
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
                          <div className="mt-3 overflow-hidden rounded-lg border border-border bg-card">
                            <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-2">
                              <h3 className="text-xs font-semibold">
                                Field changes
                              </h3>
                              <span className="font-mono text-[10px] text-muted-foreground">
                                {event.changes.length} fields
                              </span>
                            </div>
                            {event.changes.map((change) => (
                              <div
                                key={change.field}
                                className="border-b border-border p-3 last:border-0"
                              >
                                <span className="block text-[11px] font-medium">
                                  {change.field}
                                </span>
                                <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2 font-mono text-[10px]">
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
                        </div>
                      ) : null}
                    </Card>
                  </li>
                )
              })}
            </ol>
          ) : (
            <div className="rounded-xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
              No events match these filters.
            </div>
          )}
        </section>
      )}
    </div>
  )
}
