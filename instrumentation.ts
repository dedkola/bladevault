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
  }
}

export const onRequestError = Sentry.captureRequestError
