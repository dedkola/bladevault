import { saveSettings, getSettings } from '@/lib/settings'

/**
 * Price monitoring defaults to the Wishlist. Tests about checks, queues and
 * insights (not about What to monitor) call this so every knife is in scope.
 */
export function monitorWholeCollection() {
  saveSettings({
    priceMonitoring: {
      ...getSettings().priceMonitoring,
      scope: { kind: 'all', knifeIds: [] },
    },
  })
}
