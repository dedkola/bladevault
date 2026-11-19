'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
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

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })
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
  onChange,
  'aria-label': ariaLabel,
}: {
  value: number
  hours: number[]
  disabled?: boolean
  onChange: (hour: number) => void
  'aria-label': string
}) {
  const label = (hour: number) => `${String(hour % 24).padStart(2, '0')}:00`
  return (
    <Select
      value={String(value)}
      onValueChange={(next) => onChange(Number(next))}
      disabled={disabled}
    >
      <SelectTrigger size="sm" aria-label={ariaLabel} className="w-24">
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
    description: 'A store stopped selling the knife for now.',
  },
  {
    key: 'backInStock',
    label: 'Back in stock',
    description: 'A store has the knife available again.',
  },
]

const START_HOURS = Array.from({ length: 24 }, (_, hour) => hour)
const END_HOURS = Array.from({ length: 24 }, (_, hour) => hour + 1)

function laneStatus(lane: LaneView): string {
  if (lane.checking) return 'Checking'
  if (lane.circuit === 'open' && lane.cooldownUntil)
    return `Paused until ${formatTime(lane.cooldownUntil)} (blocked)`
  if (lane.manual) return `${lane.manual} waiting for Check now`
  const pause = lane.advice?.pauseUntil
  if (pause && Date.parse(pause) > Date.now())
    return `Paused by AI until ${formatTime(pause)}`
  return 'Ready'
}

const hour = (value: number) => `${String(value % 24).padStart(2, '0')}:00`

/**
 * "AI: at most one check every 20 min, quiet 18:00–23:00 — reason". A pause
 * shows in the status column.
 */
function adviceSummary(advice: AdvisorLaneAdvice): string {
  const parts: string[] = []
  if (advice.minGapMs)
    parts.push(`at most one check every ${formatDuration(advice.minGapMs)}`)
  if (advice.pauseUntil && Date.parse(advice.pauseUntil) > Date.now())
    parts.push('paused')
  if (advice.quietHours)
    parts.push(
      `quiet ${hour(advice.quietHours[0])}–${hour(advice.quietHours[1])}`,
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
          description="Knives with a stored purchase price are checked in the background, store by store and never two at once at the same store. Check now works either way."
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
                  onChange={(start) => setHours([start, hours[1]])}
                />
                <span className="text-xs text-muted-foreground">to</span>
                <HourSelect
                  aria-label="End hour"
                  value={hours[1]}
                  hours={END_HOURS}
                  disabled={off}
                  onChange={(end) => setHours([hours[0], end])}
                />
              </>
            ) : null}
          </SettingsRow>
        ) : null}
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
          description="Price changes smaller than this don't notify. Set it to 0 to be notified about every price change. Stock changes always notify."
        >
          <NumberField
            aria-label="Minimum price change in percent"
            value={settings.thresholds.minPercent}
            min={PRICE_MONITORING_LIMITS.minPercent[0]}
            max={PRICE_MONITORING_LIMITS.minPercent[1]}
            decimals={1}
            unit="%"
            disabled={disabled || !priceAlertsOn}
            onCommit={(minPercent) => updateThresholds({ minPercent })}
          />
        </SettingsRow>
        <SettingsRow
          label="Minimum amount"
          description="Also ignore price changes smaller than this, in each price's own currency (3 means $3, €3 or ₴3). A change must pass both the percent and the amount. 0 turns it off."
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
          description="Each store's current pace. A full pass is how long it takes to check every product at that store once."
        >
          <div className="overflow-x-auto py-2">
            <table className="w-full text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">Store</th>
                  <th className="py-1.5 pr-3 font-medium">Products</th>
                  <th className="py-1.5 pr-3 font-medium">One check every</th>
                  <th className="py-1.5 pr-3 font-medium">Full pass</th>
                  <th className="py-1.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {queue.lanes.map((lane) => (
                  <Fragment key={lane.laneKey}>
                    <tr className="border-t border-[var(--bladevault-line)]">
                      <td className="py-1.5 pr-3 font-medium text-foreground">
                        {lane.laneKey === 'amazon' ? 'Amazon' : lane.laneKey}
                        {lane.strategy === 'http_first' ? (
                          <span className="ml-1.5 text-muted-foreground">
                            · fast HTTP
                          </span>
                        ) : null}
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums">
                        {lane.sources}
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums">
                        {formatDuration(lane.gapMs)}
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums">
                        {lane.sources
                          ? `${formatDuration(lane.fullPassMs)}${
                              lane.fullPassMs > queue.frequencyMs
                                ? ' (longer than the schedule)'
                                : ''
                            }`
                          : '—'}
                      </td>
                      <td className="py-1.5">{laneStatus(lane)}</td>
                    </tr>
                    {lane.advice ? (
                      <tr>
                        <td
                          colSpan={5}
                          className="pb-1.5 text-muted-foreground"
                        >
                          {adviceSummary(lane.advice)}
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
