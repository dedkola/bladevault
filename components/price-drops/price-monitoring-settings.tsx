'use client'

import {
  Fragment,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import Link from 'next/link'
import { Cookie, Loader2, Pause, Play, RefreshCw } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  PriceAiSettingsSection,
  type AdvisorLaneAdvice,
} from '@/components/price-drops/price-ai-settings'
import {
  SegmentedControl,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from '@/components/settings-panels'
import { hasServerRuntime } from '@/lib/runtime-capabilities'
import { useKnives } from '@/components/providers/knives-provider'
import { getHourCycle } from '@/lib/time-format'
import { clockTime, hourLabel } from '@/components/price-drops/price-format'
import { OtherStoresSettings } from '@/components/price-drops/other-stores-settings'
import { DesktopBackgroundSettings } from '@/components/price-drops/desktop-background-settings'
import { MonitorScopeSettings } from '@/components/price-drops/monitor-scope-settings'
import {
  PRICE_MONITORING_LIMITS,
  PRICE_ROUND_HOURS,
  type PriceMonitoringSettings,
  type PriceRoundHours,
} from '@/lib/settings-shared'

const ROUND_LABEL: Record<PriceRoundHours, string> = {
  6: 'Every 6 hours',
  12: 'Every 12 hours',
  24: 'Once a day',
}

const ROUND_OPTIONS = PRICE_ROUND_HOURS.map((hours) => ({
  value: String(hours) as `${PriceRoundHours}`,
  label: ROUND_LABEL[hours],
}))

type LaneView = {
  laneKey: string
  sources: number
  /** Pages out of stock for two weeks, checked once a day. */
  slowed: number
  /** Scheduled checks paused by the user. */
  paused: boolean
  manual: number
  gapMs: number
  circuit: 'closed' | 'open'
  cooldownUntil: string | null
  strategy: 'auto' | 'http_first' | 'browser_first'
  checking: boolean
  /** On the retry list at this store. */
  retries?: number
  advice?: AdvisorLaneAdvice | null
}

type QueueSnapshot = {
  running: boolean
  scheduled: boolean
  timeZone: string
  frequencyMs: number
  lanes: LaneView[]
}

const QUEUE_POLL_MS = 10_000

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))} s`
  if (minutes < 90) return `${minutes} min`
  const hours = ms / 3_600_000
  if (hours < 48) return `${Math.round(hours * 10) / 10} h`
  return `${Math.round((hours / 24) * 10) / 10} days`
}

/**
 * A number that saves on blur or Enter and reverts invalid input. Rounded to
 * `decimals` places (whole numbers by default).
 */
export function NumberField({
  value,
  min,
  max,
  unit,
  decimals = 0,
  disabled,
  onCommit,
  'aria-label': ariaLabel,
}: {
  value: number
  min: number
  max: number
  unit: string
  decimals?: number
  disabled?: boolean
  onCommit: (value: number) => void
  'aria-label': string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const factor = 10 ** decimals
    const trimmed = draft.trim().replace(',', '.')
    const parsed = trimmed
      ? Math.round(Number(trimmed) * factor) / factor
      : Number.NaN
    setDraft(null)
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) return
    if (parsed !== value) onCommit(parsed)
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <Input
        type="number"
        inputMode={decimals ? 'decimal' : 'numeric'}
        min={min}
        max={max}
        step={decimals ? 1 / 10 ** decimals : 1}
        value={draft ?? String(value)}
        disabled={disabled}
        aria-label={ariaLabel}
        className="h-8 w-20 text-right tabular-nums"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
          if (event.key === 'Escape') setDraft(null)
        }}
      />
      <span className="text-xs text-muted-foreground">{unit}</span>
    </span>
  )
}

function StoreButton({
  label,
  busy,
  disabled,
  onClick,
  children,
}: {
  label: string
  busy: boolean
  disabled: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {busy ? <Loader2 className="animate-spin" /> : children}
    </Button>
  )
}

type StoreAction = 'resume' | 'reset_cookies' | 'check' | 'pause' | 'unpause'

/** Asks first where an action can backfire; null means go ahead. */
function confirmText(action: StoreAction, name: string): string | null {
  if (action === 'resume')
    return `Resume checks at ${name} now? It was paused after a bot check or errors and may block again; if it does, it pauses for longer next time.`
  if (action === 'reset_cookies')
    return `Forget the cookies saved for ${name}? A bot check you solved there may have to be solved again.`
  return null
}

const DONE_TEXT: Record<
  StoreAction,
  (name: string, queued?: number) => string
> = {
  resume: (name) => `${name} resumed. Its next check can start now.`,
  reset_cookies: (name) => `Saved cookies for ${name} were reset.`,
  check: (name, queued) =>
    queued
      ? `${queued} ${queued === 1 ? 'product' : 'products'} at ${name} queued. They run at the store's minimum pause.`
      : `Nothing to check at ${name}.`,
  pause: (name) => `${name} paused. Check now on a knife still works there.`,
  unpause: (name) => `${name} resumed on its normal schedule.`,
}

