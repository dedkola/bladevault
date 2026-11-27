'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Bot, ChevronRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type {
  AgentAction,
  AgentCoverage,
  AgentEvent,
  AgentLabels,
  AgentNote,
  AgentRun,
} from '@/lib/price-monitor/agent'
import type { PriceAgentMode } from '@/lib/settings-shared'
import { cn } from '@/lib/utils'
import { useKnives } from '@/components/providers/knives-provider'
import { getHourCycle } from '@/lib/time-format'
import { clockTime, relativeTime, storeLabel } from './price-format'
import { StatusDot, useMinuteClock } from './price-ui'
import type { KnifeCoverage } from './price-table-model'

/**
 * The AI supervisor on Price Drops: a status strip above Monitoring status
 * (mode, latest summary, coverage, what it did, what needs the user) and a
 * Supervisor tab beside the price sections (a run timeline and each run's
 * actions).
 */
export type AgentState = {
  mode: PriceAgentMode
  aiConfigured: boolean
  usage: 'limited' | 'unlimited'
  active: boolean
  running: boolean
  /** The heartbeat: a run at least this often. */
  intervalMinutes: number
  /** Changes wake it, at most this often. */
  eventGapMinutes: number
  /** Changes since the last run that will wake it. */
  pendingEvents: number
  nextRunAt: string | null
  blockedStores: string[]
  runs: AgentRun[]
  labels: AgentLabels
  /** Notes the supervisor keeps for its later runs. */
  notes: AgentNote[]
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
  const [busy, setBusy] = useState<'run' | 'mode' | 'note' | null>(null)
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

  const forgetNote = async (noteId: number) => {
    setBusy('note')
    setNotice(null)
    try {
      setState(
        await readJson<AgentState>(
          await fetch('/api/prices/agent', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ noteId }),
          }),
          'Could not forget the note.',
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

  return { state, busy, notice, run, setMode, forgetNote }
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

type CoveragePart = { key: string; label: string; value: number; color: string }

/** A coverage bar and its legend: parts of `total`, in `unit`. */
function CoverageBar({
  parts,
  total,
  unit,
  stale,
}: {
  parts: CoveragePart[]
  total: number
  unit: string
  stale: number
}) {
  const width = Math.max(1, total)
  return (
    <div>
      <div className="pd-agent-meter" role="img" aria-label="Coverage">
        {parts.map((part) =>
          part.value ? (
            <i
              key={part.key}
              style={{
                width: `${(part.value / width) * 100}%`,
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
          <b className="font-semibold text-foreground tabular-nums">{total}</b>{' '}
          {unit}
        </span>
        {stale ? (
          <span>
            <b className="font-semibold text-foreground tabular-nums">
              {stale}
            </b>{' '}
            stale
          </span>
        ) : null}
      </p>
    </div>
  )
}

/** What a supervisor run saw, in store links. */
function CoverageMeter({ coverage }: { coverage: AgentCoverage }) {
  const attention =
    coverage.failed + coverage.blocked + coverage.priceUnavailable
  const fresh = Math.max(
    0,
    coverage.monitored -
      coverage.neverChecked -
      attention -
      coverage.outOfStock,
  )
  return (
    <CoverageBar
      total={coverage.monitored}
      unit="monitored"
      stale={coverage.stale}
      parts={[
        {
          key: 'fresh',
          label: 'read',
          value: fresh,
          color: 'var(--price-drop)',
        },
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
      ]}
    />
  )
}

/** The monitored knives now, counted like the tabs (sold out = Out of stock). */
function KnifeCoverageMeter({ coverage }: { coverage: KnifeCoverage }) {
  return (
    <CoverageBar
      total={coverage.monitored}
      unit="knives"
      stale={coverage.stale}
      parts={[
        {
          key: 'fresh',
          label: 'read',
          value: coverage.read,
          color: 'var(--price-drop)',
        },
        {
          key: 'oos',
          label: 'sold out',
          value: coverage.soldOut,
          color: 'var(--price-stock)',
        },
        {
          key: 'attention',
          label: 'need attention',
          value: coverage.attention,
          color: 'var(--price-attention)',
        },
        {
          key: 'never',
          label: 'never checked',
          value: coverage.neverChecked,
          color: 'var(--price-neutral)',
        },
      ]}
    />
  )
}

const KIND_SUMMARY: Record<AgentAction['kind'], [string, string]> = {
  check: ['check moved forward', 'checks moved forward'],
  retryWithAi: ['page retried with AI', 'pages retried with AI'],
  findPage: ['moved page searched for', 'moved pages searched for'],
  fetchMode: ['loading change', 'loading changes'],
  pause: ['page paused', 'pages paused'],
  searchOtherStore: ['other-store search', 'other-store searches'],
  watchClosely: ['knife watched closely', 'knives watched closely'],
  crossCheck: ['knife cross-checked', 'knives cross-checked'],
  advise: ['note to the Inbox', 'notes to the Inbox'],
  ask: ['question in the Inbox', 'questions in the Inbox'],
  remember: ['note kept', 'notes kept'],
  forget: ['note forgotten', 'notes forgotten'],
}

/** A: the strip above Monitoring status. */
export function AgentStrip({
  controls,
  now,
  knives,
}: {
  controls: AgentControls
  now: number
  /** The monitored knives now; without it, what the last run saw. */
  knives?: KnifeCoverage
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
              : `${MODE_LABEL[state.mode]} · ${scheduleText(state)} · ${state.usage === 'unlimited' ? 'Unlimited' : 'Limited'}`}
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
        {knives ? (
          <KnifeCoverageMeter coverage={knives} />
        ) : last?.coverage ? (
          <CoverageMeter coverage={last.coverage} />
        ) : null}
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

type Filter = 'all' | 'done' | 'refused'

const STATUS_RESULT: Record<AgentAction['status'] | 'failed', string> = {
  applied: 'drop',
  proposed: 'pending',
  refused: 'same',
  failed: 'increase',
}

const ACTION_LABEL: Record<AgentAction['kind'], string> = {
  check: 'Check first',
  retryWithAi: 'Retry with AI',
  findPage: 'Find new link',
  fetchMode: 'Load page',
  pause: 'Pause',
  searchOtherStore: 'Other stores',
  watchClosely: 'Watch closely',
  crossCheck: 'Cross-check',
  advise: 'Advice',
  ask: 'Question',
  remember: 'Remember',
  forget: 'Forget',
}

/** Groups of this size or more collapse into one expandable row. */
const GROUP_MIN = 3

/** True when the Supervisor tab has something to show. */
export function hasAgentActivity(state: AgentState | null): boolean {
  return Boolean(
    state && state.aiConfigured && (state.mode !== 'off' || state.runs.length),
  )
}

function runCounts(run: AgentRun) {
  let done = 0
  let refused = 0
  for (const action of run.actions)
    if (action.status === 'refused') refused += 1
    else done += 1
  return { done, refused }
}

function minutesText(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`
}

/** "on changes, at least every 1 h": how the supervisor is woken. */
function scheduleText(state: AgentState): string {
  return `on changes, at least every ${minutesText(state.intervalMinutes)}`
}

/** Why a run started, in a few words. */
function triggerText(run: AgentRun): string {
  if (run.trigger === 'event')
    return `${run.eventTotal} ${run.eventTotal === 1 ? 'change' : 'changes'}`
  return run.trigger === 'manual' ? 'Run now' : 'scheduled'
}

const EVENT_LABEL: Record<AgentEvent['type'], string> = {
  drop: 'Price drop',
  increase: 'Price up',
  out_of_stock: 'Sold out',
  back_in_stock: 'Back in stock',
  failing: 'Failing',
  bot_check: 'Bot check',
  found_listing: 'Found by Other stores',
}

/** "Kizer Drop Bear at Kizer: 129.00 USD → 99.00 USD (−23.3%)". */
function eventText(event: AgentEvent): string {
  const where = event.knife
    ? `${event.knife} at ${storeLabel(event.store)}`
    : storeLabel(event.store)
  if (event.from && event.to)
    return `${where}: ${event.from} → ${event.to}${event.pct !== undefined ? ` (${event.pct > 0 ? '+' : ''}${event.pct}%)` : ''}`
  if (event.type === 'failing')
    return `${where}: ${event.failures} checks in a row${event.error ? ` (${event.error})` : ''}`
  return event.price ? `${where}: ${event.price}` : where
}

const EVENTS_SHOWN = 8

/** What changed since the run before, newest first. */
function RunEvents({ run }: { run: AgentRun }) {
  const [all, setAll] = useState(false)
  if (!run.events?.length) return null
  const shown = all ? run.events : run.events.slice(0, EVENTS_SHOWN)
  const more = (run.eventTotal ?? run.events.length) - shown.length
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {run.trigger === 'event' ? 'Woken by' : 'Changes since the run before'}
      </h4>
      <ul className="space-y-1 text-xs">
        {shown.map((event, index) => (
          <li key={`${event.type}:${event.at}:${index}`}>
            <span className="font-medium">{EVENT_LABEL[event.type]}</span>{' '}
            <span className="text-muted-foreground">{eventText(event)}</span>
          </li>
        ))}
      </ul>
      {more > 0 ? (
        run.events.length > shown.length ? (
          <button
            type="button"
            className="text-xs underline underline-offset-2"
            onClick={() => setAll(true)}
          >
            {more} more
          </button>
        ) : (
          <p className="text-xs text-muted-foreground">and {more} more</p>
        )
      ) : null}
    </div>
  )
}

/** The supervisor's notes for its later runs; each can be forgotten. */
function AgentNotes({
  controls,
  onSelect,
}: {
  controls: AgentControls
  onSelect: (knifeId: string) => void
}) {
  const now = useMinuteClock()
  const notes = controls.state?.notes ?? []
  if (!notes.length) return null
  return (
    <div
      data-agent-notes
      className="space-y-2 border-t border-[var(--bladevault-line)]/60 px-4 py-3"
    >
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Notes for later runs ({notes.length})
      </h3>
      <ul className="space-y-1.5 text-sm">
        {notes.map((note) => (
          <li key={note.id} className="flex flex-wrap items-start gap-x-2">
            <span className="min-w-0 flex-1">
              {note.knifeId ? (
                <button
                  type="button"
                  className="mr-1 font-medium underline decoration-[var(--bladevault-line)] underline-offset-2 hover:decoration-current"
                  onClick={() => onSelect(note.knifeId!)}
                >
                  {note.knife}:
                </button>
              ) : null}
              {note.note}
              <span className="block text-xs text-muted-foreground">
                Noted {relativeTime(note.createdAt, now, 'short')} · kept until{' '}
                {new Date(note.expiresAt).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                })}
              </span>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={controls.busy === 'note'}
              onClick={() => void controls.forgetNote(note.id)}
            >
              Forget
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** One run in the timeline: time, done/refused bar, counts. */
function RunTile({
  run,
  selected,
  label,
  onSelect,
}: {
  run: AgentRun
  selected: boolean
  label: string
  onSelect: () => void
}) {
  const { done, refused } = runCounts(run)
  const total = Math.max(1, done + refused)
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'w-[8.5rem] shrink-0 snap-start rounded-lg border px-2.5 py-2 text-left transition-colors',
        selected
          ? 'border-[var(--bladevault-nav-active-fg)] bg-[var(--bladevault-nav-active-bg)]'
          : 'border-[var(--bladevault-line)] hover:bg-[var(--bladevault-surface-soft)]',
      )}
    >
      <span className="block text-[13px] font-semibold whitespace-nowrap tabular-nums">
        {label}
      </span>
      <span
        aria-hidden="true"
        className="my-1.5 flex h-1.5 overflow-hidden rounded-full bg-[var(--bladevault-surface-soft)]"
      >
        {run.ok ? (
          <>
            <i
              className="block"
              style={{
                width: `${(done / total) * 100}%`,
                background: 'var(--price-drop)',
              }}
            />
            <i
              className="block"
              style={{
                width: `${(refused / total) * 100}%`,
                background: 'var(--price-neutral)',
              }}
            />
          </>
        ) : (
          <i className="block w-full bg-destructive" />
        )}
      </span>
      <span className="block text-[11px] text-muted-foreground tabular-nums">
        {run.ok
          ? `${done} ${run.mode === 'act' ? 'applied' : 'proposed'} · ${refused} refused`
          : 'Run failed'}
      </span>
      <span className="block text-[11px] text-muted-foreground">
        {triggerText(run)} · {(run.durationMs / 1000).toFixed(1)} s
      </span>
    </button>
  )
}

type ActionRow = {
  key: string
  action: AgentAction
  knifeId: string | undefined
  knife: string
  store: string | undefined
}

/** The selected run's actions, repeated kind + result + store collapsed. */
function RunActions({
  run,
  labels,
  filter,
  onSelect,
}: {
  run: AgentRun
  labels: AgentLabels
  filter: Filter
  onSelect: (knifeId: string) => void
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const groups = new Map<string, ActionRow[]>()
  run.actions.forEach((action, index) => {
    if (filter === 'refused' && action.status !== 'refused') return
    if (filter === 'done' && action.status === 'refused') return
    const source =
      action.sourceId !== undefined
        ? labels.sources[String(action.sourceId)]
        : undefined
    const row: ActionRow = {
      key: `${run.id}:${index}`,
      action,
      knifeId: source?.knifeId ?? action.knifeId,
      knife:
        source?.knife ??
        (action.knifeId ? labels.knives[action.knifeId] : undefined) ??
        (action.sourceId !== undefined
          ? `source ${action.sourceId}`
          : 'a knife'),
      store: source?.store,
    }
    const key = `${action.kind}|${action.status}|${source?.store ?? ''}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  })

  const knifeCell = (row: ActionRow) =>
    row.knifeId ? (
      <button
        type="button"
        className="text-left underline decoration-[var(--bladevault-line)] underline-offset-2 hover:decoration-current"
        onClick={() => onSelect(row.knifeId!)}
      >
        {row.knife}
      </button>
    ) : (
      row.knife
    )
  const why = (action: AgentAction) =>
    [action.reason, action.note].filter(Boolean).join(' · ')
  const badge = (status: AgentAction['status']) => (
    <span className="pd-badge" data-result={STATUS_RESULT[status]}>
      {status}
    </span>
  )
  const cell = 'border-b border-[var(--bladevault-line)]/60 px-3 py-2 align-top'

  const body: React.ReactNode[] = []
  for (const [key, rows] of groups) {
    const first = rows[0].action
    if (rows.length < GROUP_MIN) {
      for (const row of rows)
        body.push(
          <tr key={row.key}>
            <td className={cn(cell, 'whitespace-nowrap')}>
              {ACTION_LABEL[row.action.kind]}
              {row.action.mode ? (
                <span className="text-muted-foreground">
                  {' '}
                  ({row.action.mode})
                </span>
              ) : null}
              {row.action.everyHours && row.action.hours ? (
                <span className="text-muted-foreground">
                  {' '}
                  (every {row.action.everyHours} h for {row.action.hours} h)
                </span>
              ) : null}
              {row.action.message ? (
                <span className="block text-muted-foreground">
                  {row.action.message.title}
                </span>
              ) : null}
            </td>
            <td className={cell}>{knifeCell(row)}</td>
            <td
              className={cn(cell, 'hidden text-muted-foreground sm:table-cell')}
            >
              {row.store ? storeLabel(row.store) : '—'}
            </td>
            <td className={cn(cell, 'text-xs text-muted-foreground')}>
              {why(row.action)}
            </td>
            <td className={cell}>{badge(row.action.status)}</td>
          </tr>,
        )
      continue
    }
    const expanded = open.has(key)
    body.push(
      <tr key={key} className="bg-[var(--bladevault-surface-soft)]/60">
        <td className={cn(cell, 'whitespace-nowrap')}>
          <button
            type="button"
            aria-expanded={expanded}
            className="inline-flex items-center gap-1"
            onClick={() =>
              setOpen((current) => {
                const next = new Set(current)
                if (next.has(key)) next.delete(key)
                else next.add(key)
                return next
              })
            }
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                'size-3.5 text-muted-foreground transition-transform',
                expanded && 'rotate-90',
              )}
            />
            {ACTION_LABEL[first.kind]}
          </button>
        </td>
        <td className={cn(cell, 'font-semibold')}>{rows.length} knives</td>
        <td className={cn(cell, 'hidden text-muted-foreground sm:table-cell')}>
          {rows[0].store ? storeLabel(rows[0].store) : '—'}
        </td>
        <td className={cn(cell, 'text-xs text-muted-foreground')}>
          {why(first)}
          {expanded ? null : ' …'}
        </td>
        <td className={cell}>{badge(first.status)}</td>
      </tr>,
    )
    if (expanded)
      for (const row of rows)
        body.push(
          <tr key={row.key}>
            <td className={cell} />
            <td className={cell}>{knifeCell(row)}</td>
            <td className={cn(cell, 'hidden sm:table-cell')} />
            <td className={cn(cell, 'text-xs text-muted-foreground')}>
              {why(row.action)}
            </td>
            <td className={cell} />
          </tr>,
        )
  }

  if (!body.length)
    return (
      <p className="px-3 py-6 text-sm text-muted-foreground">
        Nothing here in this run.
      </p>
    )
  return (
    <table className="w-full border-collapse text-[13px]">
      <thead>
        <tr className="text-left text-xs text-muted-foreground">
          {['Action', 'Knife', 'Store', 'Why', 'Result'].map((title) => (
            <th
              key={title}
              scope="col"
              className={cn(
                'sticky top-0 border-b border-[var(--bladevault-line)] bg-card px-3 py-2 font-medium',
                title === 'Store' && 'hidden sm:table-cell',
              )}
            >
              {title}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{body}</tbody>
    </table>
  )
}

/**
 * C: the Supervisor tab. Runs read left to right as a timeline; the selected
 * run's actions fill a wide table beside its summary and coverage.
 */
export function AgentActivity({
  controls,
  onSelect,
}: {
  controls: AgentControls
  onSelect: (knifeId: string) => void
}) {
  const [selectedRun, setSelectedRun] = useState<number | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const hourCycle = getHourCycle(useKnives().timeFormat)
  const now = useMinuteClock()
  const { state } = controls
  if (!state || !hasAgentActivity(state)) return null

  const runs = state.runs
  const run = runs.find((item) => item.id === selectedRun) ?? runs[0]
  const totals = runs.reduce(
    (sum, item) => {
      const counts = runCounts(item)
      return {
        done: sum.done + (item.ok ? counts.done : 0),
        refused: sum.refused + (item.ok ? counts.refused : 0),
        failed: sum.failed + (item.ok ? 0 : 1),
      }
    },
    { done: 0, refused: 0, failed: 0 },
  )
  const counts = run ? runCounts(run) : { done: 0, refused: 0 }
  const doneLabel = run?.mode === 'observe' ? 'Proposed' : 'Applied'
  const filters: { value: Filter; label: string; count: number }[] = [
    { value: 'all', label: 'All', count: run?.actions.length ?? 0 },
    { value: 'done', label: doneLabel, count: counts.done },
    { value: 'refused', label: 'Refused', count: counts.refused },
  ]

  return (
    <section data-agent-activity aria-label="Supervisor activity">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--bladevault-line)]/60 px-4 py-2.5 text-xs text-muted-foreground">
        <span>
          Mode{' '}
          <b className="font-semibold text-foreground">
            {MODE_LABEL[state.mode]}
          </b>
          {state.mode !== 'off' ? ` · ${scheduleText(state)}` : ''}
          {state.mode !== 'off' && state.pendingEvents
            ? ` · ${state.pendingEvents} ${state.pendingEvents === 1 ? 'change' : 'changes'} waiting`
            : ''}
          {state.mode !== 'off' && state.nextRunAt
            ? ` · next ${Date.parse(state.nextRunAt) <= now ? 'soon' : clockTime(state.nextRunAt, hourCycle, now)}`
            : ''}
        </span>
        {runs.length ? (
          <span className="tabular-nums">
            Last {runs.length} {runs.length === 1 ? 'run' : 'runs'}:{' '}
            <b className="font-semibold text-foreground">{totals.done}</b> done
            · <b className="font-semibold text-foreground">{totals.refused}</b>{' '}
            refused ·{' '}
            <b
              className={cn(
                'font-semibold',
                totals.failed ? 'text-destructive' : 'text-foreground',
              )}
            >
              {totals.failed}
            </b>{' '}
            failed
          </span>
        ) : null}
        {state.blockedStores.map((store) => (
          <span key={store} className="pd-badge" data-result="attention">
            {storeLabel(store)} blocked
          </span>
        ))}
        <span className="ml-auto">
          <RunButton controls={controls} />
        </span>
      </div>

      {run ? (
        <>
          <div
            role="group"
            aria-label="Supervisor runs, newest first"
            className="flex snap-x gap-2 overflow-x-auto border-b border-[var(--bladevault-line)]/60 px-4 py-3"
          >
            {runs.map((item) => (
              <RunTile
                key={item.id}
                run={item}
                selected={item.id === run.id}
                label={clockTime(item.startedAt, hourCycle, now)}
                onSelect={() => setSelectedRun(item.id)}
              />
            ))}
          </div>
          <div className="grid items-start lg:grid-cols-[minmax(0,1fr)_minmax(260px,320px)]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3 px-3 pt-3 pb-1">
                <h3 className="text-sm font-semibold">
                  Run at {clockTime(run.startedAt, hourCycle, now)}
                </h3>
                {run.ok ? (
                  <div
                    role="tablist"
                    aria-label="Filter the run's actions"
                    className="inline-flex gap-0.5 rounded-lg border border-[var(--bladevault-line)] p-0.5"
                  >
                    {filters.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        role="tab"
                        aria-selected={filter === item.value}
                        onClick={() => setFilter(item.value)}
                        className={cn(
                          'rounded-md px-2 py-0.5 text-xs transition-colors',
                          filter === item.value
                            ? 'bg-[var(--bladevault-nav-active-bg)] font-semibold text-[var(--bladevault-nav-active-fg)]'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {item.label}
                        <span className="ml-1 text-[11px] opacity-75 tabular-nums">
                          {item.count}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="overflow-x-auto lg:max-h-[560px] lg:overflow-y-auto">
                {run.ok ? (
                  <RunActions
                    key={run.id}
                    run={run}
                    labels={state.labels}
                    filter={filter}
                    onSelect={onSelect}
                  />
                ) : (
                  <p className="px-3 py-6 text-sm text-destructive">
                    The run failed: {run.error}
                  </p>
                )}
              </div>
            </div>
            <aside
              aria-label="Run summary"
              className="space-y-3 border-t border-[var(--bladevault-line)]/60 p-4 text-sm lg:border-t-0 lg:border-l"
            >
              <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Supervisor summary
              </h4>
              <p>
                {run.ok
                  ? run.summary || 'Nothing needed attention.'
                  : 'No summary: the run failed.'}
              </p>
              {run.coverage ? <CoverageMeter coverage={run.coverage} /> : null}
              <RunEvents key={run.id} run={run} />
              <p className="text-xs text-muted-foreground">
                {run.mode === 'act' ? 'Act' : 'Observe'} · {run.model}
              </p>
            </aside>
          </div>
        </>
      ) : (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          No runs yet. The first one starts within a minute, or select Run now.
        </p>
      )}
      <AgentNotes controls={controls} onSelect={onSelect} />
    </section>
  )
}
