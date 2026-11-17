'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useCare } from '@/components/providers/care-provider'
import {
  CARE_INTERVAL_MAX_DAYS,
  CARE_TRACKS,
  CARE_TRACK_NAMES,
  type CareTrack,
} from '@/lib/settings-shared'

type TrackDraft = { enabled: boolean; days: string }

export function CareIntervalsDialog({
  knifeId,
  open,
  onOpenChange,
}: {
  knifeId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { reminders, overrides, setKnifeCareIntervals } = useCare()
  const override = overrides[knifeId]
  const [drafts, setDrafts] = useState<Record<CareTrack, TrackDraft>>(() => {
    const initial = {} as Record<CareTrack, TrackDraft>
    for (const track of CARE_TRACKS) {
      const value =
        override && track in override
          ? (override[track] ?? null)
          : reminders.intervals[track]
      initial[track] = {
        enabled: value !== null,
        days: String(value ?? reminders.intervals[track] ?? 90),
      }
    }
    return initial
  })
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  const setDraft = (track: CareTrack, patch: Partial<TrackDraft>) =>
    setDrafts((current) => ({
      ...current,
      [track]: { ...current[track], ...patch },
    }))

  const save = async (tracks: Parameters<typeof setKnifeCareIntervals>[1]) => {
    setIsSaving(true)
    setError(null)
    try {
      await setKnifeCareIntervals(knifeId, tracks)
      onOpenChange(false)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to save care intervals',
      )
    } finally {
      setIsSaving(false)
    }
  }

  const handleSave = () => {
    const tracks: Partial<Record<CareTrack, number | null>> = {}
    for (const track of CARE_TRACKS) {
      const draft = drafts[track]
      let value: number | null = null
      if (draft.enabled) {
        const days = Number(draft.days)
        if (
          !Number.isFinite(days) ||
          days < 1 ||
          days > CARE_INTERVAL_MAX_DAYS
        ) {
          setError(
            `${CARE_TRACK_NAMES[track]}: enter between 1 and ${CARE_INTERVAL_MAX_DAYS} days.`,
          )
          return
        }
        value = Math.round(days)
      }
      // Keep only what differs from the global defaults.
      if (value !== reminders.intervals[track]) tracks[track] = value
    }
    void save(Object.keys(tracks).length > 0 ? tracks : null)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Care intervals for this knife</DialogTitle>
          <DialogDescription>
            Override the default reminder intervals. Unchecked tracks are not
            reminded for this knife.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {CARE_TRACKS.map((track) => {
            const draft = drafts[track]
            const defaultDays = reminders.intervals[track]
            return (
              <div key={track} className="flex items-center gap-3">
                <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.enabled}
                    onCheckedChange={(checked) =>
                      setDraft(track, { enabled: checked === true })
                    }
                  />
                  <span className="truncate">
                    {CARE_TRACK_NAMES[track]}
                    <span className="ml-1 text-xs text-muted-foreground">
                      {defaultDays === null
                        ? '(default: off)'
                        : `(default: ${defaultDays}d)`}
                    </span>
                  </span>
                </label>
                <div className="flex items-center gap-1.5">
                  <Input
                    type="number"
                    min={1}
                    max={CARE_INTERVAL_MAX_DAYS}
                    value={draft.days}
                    disabled={!draft.enabled}
                    onChange={(event) =>
                      setDraft(track, { days: event.target.value })
                    }
                    className="h-8 w-20 text-right"
                    aria-label={`${CARE_TRACK_NAMES[track]} interval in days`}
                  />
                  <span className="text-xs text-muted-foreground">days</span>
                </div>
              </div>
            )
          })}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isSaving || !override}
            onClick={() => void save(null)}
          >
            Use defaults
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isSaving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isSaving}
              onClick={handleSave}
            >
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
