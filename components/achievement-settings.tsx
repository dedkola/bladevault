'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from '@/components/settings-panels'
import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'
import {
  ACHIEVEMENTS_REFRESH_EVENT,
  type AchievementState,
} from '@/lib/achievements/unlocks'
import { hasServerRuntime } from '@/lib/runtime-capabilities'
import type { AchievementSettings as AchievementSettingsValue } from '@/lib/settings-shared'

type Summary = AchievementState['summary']

async function requestAchievements(init?: RequestInit): Promise<Summary> {
  const response = await fetch('/api/achievements', {
    cache: 'no-store',
    ...init,
  })
  const data = await readJsonResponse<
    Partial<AchievementState> & { error?: string }
  >(response)
  if (!response.ok || !data.summary) {
    throw new Error(getApiErrorMessage(data, 'Could not load achievements.'))
  }
  return data.summary
}

export function AchievementSettings({
  settings,
  disabled,
  onChange,
}: {
  settings: AchievementSettingsValue
  disabled?: boolean
  onChange: (next: AchievementSettingsValue) => void
}) {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [error, setError] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetting, setResetting] = useState(false)

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await requestAchievements())
      setError('')
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Could not load achievements.',
      )
    }
  }, [])

  useEffect(() => {
    // Loading on mount (and after the switch changes) is the effect's job.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSummary()
  }, [loadSummary, settings.enabled])

  const update = (patch: Partial<AchievementSettingsValue>) =>
    onChange({ ...settings, ...patch })

  const reset = async () => {
    setResetting(true)
    try {
      await requestAchievements({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset' }),
      })
      // Re-record what the vault already meets, quietly (a fresh baseline).
      setSummary(await requestAchievements({ method: 'POST' }))
      window.dispatchEvent(new Event(ACHIEVEMENTS_REFRESH_EVENT))
      setError('')
      setConfirmReset(false)
    } catch (resetError) {
      setError(
        resetError instanceof Error
          ? resetError.message
          : 'Could not reset achievements.',
      )
    } finally {
      setResetting(false)
    }
  }

  const subDisabled = disabled || !settings.enabled
  // The browser version keeps no Inbox system messages and forgets the
  // session when the tab closes.
  const browserOnly = !hasServerRuntime()

  return (
    <div className="settings-grid">
      <SettingsSection
        description={
          browserOnly
            ? 'Badges for collection milestones, care habits and lucky finds, with a trophy case on Insights. In this browser version they last until you close the tab.'
            : 'Badges for collection milestones, care habits and lucky finds, with a trophy case on Insights.'
        }
      >
        <SettingsRow
          inline
          label="Enable achievements"
          description={
            summary
              ? `${summary.unlockedCount} of ${summary.total} unlocked · ${summary.score.toLocaleString('en-US')} points · ${summary.rank.title}`
              : 'Track badges and show the trophy case on Insights.'
          }
        >
          <SettingsSwitch
            aria-label="Enable achievements"
            checked={settings.enabled}
            disabled={disabled}
            onCheckedChange={(enabled) => update({ enabled })}
          />
        </SettingsRow>
        <SettingsRow
          inline
          label="Celebrate on screen"
          description="Show a message when you unlock one, with confetti for Gold and Platinum."
        >
          <SettingsSwitch
            aria-label="Celebrate achievements on screen"
            checked={settings.celebrate}
            disabled={subDisabled}
            onCheckedChange={(celebrate) => update({ celebrate })}
          />
        </SettingsRow>
        {!browserOnly && (
          <SettingsRow
            inline
            label="Inbox messages"
            description="Keep a note of each unlock in the Inbox."
          >
            <SettingsSwitch
              aria-label="Achievement Inbox messages"
              checked={settings.inbox}
              disabled={subDisabled}
              onCheckedChange={(inbox) => update({ inbox })}
            />
          </SettingsRow>
        )}
        <SettingsRow
          inline
          label="Show secret achievements"
          description="List them as “???” until unlocked, instead of hiding them."
        >
          <SettingsSwitch
            aria-label="Show secret achievements"
            checked={settings.showSecret}
            disabled={subDisabled}
            onCheckedChange={(showSecret) => update({ showSecret })}
          />
        </SettingsRow>
        <SettingsRow
          inline
          label="Reset achievements"
          description="Clears every unlock. Your knives and history are untouched; badges you already meet come back quietly."
        >
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || !summary?.unlockedCount}
            onClick={() => setConfirmReset(true)}
          >
            Reset…
          </Button>
        </SettingsRow>
        {error && (
          <p role="alert" className="py-2 text-sm text-destructive">
            {error}
          </p>
        )}
      </SettingsSection>

      <Dialog
        open={confirmReset}
        onOpenChange={(open) => {
          if (!open && !resetting) setConfirmReset(false)
        }}
      >
        <DialogContent
          showCloseButton={!resetting}
          initialFocus={() =>
            document.getElementById('cancel-achievement-reset')
          }
        >
          <DialogHeader>
            <DialogTitle>Reset achievements?</DialogTitle>
            <DialogDescription>
              This clears all {summary?.unlockedCount ?? 0} unlocks and their
              dates. It cannot be undone. Badges your vault still meets are
              unlocked again quietly, without celebrations.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              id="cancel-achievement-reset"
              variant="outline"
              disabled={resetting}
              onClick={() => setConfirmReset(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={resetting}
              onClick={() => void reset()}
            >
              {resetting ? 'Resetting…' : 'Reset achievements'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
