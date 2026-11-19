#!/usr/bin/env node
/*
 * BladeVault MCP stdio bridge.
 *
 * Speaks MCP over stdin/stdout for clients that only launch local processes
 * (such as Claude Desktop) and relays every message to the running app's HTTP
 * MCP endpoint. The app stays the only process that touches the vault, so its
 * write controls, timestamp checks, and change log apply unchanged.
 *
 * Run it with the Electron binary the app ships and ELECTRON_RUN_AS_NODE=1, or
 * with any Node.js 20+. stdout carries JSON-RPC messages only; every log line
 * goes to stderr.
 *
 * Endpoint discovery, in order:
 *   BLADEVAULT_MCP_URL (+ optional BLADEVAULT_MCP_TOKEN)
 *   the endpoint file the app writes while it runs: BLADEVAULT_MCP_DISCOVERY_FILE,
 *   or <app data>/BladeVault/mcp-endpoint.json
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Anything printed with console.log would corrupt the protocol stream.
console.log = console.error
console.info = console.error
console.warn = console.error
console.debug = console.error

const BRIDGE_VERSION = '1.0.0'
const DEFAULT_PROTOCOL_VERSION = '2025-06-18'
const KNOWN_PROTOCOL_VERSIONS = new Set([
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
])
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000
const RECONNECT_POLL_MS = 3000

const NOT_RUNNING_MESSAGE =
  "BladeVault isn't running. Open the BladeVault app, then try again."
const DISABLED_MESSAGE =
  'MCP access is turned off in BladeVault. Turn it on in Settings → AI / MCP, then try again.'
const UNAUTHORIZED_MESSAGE =
  'BladeVault rejected the MCP token. Open BladeVault so it can refresh its connection details, then try again.'

const INSTRUCTIONS =
  'BladeVault manages one local knife collection. Read records before changing them. Use propose_changes for candidate metadata, then preview bulk_update_knives before applying it. Updates require the latest updatedAt value. Never infer that duplicate candidates should be deleted, and never claim propose_changes modifies data. For store price monitoring, read get_price_watch before preview-then-apply changes with update_price_watch; request_price_check only queues checks at each store’s normal pace.'

function log(...args) {
  console.error('[bladevault-mcp-stdio]', ...args)
}

function defaultAppDataDir() {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support')
  }
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
  }
  return process.env.XDG_CONFIG_HOME || path.join(home, '.config')
}

function getDiscoveryFile() {
  return (
    process.env.BLADEVAULT_MCP_DISCOVERY_FILE?.trim() ||
    path.join(defaultAppDataDir(), 'BladeVault', 'mcp-endpoint.json')
  )
}

function getToolsCacheFile() {
  return path.join(path.dirname(getDiscoveryFile()), 'mcp-tools-cache.json')
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

/** Returns { url, token } for the running app, or null when it isn't running. */
function readEndpoint() {
  const envToken = process.env.BLADEVAULT_MCP_TOKEN?.trim() || ''
  const envUrl = process.env.BLADEVAULT_MCP_URL?.trim()
  if (envUrl) return { url: envUrl, token: envToken }

  let data
  try {
    data = JSON.parse(fs.readFileSync(getDiscoveryFile(), 'utf8'))
  } catch {
    return null
  }
  if (!data || typeof data.url !== 'string' || !data.url) return null
  if (Number.isInteger(data.pid) && data.pid > 0 && !isProcessAlive(data.pid)) {
    return null
  }
  return {
    url: data.url,
    token: envToken || (typeof data.token === 'string' ? data.token : ''),
  }
}

class Unavailable extends Error {
  constructor(message) {
    super(message)
    this.name = 'Unavailable'
  }
}

function parseSse(text) {
  const messages = []
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!data) continue
    try {
      messages.push(JSON.parse(data))
    } catch {
      log('Ignoring a malformed event from BladeVault.')
    }
  }
  return messages
}

/** POSTs one JSON-RPC message to the app and returns the messages it sent back. */
async function relay(message, retriedAuth = false) {
  const endpoint = readEndpoint()
  if (!endpoint) throw new Unavailable(NOT_RUNNING_MESSAGE)

  let response
  try {
    response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(endpoint.token
          ? { authorization: `Bearer ${endpoint.token}` }
          : {}),
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    if (error && error.name === 'TimeoutError') {
      throw new Error('BladeVault did not answer in time.')
    }
    throw new Unavailable(NOT_RUNNING_MESSAGE)
  }

  if (response.status === 401) {
    await response.body?.cancel().catch(() => {})
    // The app republishes its token on every MCP request, so one retry picks
    // up a token that changed after a restore or data-folder switch.
    if (!retriedAuth) return relay(message, true)
    throw new Unavailable(UNAUTHORIZED_MESSAGE)
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {})
    throw new Unavailable(DISABLED_MESSAGE)
  }
  if (response.status === 202 || response.status === 204) {
    await response.body?.cancel().catch(() => {})
    return []
  }

  const text = await response.text()
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('text/event-stream')) return parseSse(text)

  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (body && (Array.isArray(body) || body.jsonrpc)) {
    return Array.isArray(body) ? body : [body]
  }
  const detail = body && typeof body.error === 'string' ? `: ${body.error}` : ''
  throw new Error(`BladeVault returned HTTP ${response.status}${detail}`)
}

