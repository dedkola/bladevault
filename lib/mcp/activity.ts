import type { McpTransport } from '@/lib/services/knife-service'

type McpActivityState = {
  lastActivityAt: string | null
  httpRequestsSinceStart: number
  toolCallsSinceStart: number
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

export function getMcpActivity() {
  return { ...getActivityState() }
}
