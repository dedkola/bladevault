'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from '@/components/settings-panels'
import { NumberField } from '@/components/price-drops/price-monitoring-settings'
import { DesktopNotificationSettings } from '@/components/price-drops/desktop-notification-settings'
import { DaysInput } from '@/components/maintenance-settings'
import { hasServerRuntime } from '@/lib/runtime-capabilities'
import {
  PRICE_MONITORING_LIMITS,
  type AchievementSettings,
  type MaintenanceReminderSettings,
  type PriceMonitoringSettings,
  type PriceNotifyCategories,
} from '@/lib/settings-shared'

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

function SettingsLink({ tab, children }: { tab: string; children: string }) {
  return (
    <Link
      href={`/settings?tab=${tab}`}
      className="underline underline-offset-2 hover:text-foreground"
    >
      {children}
    </Link>
  )
}

/**
 * Settings → Notifications: every alert, reminder and system notification in
 * one place. Each section edits its feature's own settings slice and saves
 * through the same handler as that feature's tab.
 */
export function NotificationSettings({
  priceMonitoring,
  priceDisabled,
  onPriceMonitoringChange,
  reminders,
  remindersDisabled,
  onRemindersChange,
  achievements,
  achievementsDisabled,
  onAchievementsChange,
}: {
  priceMonitoring: PriceMonitoringSettings
  priceDisabled?: boolean
  onPriceMonitoringChange: (next: PriceMonitoringSettings) => void
  reminders: MaintenanceReminderSettings
  remindersDisabled?: boolean
  onRemindersChange: (next: MaintenanceReminderSettings) => void
  achievements: AchievementSettings
  achievementsDisabled?: boolean
  onAchievementsChange: (next: AchievementSettings) => void
}) {
  // The static web app has no server: no AI digest or Inbox system messages.
  const [serverRuntime] = useState(hasServerRuntime)

  const updatePrice = (patch: Partial<PriceMonitoringSettings>) =>
    onPriceMonitoringChange({ ...priceMonitoring, ...patch })
  const updateNotify = (patch: Partial<PriceNotifyCategories>) =>
    updatePrice({ notify: { ...priceMonitoring.notify, ...patch } })
  const updateThresholds = (
    patch: Partial<PriceMonitoringSettings['thresholds']>,
  ) => updatePrice({ thresholds: { ...priceMonitoring.thresholds, ...patch } })
  // The minimum amount only filters notifications, unlike the percent.
  const priceAlertsOn =
    priceMonitoring.notify.drop || priceMonitoring.notify.increase
  const ai = priceMonitoring.ai
  const aiOff = !ai.enabled

  const updateReminders = (patch: Partial<MaintenanceReminderSettings>) =>
    onRemindersChange({ ...reminders, ...patch })
  const remindersOff = remindersDisabled || !reminders.enabled

  const updateAchievements = (patch: Partial<AchievementSettings>) =>
    onAchievementsChange({ ...achievements, ...patch })
  const achievementsOff = achievementsDisabled || !achievements.enabled

  return (
    <div className="settings-grid">
      <SettingsSection
        title="Price drops & stock"
        description="Changes found by a price check show up in the Inbox under Prices. Repeats for the same store update one notification instead of adding more."
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
              checked={priceMonitoring.notify[option.key]}
              disabled={priceDisabled}
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
            value={priceMonitoring.thresholds.minPercent}
            min={PRICE_MONITORING_LIMITS.minPercent[0]}
            max={PRICE_MONITORING_LIMITS.minPercent[1]}
            decimals={1}
            unit="%"
            disabled={priceDisabled}
            onCommit={(minPercent) => updateThresholds({ minPercent })}
          />
        </SettingsRow>
        <SettingsRow
          label="Minimum amount"
          description="Price notifications also skip changes smaller than this, in each price's own currency (3 means $3, €3 or ₴3). A change must pass both the percent and the amount. 0 turns it off."
        >
          <NumberField
            aria-label="Minimum price change in the price's currency"
            value={priceMonitoring.thresholds.minAmount}
            min={PRICE_MONITORING_LIMITS.minAmount[0]}
            max={PRICE_MONITORING_LIMITS.minAmount[1]}
            decimals={2}
            unit="in its currency"
            disabled={priceDisabled || !priceAlertsOn}
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
            checked={priceMonitoring.thresholds.allTimeLow}
            disabled={priceDisabled || !priceMonitoring.notify.drop}
            onCheckedChange={(allTimeLow) => updateThresholds({ allTimeLow })}
          />
        </SettingsRow>
        {serverRuntime ? (
          <SettingsRow
            inline
            label="Daily summary in the Inbox"
            description={
              aiOff ? (
                <>
                  Once a day, AI writes a short price summary. Turn on AI in{' '}
                  <SettingsLink tab="prices">
                    Price monitoring → AI assistance
                  </SettingsLink>{' '}
                  first.
                </>
              ) : (
                "Once a day, AI writes a short summary: the best current prices against regular prices, drops and restocks of the last 24 hours, store pages that broke, and what AI fixed. Each day's summary replaces the last. Only knife names, store names and prices are sent: no notes, photos or links."
              )
            }
          >
            <SettingsSwitch
              aria-label="Let AI write a daily price summary in the Inbox"
              checked={ai.dailyDigest}
              disabled={priceDisabled || aiOff}
              onCheckedChange={(dailyDigest) =>
                updatePrice({ ai: { ...ai, dailyDigest } })
              }
            />
          </SettingsRow>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title="Maintenance reminders"
        description={
          <>
            Reminders are worked out from your maintenance log. Set how often
            each kind of care is due in{' '}
            <SettingsLink tab="maintenance">Maintenance</SettingsLink>.
          </>
        }
      >
        <SettingsRow
          inline
          label="Show care reminders"
          description="Due badges on cards, the Care filter in the collection, care notes in the Inbox, and the Care status card on Insights."
        >
          <SettingsSwitch
            aria-label="Show care reminders"
            checked={reminders.enabled}
            disabled={remindersDisabled}
            onCheckedChange={(enabled) => updateReminders({ enabled })}
          />
        </SettingsRow>
        <SettingsRow
          label="“Due soon” window"
          description="How many days before the deadline a knife is flagged as due soon."
        >
          <DaysInput
            aria-label="Due soon window in days"
            value={reminders.dueSoonDays}
            min={0}
            max={365}
            disabled={remindersOff}
            onCommit={(dueSoonDays) => updateReminders({ dueSoonDays })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="System notifications">
        <DesktopNotificationSettings />
        <SettingsRow
          inline
          label="Celebrate achievements on screen"
          description={
            achievements.enabled ? (
              'Show a message when you unlock one, with confetti for Gold and Platinum.'
            ) : (
              <>
                Achievements are off. Turn them on in{' '}
                <SettingsLink tab="achievements">Achievements</SettingsLink>.
              </>
            )
          }
        >
          <SettingsSwitch
            aria-label="Celebrate achievements on screen"
            checked={achievements.celebrate}
            disabled={achievementsOff}
            onCheckedChange={(celebrate) => updateAchievements({ celebrate })}
          />
        </SettingsRow>
        {serverRuntime ? (
          <SettingsRow
            inline
            label="Achievement Inbox messages"
            description="Keep a note of each unlock in the Inbox."
          >
            <SettingsSwitch
              aria-label="Achievement Inbox messages"
              checked={achievements.inbox}
              disabled={achievementsOff}
              onCheckedChange={(inbox) => updateAchievements({ inbox })}
            />
          </SettingsRow>
        ) : null}
      </SettingsSection>
    </div>
  )
}
