'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from '@/components/settings-panels'
import {
  CARE_INTERVAL_MAX_DAYS,
  CARE_TRACKS,
  CARE_TRACK_NAMES,
  DEFAULT_MAINTENANCE_REMINDERS,
  type CareTrack,
  type MaintenanceReminderSettings,
} from '@/lib/settings-shared'

/** A day count that saves on blur or Enter and reverts invalid input. */
function DaysInput({
  value,
  min,
  max,
  disabled,
  onCommit,
  'aria-label': ariaLabel,
}: {
  value: number
  min: number
  max: number
  disabled?: boolean
  onCommit: (value: number) => void
  'aria-label': string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const parsed = Number(draft)
    setDraft(null)
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) return
    const rounded = Math.round(parsed)
    if (rounded !== value) onCommit(rounded)
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <Input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
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
      <span className="text-xs text-muted-foreground">days</span>
    </span>
  )
}

export function MaintenanceSettings({
  reminders,
  overrideCount,
  disabled,
  onChange,
  onResetOverrides,
}: {
  reminders: MaintenanceReminderSettings
  overrideCount: number
  disabled?: boolean
  onChange: (next: MaintenanceReminderSettings) => void
  onResetOverrides: () => void
}) {
  const update = (patch: Partial<MaintenanceReminderSettings>) =>
    onChange({ ...reminders, ...patch })
  const setTrackInterval = (track: CareTrack, days: number | null) =>
    update({ intervals: { ...reminders.intervals, [track]: days } })
  const isOff = !reminders.enabled || disabled

  return (
    <div className="settings-grid">
      <SettingsSection title="Care reminders">
        <SettingsRow
          inline
          label="Show care reminders"
          description="Due badges on cards, the Care filter in the collection, and the Care status card on Insights. Everything is worked out from your maintenance log."
        >
          <SettingsSwitch
            aria-label="Show care reminders"
            checked={reminders.enabled}
            disabled={disabled}
            onCheckedChange={(checked) => update({ enabled: checked })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Default intervals"
        description="How often each kind of care is due. A knife's own intervals, set from its Maintenance section, take priority."
      >
        {CARE_TRACKS.map((track) => {
          const days = reminders.intervals[track]
          const fallback = DEFAULT_MAINTENANCE_REMINDERS.intervals[track] ?? 90
          return (
            <SettingsRow
              key={track}
              label={CARE_TRACK_NAMES[track]}
              description={
                track === 'sharpening' && reminders.stroppingCountsAsSharpening
                  ? 'Stropping also resets this timer.'
                  : days === null
                    ? 'No reminders for this kind of care.'
                    : undefined
              }
            >
              <SettingsSwitch
                aria-label={`Remind about ${CARE_TRACK_NAMES[track].toLowerCase()}`}
                checked={days !== null}
                disabled={isOff}
                onCheckedChange={(checked) =>
                  setTrackInterval(track, checked ? fallback : null)
                }
              />
              <DaysInput
                aria-label={`${CARE_TRACK_NAMES[track]} interval in days`}
                value={days ?? fallback}
                min={1}
                max={CARE_INTERVAL_MAX_DAYS}
                disabled={isOff || days === null}
                onCommit={(value) => setTrackInterval(track, value)}
              />
            </SettingsRow>
          )
        })}
      </SettingsSection>

      <SettingsSection title="How due dates are counted">
        <SettingsRow
          label="“Due soon” window"
          description="How many days before the deadline a knife is flagged as due soon."
        >
          <DaysInput
            aria-label="Due soon window in days"
            value={reminders.dueSoonDays}
            min={0}
            max={365}
            disabled={isOff}
            onCommit={(value) => update({ dueSoonDays: value })}
          />
        </SettingsRow>
        <SettingsRow
          inline
          label="Stropping counts as edge care"
          description="A stropping entry resets the sharpening timer."
        >
          <SettingsSwitch
            aria-label="Stropping counts as edge care"
            checked={reminders.stroppingCountsAsSharpening}
            disabled={isOff}
            onCheckedChange={(checked) =>
              update({ stroppingCountsAsSharpening: checked })
            }
          />
        </SettingsRow>
        <SettingsRow
          inline
          label="Skip sold knives"
          description="Sold knives get no reminders and are left out of the counts."
        >
          <SettingsSwitch
            aria-label="Skip sold knives"
            checked={reminders.skipSoldKnives}
            disabled={isOff}
            onCheckedChange={(checked) => update({ skipSoldKnives: checked })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Per-knife intervals">
        <SettingsRow
          label={
            overrideCount === 0
              ? 'Every knife uses the default intervals'
              : `${overrideCount} ${overrideCount === 1 ? 'knife uses' : 'knives use'} custom intervals`
          }
          description="Set a knife's own intervals from Customize… in its Maintenance section."
        >
          {overrideCount > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={onResetOverrides}
            >
              Reset all to defaults
            </Button>
          ) : null}
        </SettingsRow>
      </SettingsSection>
    </div>
  )
}
