import fs from 'node:fs'
import path from 'node:path'

const LAST_PUBLISHED_KEY = Symbol.for('bladevault.mcp-discovery-published')

type DiscoveryGlobal = typeof globalThis & {
  [LAST_PUBLISHED_KEY]?: string
}

/**
 * Writes the running server's MCP endpoint and token to the file named by
 * BLADEVAULT_MCP_DISCOVERY_FILE, so the stdio bridge (electron/mcp-stdio.cjs)
 * can find it without users copying tokens or ports. Only the desktop app sets
 * that variable; other runtimes publish nothing.
 */
export function publishMcpDiscovery(token: string): void {
  const file = process.env.BLADEVAULT_MCP_DISCOVERY_FILE?.trim()
  const port = process.env.PORT?.trim()
  if (!file || !port) return

  const payload = JSON.stringify({
    version: 1,
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    pid: process.pid,
  })
  const runtime = globalThis as DiscoveryGlobal
  if (runtime[LAST_PUBLISHED_KEY] === payload) return

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, payload, { mode: 0o600 })
    fs.renameSync(temp, file)
    runtime[LAST_PUBLISHED_KEY] = payload
  } catch (error) {
    console.error(
      '[bladevault-mcp] Could not write the MCP endpoint file',
      error,
    )
  }
}
