import Link from 'next/link'
import { ArrowUpRight, GitCompareArrows, History, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { AuditLogEvent } from '@/lib/data'

export function LogEventDetails({
  event,
  title,
  time,
  knifeHref,
  knifeUnavailable,
  onClose,
}: {
  event: AuditLogEvent
  title: string
  time: string
  knifeHref: string | null
  knifeUnavailable: boolean
  onClose: () => void
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/40 px-5 py-3">
        <h2 className="text-xs font-semibold">Event details</h2>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label="Close event details"
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="px-5">
        <section className="py-5">
          <h3 className="text-base font-semibold tracking-tight [overflow-wrap:anywhere]">
            {event.subject}
          </h3>
          {knifeHref ? (
            <Link
              href={knifeHref}
              className="mt-2 inline-flex items-center gap-1 rounded-sm text-[11px] font-medium text-[var(--bladevault-title)] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring dark:text-[var(--bladevault-gold)]"
            >
              Open knife details <ArrowUpRight className="size-3.5" />
            </Link>
          ) : knifeUnavailable ? (
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              This knife is no longer in the collection. Its history is
              retained.
            </p>
          ) : null}
        </section>
        <section
          className="border-t border-border/60 py-5"
          aria-label="Activity"
        >
          <h3 className="mb-4 flex items-center gap-2 text-xs font-semibold">
            <History className="size-3.5 text-[var(--bladevault-title)] dark:text-[var(--bladevault-gold)]" />
            Activity
          </h3>
          <dl className="grid grid-cols-2 gap-x-5 gap-y-3.5 text-xs [&_dt]:mb-1 [&_dt]:text-[10px] [&_dt]:text-muted-foreground [&_dd]:font-medium [&_dd]:leading-relaxed [&_dd]:[overflow-wrap:anywhere]">
            <div>
              <dt>Event</dt>
              <dd>{title}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{event.source}</dd>
            </div>
            <div>
              <dt>Date</dt>
              <dd>
                {new Date(event.occurredAt).toLocaleDateString(undefined, {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
              </dd>
            </div>
            <div>
              <dt>Time</dt>
              <dd className="tabular-nums">
                <time dateTime={event.occurredAt}>{time}</time>
              </dd>
            </div>
            <div>
              <dt>Actor</dt>
              <dd>{event.actor}</dd>
            </div>
          </dl>
        </section>
        <section
          className="border-t border-border/60 py-5"
          aria-label="Changes"
        >
          <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold">
            <GitCompareArrows className="size-3.5 text-[var(--bladevault-title)] dark:text-[var(--bladevault-gold)]" />
            Changes{event.changes.length ? ` · ${event.changes.length}` : ''}
          </h3>
          <p className="mb-4 whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
            {event.summary}
          </p>
          {event.changes.length ? (
            <table className="w-full table-fixed text-left text-[11px] leading-relaxed">
              <caption className="sr-only">Before and after values</caption>
              <thead>
                <tr className="text-[10px] text-muted-foreground [&_th]:pb-2 [&_th]:font-normal [&_th]:pr-3">
                  <th scope="col" className="w-[28%]">
                    Field
                  </th>
                  <th scope="col">Before</th>
                  <th scope="col">After</th>
                </tr>
              </thead>
              <tbody>
                {event.changes.map((change, index) => (
                  <tr
                    key={`${change.field}-${index}`}
                    className="border-t border-border/60 [&_td]:py-3 [&_td]:pr-3 [&_td]:align-top [&_td]:whitespace-pre-wrap [&_td]:[overflow-wrap:anywhere]"
                  >
                    <td>{change.field}</td>
                    <td className="text-muted-foreground">
                      {change.before || '—'}
                    </td>
                    <td className="font-medium">{change.after || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              No field changes recorded.
            </p>
          )}
        </section>
        <details className="border-t border-border/60 py-4 text-[10px] text-muted-foreground">
          <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
            Technical details
          </summary>
          <dl className="mt-3 space-y-3 [&_dt]:mb-1 [&_dd]:font-mono [&_dd]:[overflow-wrap:anywhere]">
            <div>
              <dt>Event ID</dt>
              <dd>{event.id}</dd>
            </div>
            <div>
              <dt>Operation ID</dt>
              <dd>{event.operationId}</dd>
            </div>
          </dl>
        </details>
      </div>
    </>
  )
}
