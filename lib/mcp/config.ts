import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getLocalDataDirPath, getLocalDb } from '@/lib/local-db'
import { getMcpActivity } from '@/lib/mcp/activity'
import { getSettings, saveSettings } from '@/lib/settings'

type McpRuntimeSettingsUpdate = {
  enabled?: boolean
  writeEnabled?: boolean
}

const MCP_AUTH_TOKEN_SETTING_KEY = 'mcp_auth_token'

export type McpAuthToken = {
  token: string
  managedByEnvironment: boolean
}

function environmentFlag(value: string | undefined) {
  const normalized = value?.trim().toLowerCase()
  return {
    managed: Boolean(normalized),
    value: normalized === 'true' || normalized === '1',
  }
}

function getMcpControlState() {
  const settings = getSettings()
  const enabledOverride = environmentFlag(process.env.MCP_ENABLED)
  const writeOverride = environmentFlag(process.env.MCP_WRITE_ENABLED)

  return {
    enabled: enabledOverride.managed
      ? enabledOverride.value
      : settings.mcpEnabled,
    writeEnabled: writeOverride.managed
      ? writeOverride.value
      : settings.mcpWriteEnabled,
    enabledManagedByEnvironment: enabledOverride.managed,
    writeEnabledManagedByEnvironment: writeOverride.managed,
  }
}

export function areMcpWritesEnabled(): boolean {
  return getMcpControlState().writeEnabled
}

export function isMcpEnabled(): boolean {
  return getMcpControlState().enabled
}

function getPersistedMcpAuthToken(): string | null {
  const row = getLocalDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(MCP_AUTH_TOKEN_SETTING_KEY) as { value: string } | undefined
  return row?.value.trim() || null
}

function createPersistedMcpAuthToken(): string {
  const token = `bv_mcp_${randomBytes(32).toString('base64url')}`
  getLocalDb()
    .prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
    .run(MCP_AUTH_TOKEN_SETTING_KEY, token)
  return getPersistedMcpAuthToken() || token
}

export function getMcpAuthToken(): McpAuthToken {
  const environmentToken = process.env.MCP_AUTH_TOKEN?.trim()
  if (environmentToken) {
    return { token: environmentToken, managedByEnvironment: true }
  }

  return {
    token: getPersistedMcpAuthToken() || createPersistedMcpAuthToken(),
    managedByEnvironment: false,
  }
}

export class McpSettingManagedError extends Error {}

export function updateMcpRuntimeSettings(updates: McpRuntimeSettingsUpdate) {
  const control = getMcpControlState()
  if (
    (updates.enabled !== undefined && control.enabledManagedByEnvironment) ||
    (updates.writeEnabled !== undefined &&
      control.writeEnabledManagedByEnvironment)
  ) {
    throw new McpSettingManagedError(
      'This MCP setting is controlled by a deployment environment variable.',
    )
  }

  saveSettings({
    ...(updates.enabled === undefined ? {} : { mcpEnabled: updates.enabled }),
    ...(updates.writeEnabled === undefined
      ? {}
      : { mcpWriteEnabled: updates.writeEnabled }),
    ...(updates.enabled === false ? { mcpWriteEnabled: false } : {}),
  })

  return getMcpRuntimeStatus()
}

function getMcpDataStats() {
  const database = getLocalDb()
  const collection = database
    .prepare('SELECT COUNT(*) AS count FROM knives')
    .get() as { count: number }
  const changes = database
    .prepare(
      `SELECT COUNT(DISTINCT operation_id) AS operation_count,
              COUNT(DISTINCT knife_id) AS knife_count,
              MAX(occurred_at) AS last_change_at
       FROM knife_change_log`,
    )
    .get() as {
    operation_count: number
    knife_count: number
    last_change_at: string | null
  }

  return {
    knifeCount: collection.count,
    writeOperationCount: changes.operation_count,
    changedKnifeCount: changes.knife_count,
    lastWriteAt: changes.last_change_at,
  }
}

export function getMcpRuntimeStatus() {
  const control = getMcpControlState()
  const auth = getMcpAuthToken()
  const packagedCommand = process.env.BLADEVAULT_MCP_NODE_COMMAND
  const packagedEntry = process.env.BLADEVAULT_MCP_ENTRY
  const standaloneEntry = path.join(process.cwd(), 'bladevault-mcp.mjs')
  const entry =
    packagedEntry ||
    (fs.existsSync(standaloneEntry)
      ? standaloneEntry
      : path.join(process.cwd(), 'dist/mcp/bladevault.mjs'))

  return {
    enabled: control.enabled,
    writeEnabled: control.writeEnabled,
    controls: {
      enabledManagedByEnvironment: control.enabledManagedByEnvironment,
      writeEnabledManagedByEnvironment:
        control.writeEnabledManagedByEnvironment,
    },
    http: {
      path: '/mcp',
      authConfigured: true,
      authToken: auth.token,
      authManagedByEnvironment: auth.managedByEnvironment,
      authRequiredForRemote: true,
    },
    tools: { read: 6, write: 2, total: 8 },
    activity: getMcpActivity(),
    stats: getMcpDataStats(),
    stdio: {
      command: packagedCommand || process.execPath,
      args: [entry, 'mcp'],
      env: {
        ELECTRON_RUN_AS_NODE: packagedCommand ? '1' : '',
        BLADEVAULT_DATA_DIR: getLocalDataDirPath(),
        MCP_WRITE_ENABLED: control.writeEnabled ? 'true' : 'false',
      },
    },
  }
}