type HourCycle = 'h12' | 'h23'

function laneStatus(lane: LaneView, hourCycle: HourCycle): string {
  if (lane.checking) return 'Checking'
  if (lane.paused) return 'Paused by you'
  if (lane.circuit === 'open' && lane.cooldownUntil)
    return `Paused until ${clockTime(lane.cooldownUntil, hourCycle)} (blocked)`
  if (lane.manual) return `${lane.manual} waiting for Check now`
  const pause = lane.advice?.pauseUntil
  if (pause && Date.parse(pause) > Date.now())
    return `Paused by AI until ${clockTime(pause, hourCycle)}`
  return 'Ready'
}

/**
 * "AI: at most one check every 20 min, quiet 18:00–23:00 — reason". A pause
 * shows in the status column.
 */
function adviceSummary(
  advice: AdvisorLaneAdvice,
  hourCycle: HourCycle,
): string {
  const parts: string[] = []
  if (advice.minGapMs)
    parts.push(`at most one check every ${formatDuration(advice.minGapMs)}`)
  if (advice.pauseUntil && Date.parse(advice.pauseUntil) > Date.now())
    parts.push('paused')
  if (advice.quietHours)
    parts.push(
      `quiet ${hourLabel(advice.quietHours[0], hourCycle)}–${hourLabel(advice.quietHours[1], hourCycle)}`,
    )
  if (!parts.length) parts.push('checks in the browser only')
  return `AI: ${parts.join(', ')}${advice.reason ? ` — “${advice.reason}”` : ''}`
}

/**
 * Settings → Price monitoring: how long a check cycle lasts, the gap
 * between two requests at one store, plus a live view of each store's
 * pace, pauses and retry list.
 */
