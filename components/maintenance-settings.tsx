'use client'

import { useState } from 'react'
import Link from 'next/link'
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
export function DaysInput({
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
      {!reminders.enabled ? (
        <p className="text-sm text-muted-foreground">
          Care reminders are off. Turn them on in{' '}
          <Link
            href="/settings?tab=notifications"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Settings → Notifications
          </Link>
          .
        </p>
      ) : null}

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
