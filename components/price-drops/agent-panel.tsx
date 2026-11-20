'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Bot, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type {
  AgentAction,
  AgentCoverage,
  AgentLabels,
  AgentRun,
} from '@/lib/price-monitor/agent'
import type { PriceAgentMode } from '@/lib/settings-shared'
import { cn } from '@/lib/utils'
import { useKnives } from '@/components/providers/knives-provider'
import { getHourCycle } from '@/lib/time-format'
import { clockTime, relativeTime, storeLabel } from './price-format'
import { StatusDot, useMinuteClock } from './price-ui'

/**
 * The AI supervisor on Price Drops: a status strip above Monitoring status
 * (mode, latest summary, coverage, what it did, what needs the user) and an
 * activity feed under the selected knife (every action, newest first).
 */
export type AgentState = {
  mode: PriceAgentMode
  aiConfigured: boolean
  usage: 'limited' | 'unlimited'
  active: boolean
  running: boolean
  intervalMinutes: number
  nextRunAt: string | null
  blockedStores: string[]
  runs: AgentRun[]
  labels: AgentLabels
}

const REFRESH_MS = 60_000

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: string
  }
  if (!response.ok) throw new Error(data.error ?? fallback)
  return data
}

/** The supervisor's state, refreshed every minute and after changes. */
export function useAgentState(version: number) {
  const [state, setState] = useState<AgentState | null>(null)
  const [busy, setBusy] = useState<'run' | 'mode' | null>(null)
  const [notice, setNotice] = useState<{
    tone: 'ok' | 'error'
    text: string
  } | null>(null)

  const [tick, setTick] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const response = await fetch('/api/prices/agent', {
          cache: 'no-store',
          signal: controller.signal,
        })
        const data = await readJson<AgentState>(
          response,
          'Could not read the supervisor.',
        )
        if (!controller.signal.aborted) setState(data)
      } catch {
        // The strip stays as it was; the page works without it.
      }
    }
    void load()
    return () => controller.abort()
  }, [version, tick])

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setTick((value) => value + 1)
    }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [])

  const run = async () => {
    setBusy('run')
    setNotice(null)
    try {
      const data = await readJson<AgentState & { run: AgentRun }>(
        await fetch('/api/prices/agent', { method: 'POST' }),
        'The supervisor run failed.',
      )
      setState(data)
      setNotice(
        data.run.ok
          ? null
          : { tone: 'error', text: data.run.error ?? 'The run failed.' },
      )
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(null)
    }
  }

  const setMode = async (mode: PriceAgentMode) => {
    setBusy('mode')
    setNotice(null)
    try {
      setState(
        await readJson<AgentState>(
          await fetch('/api/prices/agent', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode }),
          }),
          'Could not change the supervisor.',
        ),
      )
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(null)
    }
  }

  return { state, busy, notice, run, setMode }
}

type AgentControls = ReturnType<typeof useAgentState>

const MODE_LABEL: Record<PriceAgentMode, string> = {
  off: 'Off',
  observe: 'Observe',
  act: 'Act',
}

