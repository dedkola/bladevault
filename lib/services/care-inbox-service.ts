import { getSettings } from '@/lib/settings'
import { getStorage } from '@/lib/storage'
import { buildLatestByKnife, getCareStatuses } from '@/lib/maintenance-due'
import type {
  CareNotification,
  CareNotificationAction,
} from '@/lib/care-notifications'

/**
 * Creates, escalates and resolves care inbox messages from the current care
 * status. Leaves the inbox untouched while reminders are switched off.
 */
export async function syncCareInbox(
  now: Date = new Date(),
): Promise<CareNotification[]> {
  const storage = getStorage()
  const settings = getSettings()
  const reminders = settings.maintenanceReminders
  if (!reminders.enabled) return storage.getCareNotifications()
  const [knives, latest] = await Promise.all([
    storage.getAllKnives(),
    storage.getMaintenanceLatest(),
  ])
  const statuses = getCareStatuses(
    knives,
    buildLatestByKnife(latest),
    reminders,
    settings.careIntervalOverrides,
    now,
    settings.careDeferrals,
  )
  return storage.syncCareNotifications(statuses, now)
}

export async function updateCareInbox(
  action: CareNotificationAction,
  now: Date = new Date(),
): Promise<CareNotification[]> {
  return getStorage().updateCareNotifications(action, now)
}
