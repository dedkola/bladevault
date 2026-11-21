import * as Sentry from '@sentry/nextjs'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./lib/sentry/server-init')

    // The desktop app's stdio MCP bridge finds this server through an endpoint
    // file; publish it at startup so the bridge works before any MCP request.
    if (process.env.BLADEVAULT_MCP_DISCOVERY_FILE) {
      try {
        const { getMcpAuthToken } = await import('./lib/mcp/config')
        getMcpAuthToken()
      } catch (error) {
        console.error(
          '[bladevault-mcp] Could not publish the MCP endpoint',
          error,
        )
      }
    }

    // Every AI request price monitoring makes is recorded (no content).
    try {
      const { installAiCallJournal } =
        await import('./lib/price-monitor/ai-journal')
      installAiCallJournal()
    } catch (error) {
      console.error(
        '[price-monitor] Could not start the AI call journal',
        error,
      )
    }

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

    // Stop the price worker, release its lease and exit on SIGTERM/SIGINT,
    // and when the desktop app that started this server is gone: Next alone
    // can wait forever on open connections (lib/server-shutdown).
    if (process.env.NEXT_PHASE !== 'phase-production-build') {
      const { installServerShutdown } = await import('./lib/server-shutdown')
      const parentPid = Number(process.env.BLADEVAULT_PARENT_PID)
      installServerShutdown({
        parentPid: Number.isInteger(parentPid) ? parentPid : null,
        stopWorker: async (timeoutMs) => {
          const { getPriceMonitorWorker } =
            await import('./lib/price-monitor/worker')
          await getPriceMonitorWorker().stop({ timeoutMs })
        },
      })
    }
  }
}

export const onRequestError = Sentry.captureRequestError