function ModeSwitch({ controls }: { controls: AgentControls }) {
  const { state, busy, setMode } = controls
  if (!state) return null
  return (
    <div
      role="radiogroup"
      aria-label="AI supervisor mode"
      className="inline-flex rounded-lg border border-[var(--bladevault-line)] p-0.5"
    >
      {(Object.keys(MODE_LABEL) as PriceAgentMode[]).map((mode) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={state.mode === mode}
          disabled={busy !== null || !state.aiConfigured}
          onClick={() => {
            if (state.mode !== mode) void setMode(mode)
          }}
          className={cn(
            'rounded-md px-2.5 py-0.5 text-xs transition-colors disabled:opacity-60 sm:text-[13px]',
            state.mode === mode
              ? 'bg-[var(--bladevault-nav-active-bg)] font-semibold text-[var(--bladevault-nav-active-fg)]'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {MODE_LABEL[mode]}
        </button>
      ))}
    </div>
  )
}

function RunButton({ controls }: { controls: AgentControls }) {
  const { state, busy, run } = controls
  if (!state || state.mode === 'off') return null
  const running = busy === 'run' || state.running
  return (
    <Button
      type="button"
      size="sm"
      className="h-7 gap-1.5"
      disabled={busy !== null || state.running || !state.aiConfigured}
      onClick={() => void run()}
    >
      {running ? <Loader2 className="size-3.5 animate-spin" /> : null}
      {running ? 'Running…' : 'Run now'}
    </Button>
  )
}

function NeedsYou({ stores }: { stores: string[] }) {
  if (!stores.length) return null
  const names = stores.map(storeLabel)
  const listed =
    names.length > 3
      ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
      : names.join(' and ')
  return (
    <p className="pd-agent-attn">
      <b>Needs you:</b> {listed} {stores.length === 1 ? 'shows' : 'show'} a bot
      check. Select Solve in the table to pass it in a browser; AI never solves
      bot checks.
    </p>
  )
}

function CoverageMeter({ coverage }: { coverage: AgentCoverage }) {
  const total = Math.max(1, coverage.monitored)
  const attention =
    coverage.failed + coverage.blocked + coverage.priceUnavailable
  const fresh = Math.max(
    0,
    coverage.monitored -
      coverage.neverChecked -
      attention -
      coverage.outOfStock,
  )
  const parts = [
    { key: 'fresh', label: 'read', value: fresh, color: 'var(--price-drop)' },
    {
      key: 'oos',
      label: 'out of stock',
      value: coverage.outOfStock,
      color: 'var(--price-stock)',
    },
    {
      key: 'attention',
      label: 'need attention',
      value: attention,
      color: 'var(--price-attention)',
    },
    {
      key: 'never',
      label: 'never checked',
      value: coverage.neverChecked,
      color: 'var(--price-neutral)',
    },
  ]
  return (
    <div>
      <div className="pd-agent-meter" role="img" aria-label="Coverage">
        {parts.map((part) =>
          part.value ? (
            <i
              key={part.key}
              style={{
                width: `${(part.value / total) * 100}%`,
                background: part.color,
              }}
            />
          ) : null,
        )}
      </div>
      <p className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
        {parts.map((part) => (
          <span key={part.key} className="inline-flex items-center gap-1.5">
            <i
              aria-hidden="true"
              className="inline-block size-2 rounded-[2px]"
              style={{ background: part.color }}
            />
            <b className="font-semibold text-foreground tabular-nums">
              {part.value}
            </b>{' '}
            {part.label}
          </span>
        ))}
        <span>
          of{' '}
          <b className="font-semibold text-foreground tabular-nums">
            {coverage.monitored}
          </b>{' '}
          monitored
        </span>
        {coverage.stale ? (
          <span>
            <b className="font-semibold text-foreground tabular-nums">
              {coverage.stale}
            </b>{' '}
            stale
          </span>
        ) : null}
      </p>
    </div>
  )
}

const KIND_SUMMARY: Record<AgentAction['kind'], [string, string]> = {
  check: ['check moved forward', 'checks moved forward'],
  retryWithAi: ['page retried with AI', 'pages retried with AI'],
  fetchMode: ['loading change', 'loading changes'],
  pause: ['page paused', 'pages paused'],
  searchOtherStore: ['other-store search', 'other-store searches'],
}

/** A: the strip above Monitoring status. */
export function AgentStrip({
  controls,
  now,
}: {
  controls: AgentControls
  now: number
}) {
  const { state, notice } = controls
  if (!state || !state.aiConfigured) return null
  const last = state.runs[0]
  const done = last?.mode === 'act' ? 'applied' : 'proposed'
  const counts = new Map<AgentAction['kind'], number>()
  for (const action of last?.actions ?? [])
    if (action.status === done)
      counts.set(action.kind, (counts.get(action.kind) ?? 0) + 1)
  const refused =
    last?.actions.filter((action) => action.status === 'refused').length ?? 0

  // Off and never run: one line with a way to turn it on.
  if (state.mode === 'off' && !last)
    return (
      <section
        data-agent-strip="off"
        aria-labelledby="agent-strip-title"
        className="mb-4 rounded-xl border border-[var(--bladevault-line)] bg-card"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
          <h2
            id="agent-strip-title"
            className="flex items-center gap-2 text-sm font-semibold"
          >
            <StatusDot tone="idle" />
            <Bot className="size-4 text-muted-foreground" aria-hidden="true" />
            AI supervisor
            <span className="rounded-full border border-[var(--bladevault-line)] px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
              off
            </span>
          </h2>
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            AI can decide which checks go first.{' '}
            <Link href="/settings?tab=prices" className="underline">
              Learn more
            </Link>
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7"
            disabled={controls.busy !== null}
            onClick={() => void controls.setMode('observe')}
          >
            {controls.busy === 'mode' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : null}
            Turn on
          </Button>
        </div>
        {state.blockedStores.length || notice ? (
          <div className="space-y-2 px-4 pb-3 text-sm">
            <NeedsYou stores={state.blockedStores} />
            {notice ? (
              <p role="status" className="text-xs text-destructive">
                {notice.text}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>
    )

  return (
    <section
      data-agent-strip
      aria-labelledby="agent-strip-title"
      className="mb-4 rounded-xl border border-[var(--bladevault-line)] bg-card"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--bladevault-line)]/60 px-4 py-3">
        <h2
          id="agent-strip-title"
          className="flex items-center gap-2 text-sm font-semibold"
        >
          <StatusDot
            tone={
              state.running
                ? 'run'
                : state.mode === 'off'
                  ? 'idle'
                  : last && !last.ok
                    ? 'bad'
                    : 'ok'
            }
          />
          <Bot className="size-4 text-muted-foreground" aria-hidden="true" />
          AI supervisor
          <span className="rounded-full border border-[var(--bladevault-line)] px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
            {state.mode === 'off'
              ? 'off'
              : `${MODE_LABEL[state.mode]} · every ${state.intervalMinutes} min · ${state.usage === 'unlimited' ? 'Unlimited' : 'Limited'}`}
          </span>
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {last ? (
            <span className="text-xs text-muted-foreground">
              Last run {relativeTime(last.startedAt, now, 'short')}
              {state.nextRunAt && state.mode !== 'off'
                ? ` · next ${Date.parse(state.nextRunAt) <= now ? 'soon' : relativeTime(state.nextRunAt, now, 'short')}`
                : ''}
            </span>
          ) : null}
          <ModeSwitch controls={controls} />
          <RunButton controls={controls} />
        </div>
      </header>
      <div className="space-y-3 px-4 py-3 text-sm">
        {last ? (
          last.ok ? (
            <p>{last.summary || 'Nothing needed attention.'}</p>
          ) : (
            <p className="text-destructive">
              The last run failed: {last.error}
            </p>
          )
        ) : state.mode !== 'off' ? (
          <p className="text-muted-foreground">
            No runs yet. The first one starts within a minute, or select Run
            now.
          </p>
        ) : null}
        {last?.coverage ? <CoverageMeter coverage={last.coverage} /> : null}
        {last?.ok && (counts.size || refused) ? (
          <div className="flex flex-wrap gap-1.5">
            {[...counts].map(([kind, count]) => (
              <span
                key={kind}
                className="pd-badge"
                data-result={done === 'applied' ? 'drop' : 'pending'}
              >
                {done === 'applied' ? '✓' : '○'} {count}{' '}
                {KIND_SUMMARY[kind][count === 1 ? 0 : 1]}
                {done === 'proposed' ? ' (proposed)' : ''}
              </span>
            ))}
            {refused ? (
              <span className="pd-badge" data-result="same">
                — {refused} refused
              </span>
            ) : null}
          </div>
        ) : null}
        <NeedsYou stores={state.blockedStores} />
        {notice ? (
          <p
            role="status"
            className={cn(
              'text-xs',
              notice.tone === 'error'
                ? 'text-destructive'
                : 'text-muted-foreground',
            )}
          >
            {notice.text}
          </p>
        ) : null}
      </div>
    </section>
  )
}

type FeedItem = {
  key: string
  at: string
  status: AgentAction['status'] | 'failed'
  what: React.ReactNode
  why: string
}

type Filter = 'all' | 'applied' | 'refused' | 'failed'

const STATUS_RESULT: Record<FeedItem['status'], string> = {
  applied: 'drop',
  proposed: 'pending',
  refused: 'same',
  failed: 'increase',
}

const ACTION_LABEL: Record<AgentAction['kind'], string> = {
  check: 'Check first',
  retryWithAi: 'Retry with AI',
  fetchMode: 'Load page',
  pause: 'Pause',
  searchOtherStore: 'Other stores',
}

function feedItems(
  state: AgentState,
  onSelect: (knifeId: string) => void,
): FeedItem[] {
  const items: FeedItem[] = []
  const knifeLink = (knifeId: string | undefined, label: string) =>
    knifeId ? (
      <button
        type="button"
        className="underline decoration-[var(--bladevault-line)] underline-offset-2 hover:decoration-current"
        onClick={() => onSelect(knifeId)}
      >
        {label}
      </button>
    ) : (
      label
    )
  for (const run of state.runs) {
    if (!run.ok) {
      items.push({
        key: `${run.id}:failed`,
        at: run.startedAt,
        status: 'failed',
        what: 'Run failed',
        why: run.error ?? '',
      })
      continue
    }
    // Applied or proposed checks of one run read as one line.
    const done = run.mode === 'act' ? 'applied' : 'proposed'
    const checks = run.actions.filter(
      (action) => action.kind === 'check' && action.status === done,
    )
    if (checks.length > 1) {
      const stores = new Set(
        checks.map(
          (action) => state.labels.sources[String(action.sourceId)]?.store,
        ),
      )
      items.push({
        key: `${run.id}:checks`,
        at: run.startedAt,
        status: done,
        what: (
          <>
            {done === 'applied' ? 'Moved' : 'Would move'}{' '}
            <b>{checks.length} checks</b> forward at {stores.size}{' '}
            {stores.size === 1 ? 'store' : 'stores'}
          </>
        ),
        why: checks[0].reason,
      })
    }
    run.actions.forEach((action, index) => {
      if (checks.length > 1 && checks.includes(action)) return
      const source =
        action.sourceId !== undefined
          ? state.labels.sources[String(action.sourceId)]
          : undefined
      const knifeName =
        source?.knife ??
        (action.knifeId ? state.labels.knives[action.knifeId] : undefined) ??
        (action.sourceId !== undefined
          ? `source ${action.sourceId}`
          : 'a knife')
      items.push({
        key: `${run.id}:${index}`,
        at: run.startedAt,
        status: action.status,
        what: (
          <>
            {ACTION_LABEL[action.kind]}
            {action.mode ? ` (${action.mode})` : ''} ·{' '}
            {knifeLink(source?.knifeId ?? action.knifeId, knifeName)}
            {source ? (
              <span className="text-muted-foreground">
                {' '}
                · {storeLabel(source.store)}
              </span>
            ) : null}
          </>
        ),
        why: [action.reason, action.note].filter(Boolean).join(' · '),
      })
    })
  }
  return items
}

const FILTERS: Filter[] = ['all', 'applied', 'refused', 'failed']
const MAX_FEED = 60

/** C: the activity feed under the selected knife. */
export function AgentFeed({
  controls,
  onSelect,
}: {
  controls: AgentControls
  onSelect: (knifeId: string) => void
}) {
  const [filter, setFilter] = useState<Filter>('all')
  const hourCycle = getHourCycle(useKnives().timeFormat)
  const now = useMinuteClock()
  const { state } = controls
  if (
    !state ||
    !state.aiConfigured ||
    (state.mode === 'off' && !state.runs.length)
  )
    return null
  const all = feedItems(state, onSelect)
  const shown = all
    .filter(
      (item) =>
        filter === 'all' ||
        item.status === filter ||
        (filter === 'applied' && item.status === 'proposed'),
    )
    .slice(0, MAX_FEED)
  return (
    <section
      data-agent-feed
      aria-labelledby="agent-feed-title"
      className="mt-5 border-t border-[var(--bladevault-line)]/60 pt-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          id="agent-feed-title"
          className="flex items-center gap-2 text-sm font-semibold"
        >
          <Bot className="size-4 text-muted-foreground" aria-hidden="true" />
          Supervisor activity
        </h3>
      </div>
      <div
        role="tablist"
        aria-label="Filter supervisor activity"
        className="mt-2 inline-flex flex-wrap gap-0.5 rounded-lg border border-[var(--bladevault-line)] p-0.5"
      >
        {FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={filter === value}
            onClick={() => setFilter(value)}
            className={cn(
              'rounded-md px-2 py-0.5 text-xs capitalize transition-colors',
              filter === value
                ? 'bg-[var(--bladevault-nav-active-bg)] font-semibold text-[var(--bladevault-nav-active-fg)]'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {value === 'failed' ? 'Failed runs' : value}
          </button>
        ))}
      </div>
      {shown.length ? (
        <ol className="mt-2 divide-y divide-[var(--bladevault-line)]/60">
          {shown.map((item) => (
            <li
              key={item.key}
              className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] gap-2 py-2"
            >
              <time
                dateTime={item.at}
                className="pt-0.5 text-xs whitespace-nowrap text-muted-foreground tabular-nums"
              >
                {clockTime(item.at, hourCycle, now)}
              </time>
              <div className="min-w-0">
                <p className="text-[13px] break-words">{item.what}</p>
                {item.why ? (
                  <p className="text-xs break-words text-muted-foreground">
                    {item.why}
                  </p>
                ) : null}
              </div>
              <span
                className="pd-badge self-start"
                data-result={STATUS_RESULT[item.status]}
              >
                {item.status}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">Nothing here yet.</p>
      )}
    </section>
  )
}
