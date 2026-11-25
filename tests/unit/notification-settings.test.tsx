// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import {
  DEFAULT_ACHIEVEMENTS,
  DEFAULT_BACKUP_NOTIFICATIONS,
  DEFAULT_MAINTENANCE_REMINDERS,
  DEFAULT_POPUP_NOTIFICATIONS,
  DEFAULT_PRICE_MONITORING,
  type AchievementSettings,
  type MaintenanceReminderSettings,
  type PopupNotificationSettings,
  type PriceMonitoringSettings,
} from '@/lib/settings-shared'

vi.mock('@/components/providers/knives-provider', () => ({
  useKnives: () => ({ knives: [], timeFormat: '24h' }),
}))

const { NotificationSettings } =
  await import('@/components/notification-settings')

afterEach(() => {
  cleanup()
  delete window.bladevaultDesktop
})

function renderSettings({
  price = DEFAULT_PRICE_MONITORING,
  reminders = DEFAULT_MAINTENANCE_REMINDERS,
  achievements = DEFAULT_ACHIEVEMENTS,
  popups = DEFAULT_POPUP_NOTIFICATIONS,
}: {
  price?: PriceMonitoringSettings
  reminders?: MaintenanceReminderSettings
  achievements?: AchievementSettings
  popups?: PopupNotificationSettings
} = {}) {
  const handlers = {
    onPriceMonitoringChange: vi.fn(),
    onRemindersChange: vi.fn(),
    onAchievementsChange: vi.fn(),
    onBackupNotificationsChange: vi.fn(),
    onPopupNotificationsChange: vi.fn(),
  }
  render(
    <NotificationSettings
      priceMonitoring={price}
      reminders={reminders}
      achievements={achievements}
      backupNotifications={DEFAULT_BACKUP_NOTIFICATIONS}
      popupNotifications={popups}
      {...handlers}
    />,
  )
  return handlers
}

it('groups price, maintenance and system notifications', () => {
  renderSettings()
  for (const title of [
    'In-app pop-ups',
    'Price drops & stock',
    'Maintenance reminders',
    'System notifications',
  ]) {
    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument()
  }
})

it('saves a price notification switch into the notify categories', async () => {
  const { onPriceMonitoringChange } = renderSettings()
  const toggle = screen.getByRole('switch', {
    name: 'Notify about price increases',
  })
  await userEvent.click(toggle)
  expect(onPriceMonitoringChange).toHaveBeenCalledWith({
    ...DEFAULT_PRICE_MONITORING,
    notify: {
      ...DEFAULT_PRICE_MONITORING.notify,
      increase: !DEFAULT_PRICE_MONITORING.notify.increase,
    },
  })
})

it('keeps the AI daily summary off until AI is set up', async () => {
  renderSettings({
    price: {
      ...DEFAULT_PRICE_MONITORING,
      ai: { ...DEFAULT_PRICE_MONITORING.ai, enabled: false },
    },
  })
  expect(
    screen.getByRole('switch', {
      name: 'Let AI write a daily price summary in the Inbox',
    }),
  ).toBeDisabled()
  expect(
    screen.getByRole('link', { name: /Price monitoring → AI assistance/ }),
  ).toHaveAttribute('href', '/settings?tab=prices')
})

it('saves the AI daily summary when AI is on', async () => {
  const price = {
    ...DEFAULT_PRICE_MONITORING,
    ai: { ...DEFAULT_PRICE_MONITORING.ai, enabled: true, dailyDigest: false },
  }
  const { onPriceMonitoringChange } = renderSettings({ price })
  await userEvent.click(
    screen.getByRole('switch', {
      name: 'Let AI write a daily price summary in the Inbox',
    }),
  )
  expect(onPriceMonitoringChange).toHaveBeenCalledWith({
    ...price,
    ai: { ...price.ai, dailyDigest: true },
  })
})

it('turns care reminders off from the maintenance section', async () => {
  const { onRemindersChange } = renderSettings()
  await userEvent.click(
    screen.getByRole('switch', { name: 'Show care reminders' }),
  )
  expect(onRemindersChange).toHaveBeenCalledWith({
    ...DEFAULT_MAINTENANCE_REMINDERS,
    enabled: false,
  })
})

it('disables achievement notifications while achievements are off', () => {
  renderSettings({
    achievements: { ...DEFAULT_ACHIEVEMENTS, enabled: false },
  })
  expect(
    screen.getByRole('switch', { name: 'Celebrate achievements on screen' }),
  ).toBeDisabled()
  expect(
    screen.getByRole('switch', { name: 'Achievement Inbox messages' }),
  ).toBeDisabled()
  expect(screen.getByRole('link', { name: 'Achievements' })).toHaveAttribute(
    'href',
    '/settings?tab=achievements',
  )
})

it('shows the desktop notification switch inside System notifications', async () => {
  window.bladevaultDesktop = {
    getPriceNotifications: vi.fn(async () => ({
      enabled: true,
      supported: true,
    })),
  } as unknown as NonNullable<Window['bladevaultDesktop']>
  renderSettings()
  expect(
    await screen.findByRole('switch', {
      name: 'Desktop notifications for price drops',
    }),
  ).toBeChecked()
})

it('turns on Google Drive backup and restore Inbox messages', async () => {
  const { onBackupNotificationsChange } = renderSettings()
  const backup = screen.getByRole('switch', {
    name: 'Inbox message when a Google Drive backup finishes',
  })
  expect(backup).not.toBeChecked()
  await userEvent.click(backup)
  expect(onBackupNotificationsChange).toHaveBeenLastCalledWith({
    backup: true,
    restore: false,
  })
  await userEvent.click(
    screen.getByRole('switch', {
      name: 'Inbox message after a restore from Google Drive',
    }),
  )
  expect(onBackupNotificationsChange).toHaveBeenLastCalledWith({
    backup: false,
    restore: true,
  })
  expect(screen.getByRole('link', { name: 'Backup' })).toHaveAttribute(
    'href',
    '/settings?tab=backup',
  )
})

it('turns every pop-up kind on by default and saves one switch', async () => {
  const { onPopupNotificationsChange } = renderSettings()
  for (const name of [
    'Show pop-up notifications',
    'Pop-ups for prices and stock',
    'Pop-ups for care reminders',
    'Pop-ups for system messages',
  ]) {
    expect(screen.getByRole('switch', { name })).toBeChecked()
  }
  await userEvent.click(
    screen.getByRole('switch', { name: 'Pop-ups for care reminders' }),
  )
  expect(onPopupNotificationsChange).toHaveBeenLastCalledWith({
    ...DEFAULT_POPUP_NOTIFICATIONS,
    care: false,
  })
})

it('disables the pop-up kinds while pop-ups are off', () => {
  renderSettings({
    popups: { ...DEFAULT_POPUP_NOTIFICATIONS, enabled: false },
  })
  expect(
    screen.getByRole('switch', { name: 'Show pop-up notifications' }),
  ).not.toBeChecked()
  expect(
    screen.getByRole('switch', { name: 'Pop-ups for prices and stock' }),
  ).toBeDisabled()
})
