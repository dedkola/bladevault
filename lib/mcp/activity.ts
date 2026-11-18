import type { McpTransport } from '@/lib/services/knife-service'

type McpActivityState = {
  lastActivityAt: string | null
  httpRequestsSinceStart: number
  toolCallsSinceStart: number
  writesSinceStart: number
  lastTransport: McpTransport | null
}

const globalActivity = globalThis as typeof globalThis & {
  __bladeVaultMcpActivity?: McpActivityState
}

function getActivityState(): McpActivityState {
  globalActivity.__bladeVaultMcpActivity ??= {
    lastActivityAt: null,
    httpRequestsSinceStart: 0,
    toolCallsSinceStart: 0,
    writesSinceStart: 0,
    lastTransport: null,
  }
  return globalActivity.__bladeVaultMcpActivity
}

function markActivity(transport: McpTransport) {
  const activity = getActivityState()
  activity.lastActivityAt = new Date().toISOString()
  activity.lastTransport = transport
  return activity
}

export function recordMcpHttpRequest() {
  const activity = markActivity('http')
  activity.httpRequestsSinceStart += 1
}

export function recordMcpToolCall(transport: McpTransport) {
  const activity = markActivity(transport)
  activity.toolCallsSinceStart += 1
}

/**
 * Counts MCP writes made through this server process. MCP shares the app's
 * SQLite connection, so `PRAGMA data_version` cannot see these writes; open
 * windows compare this counter to know when to reload.
 */
export function recordMcpWrite() {
  getActivityState().writesSinceStart += 1
}

export function getMcpActivity() {
  return { ...getActivityState() }
}
