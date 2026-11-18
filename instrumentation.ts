import * as Sentry from '@sentry/nextjs'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./lib/sentry/server-init')
    // Price monitoring runs in the server process, independent of any page.
    // Dev servers use the real vault, so they only schedule when asked to.
    if (
      process.env.NEXT_PHASE !== 'phase-production-build' &&
      process.env.BLADEVAULT_PRICE_MONITOR !== 'off' &&
      (process.env.NODE_ENV === 'production' ||
        process.env.BLADEVAULT_PRICE_MONITOR_DEV === '1')
    ) {
      const { startPriceMonitorWorker } =
        await import('./lib/price-monitor/worker')
      startPriceMonitorWorker()
    }
  }
}

export const onRequestError = Sentry.captureRequestError
