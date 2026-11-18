'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SERVER_NAME = 'bladevault'

/** Location of Claude Desktop's config file on this platform. */
function getClaudeDesktopConfigPath({
  platform = process.platform,
  homedir = os.homedir(),
  env = process.env,
} = {}) {
  if (platform === 'darwin') {
    return path.join(
      homedir,
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    )
  }
  if (platform === 'win32') {
    return path.join(
      env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
      'Claude',
      'claude_desktop_config.json',
    )
  }
  return path.join(
    env.XDG_CONFIG_HOME || path.join(homedir, '.config'),
    'Claude',
    'claude_desktop_config.json',
  )
}

function buildBladeVaultServerEntry({ command, bridgePath, discoveryFile }) {
  return {
    command,
    args: [bridgePath],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      BLADEVAULT_MCP_DISCOVERY_FILE: discoveryFile,
    },
  }
}

/**
 * Returns the config text with only mcpServers.bladevault replaced. Throws
 * instead of guessing when the existing file is not a JSON object.
 */
function mergeClaudeDesktopConfig(existingText, entry) {
  let config = {}
  if (existingText !== null && existingText.trim()) {
    try {
      config = JSON.parse(existingText)
    } catch {
      throw new Error(
        "Claude Desktop's config file isn't valid JSON. Fix or remove it, then try again.",
      )
    }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(
      "Claude Desktop's config file doesn't contain a JSON object. Fix or remove it, then try again.",
    )
  }

  const servers = config.mcpServers ?? {}
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error(
      "The mcpServers entry in Claude Desktop's config file isn't an object. Fix it, then try again.",
    )
  }

  const changed = JSON.stringify(servers[SERVER_NAME]) !== JSON.stringify(entry)
  const next = { ...config, mcpServers: { ...servers, [SERVER_NAME]: entry } }
  return { text: `${JSON.stringify(next, null, 2)}\n`, changed }
}

function backupSuffix(now) {
  return now.toISOString().replace(/[:.]/g, '-')
}

/**
 * Adds or updates the BladeVault entry in Claude Desktop's config. Backs up an
 * existing file first and leaves every other server and setting as it was.
 */
function installClaudeDesktopServer({ configPath, entry, now = new Date() }) {
  let existingText = null
  try {
    existingText = fs.readFileSync(configPath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const { text, changed } = mergeClaudeDesktopConfig(existingText, entry)
  if (!changed) {
    return { configPath, backupPath: null, changed: false }
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  let backupPath = null
  if (existingText !== null) {
    backupPath = `${configPath}.bladevault-backup-${backupSuffix(now)}`
    fs.copyFileSync(configPath, backupPath)
  }

  const temp = `${configPath}.bladevault-${process.pid}.tmp`
  fs.writeFileSync(temp, text)
  fs.renameSync(temp, configPath)
  return { configPath, backupPath, changed: true }
}

module.exports = {
  SERVER_NAME,
  buildBladeVaultServerEntry,
  getClaudeDesktopConfigPath,
  installClaudeDesktopServer,
  mergeClaudeDesktopConfig,
}