let stdoutClosed = false

function send(message) {
  if (stdoutClosed) return
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function readCachedTools() {
  try {
    const data = JSON.parse(fs.readFileSync(getToolsCacheFile(), 'utf8'))
    return Array.isArray(data.tools) ? data.tools : []
  } catch {
    return []
  }
}

function writeCachedTools(tools) {
  const file = getToolsCacheFile()
  if (!fs.existsSync(path.dirname(file))) return
  try {
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify({ tools }), { mode: 0o600 })
    fs.renameSync(temp, file)
  } catch (error) {
    log('Could not cache the tool list:', error.message)
  }
}

// When the app was unreachable while the client listed tools, watch for it to
// come back and tell the client to list them again.
let reconnectTimer = null

function watchForApp() {
  if (reconnectTimer) return
  reconnectTimer = setInterval(() => {
    if (!readEndpoint()) return
    relay({
      jsonrpc: '2.0',
      id: 'bladevault-bridge-probe',
      method: 'tools/list',
    })
      .then((messages) => {
        const tools = messages.find((entry) => entry.result?.tools)?.result
          .tools
        if (!tools) return
        clearInterval(reconnectTimer)
        reconnectTimer = null
        writeCachedTools(tools)
        send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
      })
      .catch(() => {})
  }, RECONNECT_POLL_MS)
  reconnectTimer.unref()
}

/** Answers a request locally while the app can't be reached. */
function answerOffline(message, reason) {
  const { id, method, params } = message
  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion
      sendResult(id, {
        protocolVersion: KNOWN_PROTOCOL_VERSIONS.has(requested)
          ? requested
          : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'bladevault', version: BRIDGE_VERSION },
        instructions: INSTRUCTIONS,
      })
      return
    }
    case 'ping':
      sendResult(id, {})
      return
    case 'tools/list':
      sendResult(id, { tools: readCachedTools() })
      watchForApp()
      return
    case 'tools/call':
      sendResult(id, {
        content: [{ type: 'text', text: reason }],
        isError: true,
      })
      return
    default:
      sendError(id, -32000, reason)
  }
}

async function handle(message) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
    sendError(null, -32600, 'Invalid JSON-RPC message.')
    return
  }
  const isRequest = message.id !== undefined && message.id !== null
  const isResponse = isRequest && !message.method
  // The HTTP endpoint is stateless and never sends requests to the client, so
  // client responses and notifications have nowhere to go.
  if (isResponse) return

  try {
    const replies = await relay(message)
    if (!isRequest) return
    for (const reply of replies) {
      if (reply.id === message.id && message.method === 'tools/list') {
        if (Array.isArray(reply.result?.tools)) {
          writeCachedTools(reply.result.tools)
        }
      }
      send(reply)
    }
    if (!replies.some((reply) => reply.id === message.id)) {
      sendError(message.id, -32603, 'BladeVault sent no response.')
    }
  } catch (error) {
    if (!isRequest) return
    if (error instanceof Unavailable) {
      answerOffline(message, error.message)
      return
    }
    log(error)
    sendError(
      message.id,
      -32603,
      error instanceof Error ? error.message : String(error),
    )
  }
}

function main() {
  const pending = new Set()
  let buffer = ''
  let inputEnded = false

  const finishIfDone = () => {
    if (inputEnded && pending.size === 0) process.exit(0)
  }

  const dispatch = (line) => {
    if (!line.trim()) return
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      sendError(null, -32700, 'Parse error.')
      return
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      const task = handle(message).finally(() => {
        pending.delete(task)
        finishIfDone()
      })
      pending.add(task)
    }
  }

  process.stdout.on('error', (error) => {
    if (error.code === 'EPIPE') {
      stdoutClosed = true
      process.exit(0)
    }
    log(error)
  })

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      dispatch(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
  })
  process.stdin.on('end', () => {
    if (buffer.trim()) dispatch(buffer)
    buffer = ''
    inputEnded = true
    finishIfDone()
  })

  process.once('SIGINT', () => process.exit(0))
  process.once('SIGTERM', () => process.exit(0))
}

if (require.main === module) {
  main()
}

module.exports = { parseSse, readEndpoint, getDiscoveryFile }
