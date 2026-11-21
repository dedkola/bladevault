'use client'

import {
  Fragment,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { Cookie, Loader2, Pause, Play, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import {
  PRICE_MONITORING_LIMITS,
  type ActiveHours,
  type PriceMonitoringSettings,
  type PriceNotifyCategories,
  type PriceScheduleMode,
} from '@/lib/settings-shared'

const SCHEDULE_OPTIONS: ReadonlyArray<{
  value: PriceScheduleMode
  label: string
}> = [
  { value: 'daily', label: 'Once daily' },
  { value: 'twice_daily', label: 'Twice daily' },
  { value: 'every_12h', label: 'Every 12 hours' },
  { value: 'custom', label: 'Custom' },
]

const SCHEDULE_HELP: Record<PriceScheduleMode, string> = {
  daily: 'Each product is checked about once a day.',
  twice_daily: 'Each product is checked about twice a day, in daytime hours.',
  every_12h: 'Each product is checked every 12 hours, around the clock.',
  custom: 'Each product is checked at the interval you choose.',
}

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
  fullPassMs: number
  checking: boolean
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
function NumberField({
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

function HourSelect({
  value,
  hours,
  disabled,
  hourCycle,
  onChange,
  'aria-label': ariaLabel,
}: {
  value: number
  hours: number[]
  disabled?: boolean
  hourCycle: HourCycle
  onChange: (hour: number) => void
  'aria-label': string
}) {
  const label = (hour: number) => hourLabel(hour, hourCycle)
  return (
    <Select
      value={String(value)}
      onValueChange={(next) => onChange(Number(next))}
      disabled={disabled}
    >
      <SelectTrigger size="sm" aria-label={ariaLabel} className="w-28">
        <SelectValue>{label(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {hours.map((hour) => (
          <SelectItem key={hour} value={String(hour)}>
            {label(hour)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

const NOTIFY_OPTIONS: ReadonlyArray<{
  key: keyof PriceNotifyCategories
  label: string
  description: string
}> = [
  {
    key: 'drop',
    label: 'Price drops',
    description: 'A store lowered the price.',
  },
  {
    key: 'increase',
    label: 'Price increases',
    description: 'A store raised the price.',
  },
  {
    key: 'outOfStock',
    label: 'Out of stock',
    description: 'No store you monitor has the knife in stock any more.',
  },
  {
    key: 'backInStock',
    label: 'Back in stock',
    description: 'A store has the knife again after every store was out.',
  },
]

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

const START_HOURS = Array.from({ length: 24 }, (_, hour) => hour)
const END_HOURS = Array.from({ length: 24 }, (_, hour) => hour + 1)

type StoreAction = 'resume' | 'reset_cookies' | 'check' | 'pause' | 'unpause'

const storeName = (laneKey: string) =>
  laneKey === 'amazon' ? 'Amazon' : laneKey

/** Asks first where an action can backfire; null means go ahead. */
function confirmText(action: StoreAction, laneKey: string): string | null {
  const name = storeName(laneKey)
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
 * Settings → Price monitoring: schedule, active hours and per-store pacing,
 * plus a live view of each store's pace and pauses.
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
      setStoreNotice(DONE_TEXT[action](storeName(laneKey), data.queued))
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
  const updateNotify = (patch: Partial<PriceNotifyCategories>) =>
    update({ notify: { ...settings.notify, ...patch } })
  const updateThresholds = (
    patch: Partial<PriceMonitoringSettings['thresholds']>,
  ) => update({ thresholds: { ...settings.thresholds, ...patch } })
  // The minimum amount only filters notifications, unlike the percent.
  const priceAlertsOn = settings.notify.drop || settings.notify.increase

  const off = disabled || !settings.enabled
  const hours: ActiveHours | null =
    settings.schedule.activeHours ??
    (settings.schedule.mode === 'twice_daily' ? [8, 22] : null)
  const setHours = (next: ActiveHours) => {
    if (next[0] === next[1] % 24) return
    updateSchedule({ activeHours: next })
  }

  return (
    <div className="settings-grid">
      <SettingsSection title="Price monitoring">
        <SettingsRow
          inline
          label="Check prices automatically"
          description="Knives with a stored regular price are checked in the background, store by store and never two at once at the same store. Check now works either way."
        >
          <SettingsSwitch
            aria-label="Check prices automatically"
            checked={settings.enabled}
            disabled={disabled}
            onCheckedChange={(checked) => update({ enabled: checked })}
          />
        </SettingsRow>
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
          label="Ignore out of stock on the official site"
          description="When a knife’s own product link is sold out, it no longer counts as out of stock, does not notify, and is not checked on schedule until Check now finds it in stock again. Use Other stores below to follow the knife on Amazon or Blade HQ instead."
        >
          <SettingsSwitch
            aria-label="Ignore out of stock on the official site"
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
        description="Checks are spread evenly over the day instead of all at once, so stores are not flooded with requests."
      >
        <SettingsRow
          label="How often"
          description={SCHEDULE_HELP[settings.schedule.mode]}
        >
          <SegmentedControl
            aria-label="How often to check prices"
            value={settings.schedule.mode}
            options={SCHEDULE_OPTIONS}
            disabled={off}
            onValueChange={(mode) => updateSchedule({ mode })}
          />
        </SettingsRow>
        {settings.schedule.mode === 'custom' ? (
          <SettingsRow label="Interval">
            <NumberField
              aria-label="Check interval in hours"
              value={settings.schedule.intervalHours}
              min={PRICE_MONITORING_LIMITS.intervalHours[0]}
              max={PRICE_MONITORING_LIMITS.intervalHours[1]}
              unit="hours"
              disabled={off}
              onCommit={(intervalHours) => updateSchedule({ intervalHours })}
            />
          </SettingsRow>
        ) : null}
        {settings.schedule.mode !== 'every_12h' ? (
          <SettingsRow
            label="Only check between"
            description={
              queue?.timeZone
                ? `Server time (${queue.timeZone}).`
                : 'Server time.'
            }
          >
            {settings.schedule.mode !== 'twice_daily' ? (
              <SettingsSwitch
                aria-label="Only check during set hours"
                checked={hours !== null}
                disabled={off}
                onCheckedChange={(checked) =>
                  updateSchedule({ activeHours: checked ? [8, 22] : null })
                }
              />
            ) : null}
            {hours ? (
              <>
                <HourSelect
                  aria-label="Start hour"
                  value={hours[0]}
                  hours={START_HOURS}
                  disabled={off}
                  hourCycle={hourCycle}
                  onChange={(start) => setHours([start, hours[1]])}
                />
                <span className="text-xs text-muted-foreground">to</span>
                <HourSelect
                  aria-label="End hour"
                  value={hours[1]}
                  hours={END_HOURS}
                  disabled={off}
                  hourCycle={hourCycle}
                  onChange={(end) => setHours([hours[0], end])}
                />
              </>
            ) : null}
          </SettingsRow>
        ) : null}
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

      <SettingsSection
        title="Pacing"
        description="BladeVault slows a store down by itself when it answers slowly, rate-limits or shows a bot check, and speeds up again after successful checks. These are the limits."
      >
        <SettingsRow
          label="Minimum pause per store"
          description="The shortest time between two checks at the same store."
        >
          <NumberField
            aria-label="Minimum pause per store in seconds"
            value={settings.pacing.minGapSeconds}
            min={PRICE_MONITORING_LIMITS.minGapSeconds[0]}
            max={PRICE_MONITORING_LIMITS.minGapSeconds[1]}
            unit="seconds"
            disabled={off}
            onCommit={(minGapSeconds) => updatePacing({ minGapSeconds })}
          />
        </SettingsRow>
        <SettingsRow
          label="Minimum pause for Amazon"
          description="All Amazon marketplaces share this pace."
        >
          <NumberField
            aria-label="Minimum pause for Amazon in seconds"
            value={settings.pacing.amazonMinGapSeconds}
            min={PRICE_MONITORING_LIMITS.amazonMinGapSeconds[0]}
            max={PRICE_MONITORING_LIMITS.amazonMinGapSeconds[1]}
            unit="seconds"
            disabled={off}
            onCommit={(amazonMinGapSeconds) =>
              updatePacing({ amazonMinGapSeconds })
            }
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Notifications"
        description="Changes found by a check show up in the Inbox under Prices. Repeats for the same store update one notification instead of adding more."
      >
        {NOTIFY_OPTIONS.map((option) => (
          <SettingsRow
            key={option.key}
            inline
            label={option.label}
            description={option.description}
          >
            <SettingsSwitch
              aria-label={`Notify about ${option.label.toLowerCase()}`}
              checked={settings.notify[option.key]}
              disabled={disabled}
              onCheckedChange={(checked) =>
                updateNotify({ [option.key]: checked })
              }
            />
          </SettingsRow>
        ))}
        <SettingsRow
          label="Minimum change"
          description="Price changes smaller than this don't notify and show as No change on Price Drops, with the small move as a hint. Set it to 0 to count every price change. Stock changes always notify."
        >
          <NumberField
            aria-label="Minimum price change in percent"
            value={settings.thresholds.minPercent}
            min={PRICE_MONITORING_LIMITS.minPercent[0]}
            max={PRICE_MONITORING_LIMITS.minPercent[1]}
            decimals={1}
            unit="%"
            disabled={disabled}
            onCommit={(minPercent) => updateThresholds({ minPercent })}
          />
        </SettingsRow>
        <SettingsRow
          label="Minimum amount"
          description="Price notifications also skip changes smaller than this, in each price's own currency (3 means $3, €3 or ₴3). A change must pass both the percent and the amount. 0 turns it off."
        >
          <NumberField
            aria-label="Minimum price change in the price's currency"
            value={settings.thresholds.minAmount}
            min={PRICE_MONITORING_LIMITS.minAmount[0]}
            max={PRICE_MONITORING_LIMITS.minAmount[1]}
            decimals={2}
            unit="in its currency"
            disabled={disabled || !priceAlertsOn}
            onCommit={(minAmount) => updateThresholds({ minAmount })}
          />
        </SettingsRow>
        <SettingsRow
          inline
          label="Always notify about a new lowest price"
          description="A drop to the lowest price a store has shown for a knife notifies even below the minimum percent. Needs Price drops on; the minimum amount still applies."
        >
          <SettingsSwitch
            aria-label="Always notify about a new lowest price"
            checked={settings.thresholds.allTimeLow}
            disabled={disabled || !settings.notify.drop}
            onCheckedChange={(allTimeLow) => updateThresholds({ allTimeLow })}
          />
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
          description="Each store's current pace. A full pass is how long it takes to check every product at that store once. Use the buttons to check a store now, pause it, or reset its saved cookies."
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
                  <th className="py-1.5 pr-3 font-medium">One check every</th>
                  <th className="py-1.5 pr-3 font-medium">Full pass</th>
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
                        {storeName(lane.laneKey)}
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
                        {lane.sources && !lane.paused
                          ? `${formatDuration(lane.fullPassMs)}${
                              lane.fullPassMs > queue.frequencyMs
                                ? ' (longer than the schedule)'
                                : ''
                            }`
                          : '—'}
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
                          label={`Check ${storeName(lane.laneKey)} now`}
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
                              ? `Resume scheduled checks at ${storeName(lane.laneKey)}`
                              : `Pause scheduled checks at ${storeName(lane.laneKey)}`
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
                          label={`Reset saved cookies for ${storeName(lane.laneKey)}`}
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