export function PriceMonitoringSettings({
  settings,
  disabled,
  onChange,
}: {
  settings: PriceMonitoringSettings
  disabled?: boolean
  onChange: (next: PriceMonitoringSettings) => void
}) {
  const hourCycle = getHourCycle(useKnives().timeFormat)
  const [queue, setQueue] = useState<QueueSnapshot | null>(null)
  const [queueAvailable, setQueueAvailable] = useState(true)
  // The static web app has no server: no AI settings there.
  const [serverRuntime] = useState(hasServerRuntime)

  const loadQueue = useCallback(async () => {
    try {
      const response = await fetch('/api/prices/queue', {
        cache: 'no-store',
      })
      if (response.status === 501) {
        setQueueAvailable(false)
        return
      }
      if (!response.ok) return
      const data = (await response.json()) as { queue: QueueSnapshot }
      setQueue(data.queue)
    } catch {
      // The status table is optional; settings still work.
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = () => {
      if (!cancelled) void loadQueue()
    }
    load()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, QUEUE_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [loadQueue])

  const [storeBusy, setStoreBusy] = useState<string | null>(null)
  const [storeNotice, setStoreNotice] = useState<string | null>(null)
  const runStoreAction = async (laneKey: string, action: StoreAction) => {
    const question = confirmText(action, laneKey)
    if (question && !window.confirm(question)) return
    setStoreBusy(`${laneKey}:${action}`)
    setStoreNotice(null)
    try {
      const response = await fetch('/api/prices/stores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ laneKey, action }),
      })
      const data = (await response.json().catch(() => ({}))) as {
        queued?: number
        error?: string
      }
      if (!response.ok)
        throw new Error(data.error ?? 'The store action did not work.')
      setStoreNotice(DONE_TEXT[action](laneKey, data.queued))
      await loadQueue()
    } catch (error) {
      setStoreNotice(
        error instanceof Error
          ? error.message
          : 'The store action did not work.',
      )
    } finally {
      setStoreBusy(null)
    }
  }

  const update = (patch: Partial<PriceMonitoringSettings>) =>
    onChange({ ...settings, ...patch })
  const updateSchedule = (
    patch: Partial<PriceMonitoringSettings['schedule']>,
  ) => update({ schedule: { ...settings.schedule, ...patch } })
  const updatePacing = (patch: Partial<PriceMonitoringSettings['pacing']>) =>
    update({ pacing: { ...settings.pacing, ...patch } })

  const off = disabled || !settings.enabled

  return (
    <div className="settings-grid">
      <SettingsSection title="Price monitoring">
        <SettingsRow
          inline
          label="Check prices automatically"
          description="Monitored knives are checked in the background, store by store and never two at once at the same store. Check now works either way."
        >
          <SettingsSwitch
            aria-label="Check prices automatically"
            checked={settings.enabled}
            disabled={disabled}
            onCheckedChange={(checked) => update({ enabled: checked })}
          />
        </SettingsRow>
        <MonitorScopeSettings
          scope={settings.scope}
          disabled={disabled}
          onChange={(scope) => update({ scope })}
        />
        {settings.scope.kind !== 'all' ? (
          <SettingsRow
            inline
            label="Check the rest of the collection too"
            description="Knives outside What to monitor are checked once per cycle as well, spread over it after What to monitor, and Other stores looks for them too. Their prices and drops show on Price Drops; set when they notify in Notifications."
          >
            <SettingsSwitch
              aria-label="Check the rest of the collection too"
              checked={settings.collectionPass.enabled}
              disabled={off}
              onCheckedChange={(enabled) =>
                update({
                  collectionPass: { ...settings.collectionPass, enabled },
                })
              }
            />
          </SettingsRow>
        ) : null}
        <SettingsRow
          inline
          label="Skip sold knives"
          description="Sold knives are left out in Auto mode. Always monitor still covers them."
        >
          <SettingsSwitch
            aria-label="Skip sold knives"
            checked={settings.skipSoldKnives}
            disabled={disabled}
            onCheckedChange={(checked) => update({ skipSoldKnives: checked })}
          />
        </SettingsRow>
        <SettingsRow
          inline
          label="Don’t notify when the official site is out of stock"
          description="No out-of-stock alerts for a knife’s own product link. It is still checked in every cycle, shows as out of stock, and a restock still notifies."
        >
          <SettingsSwitch
            aria-label="Don’t notify when the official site is out of stock"
            checked={settings.ignoreOfficialOutOfStock}
            disabled={disabled}
            onCheckedChange={(checked) =>
              update({ ignoreOfficialOutOfStock: checked })
            }
          />
        </SettingsRow>
      </SettingsSection>

      <DesktopBackgroundSettings />

      <SettingsSection
        title="Schedule"
        description="Prices are checked in cycles, around the clock. Every store is checked at the same time as the others, one request at a time: What to monitor first, then links never checked, then the rest of the collection spread evenly over the cycle. A store that asks to wait is tried again 10–15 minutes later; pages without a price wait for AI at the end of the cycle."
      >
        <SettingsRow
          label="Check every link"
          description="Each link is checked once per cycle. Other stores looks for a knife again at most once a day."
        >
          <SegmentedControl
            aria-label="How often every link is checked"
            value={
              String(settings.schedule.intervalHours) as `${PriceRoundHours}`
            }
            options={ROUND_OPTIONS}
            disabled={off}
            onValueChange={(value) =>
              updateSchedule({
                intervalHours: Number(value) as PriceRoundHours,
              })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Gap between requests to one store"
          description="The shortest time between two requests at the same store; different stores are checked at the same time. BladeVault waits longer by itself at a store that answers slowly, rate-limits or shows a bot check."
        >
          <NumberField
            aria-label="Gap between requests to one store in seconds"
            value={settings.pacing.minGapSeconds}
            min={PRICE_MONITORING_LIMITS.minGapSeconds[0]}
            max={PRICE_MONITORING_LIMITS.minGapSeconds[1]}
            unit="seconds"
            disabled={off}
            onCommit={(minGapSeconds) => updatePacing({ minGapSeconds })}
          />
        </SettingsRow>
        <SettingsRow
          inline
          label="Check long out-of-stock pages once a day"
          description="A page that has been out of stock for two weeks is checked at most once a day, so a restock still shows within a day and stores get fewer requests. Check now and Check all still check it right away."
        >
          <SettingsSwitch
            aria-label="Check long out-of-stock pages once a day"
            checked={settings.schedule.slowOutOfStock}
            disabled={off}
            onCheckedChange={(slowOutOfStock) =>
              updateSchedule({ slowOutOfStock })
            }
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Notifications">
        <SettingsRow
          label="Price and stock notifications"
          description="Which changes notify you, the minimum change and the daily AI summary."
        >
          <Link
            href="/settings?tab=notifications"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            Open Notifications
          </Link>
        </SettingsRow>
      </SettingsSection>

      {serverRuntime ? (
        <PriceAiSettingsSection
          settings={settings.ai}
          disabled={disabled}
          onChange={(ai) => update({ ai })}
          onAdviceApplied={() => void loadQueue()}
        />
      ) : null}

      {serverRuntime ? (
        <OtherStoresSettings
          settings={settings.otherStores}
          aiReady={Boolean(
            settings.ai.enabled && settings.ai.baseUrl && settings.ai.model,
          )}
          disabled={disabled}
          onChange={(otherStores) => update({ otherStores })}
        />
      ) : null}

      {queueAvailable && queue && queue.lanes.length ? (
        <SettingsSection
          title="Stores"
          description="Each store's current pace and what waits on the retry list. Use the buttons to check a store now, pause it, or reset its saved cookies."
        >
          {storeNotice ? (
            <p role="status" className="pt-2 text-xs text-muted-foreground">
              {storeNotice}
            </p>
          ) : null}
          <div className="overflow-x-auto py-2">
            <table className="w-full text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">Store</th>
                  <th className="py-1.5 pr-3 font-medium">Products</th>
                  <th className="py-1.5 pr-3 font-medium">Minimum gap</th>
                  <th className="py-1.5 pr-3 font-medium">Retry list</th>
                  <th className="py-1.5 pr-3 font-medium">Status</th>
                  <th className="py-1.5 text-right font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {queue.lanes.map((lane) => (
                  <Fragment key={lane.laneKey}>
                    <tr className="border-t border-[var(--bladevault-line)]">
                      <td className="py-1.5 pr-3 font-medium text-foreground">
                        {lane.laneKey}
                        {lane.strategy === 'http_first' ? (
                          <span className="ml-1.5 text-muted-foreground">
                            · fast HTTP
                          </span>
                        ) : null}
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums">
                        {lane.sources}
                        {lane.slowed ? (
                          <span
                            className="ml-1 text-muted-foreground"
                            title="Out of stock for two weeks or more, so checked once a day"
                          >
                            · {lane.slowed} once a day
                          </span>
                        ) : null}
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums">
                        {lane.paused ? '—' : formatDuration(lane.gapMs)}
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums">
                        {lane.retries ? lane.retries : '—'}
                      </td>
                      <td className="py-1.5 pr-3">
                        {laneStatus(lane, hourCycle)}
                        {lane.circuit === 'open' && !lane.checking ? (
                          <Button
                            type="button"
                            variant="link"
                            size="xs"
                            className="h-auto px-1 py-0"
                            disabled={disabled || storeBusy !== null}
                            onClick={() =>
                              void runStoreAction(lane.laneKey, 'resume')
                            }
                          >
                            Resume now
                          </Button>
                        ) : null}
                      </td>
                      <td className="py-1 text-right whitespace-nowrap">
                        <StoreButton
                          label={`Check ${lane.laneKey} now`}
                          busy={storeBusy === `${lane.laneKey}:check`}
                          disabled={disabled || storeBusy !== null}
                          onClick={() =>
                            void runStoreAction(lane.laneKey, 'check')
                          }
                        >
                          <RefreshCw />
                        </StoreButton>
                        <StoreButton
                          label={
                            lane.paused
                              ? `Resume scheduled checks at ${lane.laneKey}`
                              : `Pause scheduled checks at ${lane.laneKey}`
                          }
                          busy={
                            storeBusy === `${lane.laneKey}:pause` ||
                            storeBusy === `${lane.laneKey}:unpause`
                          }
                          disabled={disabled || storeBusy !== null}
                          onClick={() =>
                            void runStoreAction(
                              lane.laneKey,
                              lane.paused ? 'unpause' : 'pause',
                            )
                          }
                        >
                          {lane.paused ? <Play /> : <Pause />}
                        </StoreButton>
                        <StoreButton
                          label={`Reset saved cookies for ${lane.laneKey}`}
                          busy={storeBusy === `${lane.laneKey}:reset_cookies`}
                          disabled={disabled || storeBusy !== null}
                          onClick={() =>
                            void runStoreAction(lane.laneKey, 'reset_cookies')
                          }
                        >
                          <Cookie />
                        </StoreButton>
                      </td>
                    </tr>
                    {lane.advice ? (
                      <tr>
                        <td
                          colSpan={6}
                          className="pb-1.5 text-muted-foreground"
                        >
                          {adviceSummary(lane.advice, hourCycle)}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </SettingsSection>
      ) : null}
    </div>
  )
}
