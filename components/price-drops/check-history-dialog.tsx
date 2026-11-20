'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type {
  CheckOutcome,
  SourceCheck,
  SourceCheckHistory,
} from '@/lib/price-monitor/insights'
import { cn } from '@/lib/utils'
import { AVAILABILITY_LABEL, money, storeLabel } from './price-format'

export type CheckHistoryTarget = { sourceId: number; storeName: string }

const OUTCOME_LABEL: Record<CheckOutcome, string> = {
  ok: 'Read',
  no_price: 'No price',
  failed: 'Failed',
  blocked: 'Blocked',
}

const OUTCOME_TONE: Record<CheckOutcome, string> = {
  ok: 'ok',
  no_price: 'warn',
  failed: 'bad',
  blocked: 'bad',
}

const TRIGGER_LABEL: Record<string, string> = {
  scheduled: 'Scheduled',
  manual: 'Check now',
  retry: 'Retry',
  probe: 'Probe',
}

const METHOD_LABEL: Record<string, string> = {
  http: 'HTTP',
  browser: 'Browser',
  headed: 'Visible browser',
  ai: 'AI read',
  solver: 'AI solver',
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; history: SourceCheckHistory }
  | { status: 'error'; message: string }

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

function CheckRow({ check }: { check: SourceCheck }) {
  const reading = check.reading
  const details = [
    TRIGGER_LABEL[check.trigger] ?? check.trigger,
    check.method ? (METHOD_LABEL[check.method] ?? check.method) : null,
    check.attempt > 1 ? `attempt ${check.attempt}` : null,
    check.httpStatus ? `HTTP ${check.httpStatus}` : null,
    seconds(check.durationMs),
  ].filter(Boolean)
  return (
    <li
      data-price-check={check.outcome}
      className="space-y-1 border-t border-[var(--bladevault-line)]/60 py-2 first:border-t-0"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          data-price-dot={OUTCOME_TONE[check.outcome]}
          aria-hidden="true"
          className="inline-block size-2 shrink-0 rounded-full"
        />
        <span className="font-medium">{OUTCOME_LABEL[check.outcome]}</span>
        {reading ? (
          <span className="tabular-nums">
            {reading.availability === 'out_of_stock'
              ? 'Out of stock'
              : money(reading.priceMinor, reading.currency)}
          </span>
        ) : null}
        {reading && AVAILABILITY_LABEL[reading.availability] ? (
          <span
            data-price-availability
            className="rounded-full px-1.5 text-[11px] font-semibold"
          >
            {AVAILABILITY_LABEL[reading.availability]}
          </span>
        ) : null}
        {reading?.aiReview === 'unconfirmed' ? (
          <span
            data-price-ai-review="unconfirmed"
            className="rounded-full border border-dashed border-muted-foreground px-1.5 text-[11px] text-muted-foreground"
          >
            AI unconfirmed
          </span>
        ) : reading?.aiReview === 'confirmed' ? (
          <span className="rounded-full border border-[var(--bladevault-line)] px-1.5 text-[11px] text-muted-foreground">
            AI confirmed
          </span>
        ) : null}
        <time
          dateTime={check.startedAt}
          className="ml-auto text-xs text-muted-foreground tabular-nums"
        >
          {new Date(check.startedAt).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </time>
      </div>
      <div className="text-xs text-muted-foreground">{details.join(' · ')}</div>
      {check.errorMessage ? (
        <p
          className={cn(
            'text-xs break-words',
            check.outcome === 'failed' || check.outcome === 'blocked'
              ? 'text-destructive'
              : 'text-muted-foreground',
          )}
        >
          {check.errorMessage}
        </p>
      ) : null}
      {check.solverSteps.length ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            AI steps ({check.solverSteps.length})
          </summary>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5">
            {check.solverSteps.map((step, index) => (
              <li key={index} className="break-words">
                <span className="font-medium">{step.action}</span>
                {step.detail ? ` “${step.detail}”` : ''}
                {step.result ? (
                  <span className="text-muted-foreground">
                    {' '}
                    — {step.result}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </li>
  )
}

function CheckHistoryBody({ sourceId }: { sourceId: number }) {
  const [state, setState] = useState<State>({ status: 'loading' })
  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const response = await fetch(`/api/prices/sources/${sourceId}/checks`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        const data = (await response.json()) as SourceCheckHistory & {
          error?: string
        }
        if (controller.signal.aborted) return
        if (!response.ok)
          setState({
            status: 'error',
            message: data.error ?? 'Could not load the check history.',
          })
        else setState({ status: 'ready', history: data })
      } catch {
        if (!controller.signal.aborted)
          setState({
            status: 'error',
            message: 'Could not load the check history.',
          })
      }
    }
    void load()
    return () => controller.abort()
  }, [sourceId])

  if (state.status === 'loading')
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading checks…
      </p>
    )
  if (state.status === 'error')
    return <p className="text-xs text-destructive">{state.message}</p>
  if (!state.history.checks.length)
    return (
      <p className="text-xs text-muted-foreground">
        This store has not been checked yet.
      </p>
    )
  return (
    <ul
      data-price-check-history
      className="-mx-1 max-h-[60vh] overflow-y-auto px-1"
    >
      {state.history.checks.map((check) => (
        <CheckRow key={check.id} check={check} />
      ))}
    </ul>
  )
}

/**
 * The last 30 checks of one store page: what each read, how it loaded,
 * errors, AI steps, and readings AI could not confirm.
 */
export function CheckHistoryDialog({
  target,
  onClose,
}: {
  target: CheckHistoryTarget | null
  onClose: () => void
}) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      {target ? (
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Check history · {storeLabel(target.storeName)}
            </DialogTitle>
            <DialogDescription>
              The latest checks of this store page, newest first.
            </DialogDescription>
          </DialogHeader>
          <CheckHistoryBody sourceId={target.sourceId} />
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
