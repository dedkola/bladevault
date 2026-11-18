import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const BRIDGE = path.resolve(__dirname, '../../electron/mcp-stdio.cjs')

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  },
}
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' }
const LIST_TOOLS = { jsonrpc: '2.0', id: 2, method: 'tools/list' }
const CALL_TOOL = {
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'search_knives', arguments: {} },
}

const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bladevault-bridge-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

type Received = { authorization?: string; body: { method?: string } }

async function startFakeApp(
  respond: (body: { id?: unknown; method?: string }) => {
    status: number
    sse?: unknown
  },
) {
  const received: Received[] = []
  const server = http.createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      const body = JSON.parse(raw)
      received.push({ authorization: request.headers.authorization, body })
      const { status, sse } = respond(body)
      if (sse === undefined) {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(status === 202 ? '' : JSON.stringify({ error: 'nope' }))
        return
      }
      response.writeHead(status, { 'content-type': 'text/event-stream' })
      response.end(`event: message\ndata: ${JSON.stringify(sse)}\n\n`)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  )
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/mcp`, received }
}

function runBridge(
  messages: unknown[],
  env: Record<string, string>,
): Promise<{ stdout: string; replies: Record<string, unknown>[] }> {
  return new Promise((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: makeDir(),
      ...env,
    }
    delete childEnv.BLADEVAULT_MCP_URL
    delete childEnv.BLADEVAULT_MCP_TOKEN
    Object.assign(childEnv, env)
    const child = spawn(process.execPath, [BRIDGE], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.on('error', reject)
    child.on('close', () => {
      const replies = stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      resolve({ stdout, replies })
    })
    for (const message of messages) {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }
    child.stdin.end()
  })
}

function byId(replies: Record<string, unknown>[], id: number) {
  return replies.find((reply) => reply.id === id) as
    | { result?: Record<string, unknown>; error?: { message: string } }
    | undefined
}

describe('MCP stdio bridge', () => {
  it('prints nothing on stdout before a request arrives', async () => {
    const { stdout } = await runBridge([], {
      BLADEVAULT_MCP_DISCOVERY_FILE: path.join(makeDir(), 'missing.json'),
    })
    expect(stdout).toBe('')
  })

  it('relays requests to the app found in the endpoint file, with its token', async () => {
    const app = await startFakeApp((body) => {
      if (body.method === 'notifications/initialized') return { status: 202 }
      if (body.method === 'tools/list') {
        return {
          status: 200,
          sse: {
            jsonrpc: '2.0',
            id: body.id,
            result: { tools: [{ name: 'search_knives', inputSchema: {} }] },
          },
        }
      }
      return {
        status: 200,
        sse: { jsonrpc: '2.0', id: body.id, result: { relayed: body.method } },
      }
    })
    const dir = makeDir()
    const discoveryFile = path.join(dir, 'mcp-endpoint.json')
    fs.writeFileSync(
      discoveryFile,
      JSON.stringify({ url: app.url, token: 'secret', pid: process.pid }),
    )

    const { replies } = await runBridge(
      [INITIALIZE, INITIALIZED, LIST_TOOLS, CALL_TOOL],
      { BLADEVAULT_MCP_DISCOVERY_FILE: discoveryFile },
    )

    expect(replies).toHaveLength(3)
    expect(byId(replies, 1)?.result).toEqual({ relayed: 'initialize' })
    expect(byId(replies, 3)?.result).toEqual({ relayed: 'tools/call' })
    expect(app.received.map((entry) => entry.body.method).sort()).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
      'tools/list',
    ])
    expect(
      app.received.every((entry) => entry.authorization === 'Bearer secret'),
    ).toBe(true)
    // A successful listing is cached for when the app is closed.
    expect(
      JSON.parse(
        fs.readFileSync(path.join(dir, 'mcp-tools-cache.json'), 'utf8'),
      ),
    ).toEqual({ tools: [{ name: 'search_knives', inputSchema: {} }] })
  })

  it('stays up and explains itself when the app is not running', async () => {
    const dir = makeDir()
    fs.writeFileSync(
      path.join(dir, 'mcp-tools-cache.json'),
      JSON.stringify({ tools: [{ name: 'search_knives', inputSchema: {} }] }),
    )

    const { replies } = await runBridge(
      [INITIALIZE, INITIALIZED, LIST_TOOLS, CALL_TOOL],
      { BLADEVAULT_MCP_DISCOVERY_FILE: path.join(dir, 'mcp-endpoint.json') },
    )

    expect(byId(replies, 1)?.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'bladevault' },
    })
    expect(byId(replies, 2)?.result).toEqual({
      tools: [{ name: 'search_knives', inputSchema: {} }],
    })
    expect(byId(replies, 3)?.result).toEqual({
      content: [
        {
          type: 'text',
          text: "BladeVault isn't running. Open the BladeVault app, then try again.",
        },
      ],
      isError: true,
    })
  })

  it('ignores an endpoint file left behind by a process that exited', async () => {
    const app = await startFakeApp(() => ({ status: 500 }))
    const dir = makeDir()
    const discoveryFile = path.join(dir, 'mcp-endpoint.json')
    fs.writeFileSync(
      discoveryFile,
      JSON.stringify({ url: app.url, token: 'secret', pid: 2 ** 22 + 12345 }),
    )

    const { replies } = await runBridge([CALL_TOOL], {
      BLADEVAULT_MCP_DISCOVERY_FILE: discoveryFile,
    })

    expect(app.received).toHaveLength(0)
    expect(byId(replies, 3)?.result?.isError).toBe(true)
  })

  it('reports when MCP access is turned off in the app', async () => {
    const app = await startFakeApp(() => ({ status: 404 }))

    const { replies } = await runBridge([CALL_TOOL], {
      BLADEVAULT_MCP_URL: app.url,
    })

    expect(byId(replies, 3)?.result).toEqual({
      content: [
        {
          type: 'text',
          text: 'MCP access is turned off in BladeVault. Turn it on in Settings → AI / MCP, then try again.',
        },
      ],
      isError: true,
    })
  })
})
