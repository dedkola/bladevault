import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleMcpHttpRequest } from '@/lib/mcp/http'
import {
  getMcpRuntimeStatus,
  McpSettingManagedError,
  updateMcpRuntimeSettings,
} from '@/lib/mcp/config'
import { getSettings, saveSettings } from '@/lib/settings'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

const previous = {
  enabled: process.env.MCP_ENABLED,
  writeEnabled: process.env.MCP_WRITE_ENABLED,
  token: process.env.MCP_AUTH_TOKEN,
}

let vault: TempVault | null = null

beforeEach(async () => {
  vault = await createTempVault('bladevault-mcp-http-test-')
  delete process.env.MCP_ENABLED
  delete process.env.MCP_WRITE_ENABLED
  delete process.env.MCP_AUTH_TOKEN
})

afterEach(async () => {
  if (previous.enabled === undefined) delete process.env.MCP_ENABLED
  else process.env.MCP_ENABLED = previous.enabled
  if (previous.writeEnabled === undefined) delete process.env.MCP_WRITE_ENABLED
  else process.env.MCP_WRITE_ENABLED = previous.writeEnabled
  if (previous.token === undefined) delete process.env.MCP_AUTH_TOKEN
  else process.env.MCP_AUTH_TOKEN = previous.token
  await vault?.cleanup()
  vault = null
})

function initializeRequest(
  token?: string,
  { host = 'localhost', origin }: { host?: string; origin?: string } = {},
) {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      host,
      ...(origin ? { origin } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'bladevault-test', version: '1.0.0' },
      },
    }),
  })
}

describe('MCP HTTP transport', () => {
  it('persists access controls and turns writes off when MCP is disabled', () => {
    expect(getMcpRuntimeStatus()).toMatchObject({
      enabled: true,
      writeEnabled: false,
    })

    updateMcpRuntimeSettings({ writeEnabled: true })
    expect(getSettings().mcpWriteEnabled).toBe(true)

    updateMcpRuntimeSettings({ enabled: false })
    expect(getMcpRuntimeStatus()).toMatchObject({
      enabled: false,
      writeEnabled: false,
    })
    expect(getSettings()).toMatchObject({
      mcpEnabled: false,
      mcpWriteEnabled: false,
    })
  })

  it('reports and preserves explicit deployment overrides', () => {
    process.env.MCP_ENABLED = 'false'
    expect(getMcpRuntimeStatus()).toMatchObject({
      enabled: false,
      controls: { enabledManagedByEnvironment: true },
    })
    expect(() => updateMcpRuntimeSettings({ enabled: true })).toThrow(
      McpSettingManagedError,
    )
  })

  it('stays closed until enabled, then supports URL-only localhost access', async () => {
    saveSettings({ mcpEnabled: false })
    expect((await handleMcpHttpRequest(initializeRequest())).status).toBe(404)

    saveSettings({ mcpEnabled: true })
    expect((await handleMcpHttpRequest(initializeRequest())).status).toBe(200)
  })

  it('requires bearer authentication when a token is configured', async () => {
    process.env.MCP_ENABLED = 'true'
    process.env.MCP_AUTH_TOKEN = 'test-secret'
    expect((await handleMcpHttpRequest(initializeRequest())).status).toBe(401)
    expect(
      (await handleMcpHttpRequest(initializeRequest('wrong-secret'))).status,
    ).toBe(401)
  })

  it('rejects non-local hosts and browser origins in URL-only mode', async () => {
    process.env.MCP_ENABLED = 'true'
    delete process.env.MCP_AUTH_TOKEN

    expect(
      (
        await handleMcpHttpRequest(
          initializeRequest(undefined, { host: 'bladevault.example.com' }),
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await handleMcpHttpRequest(
          initializeRequest(undefined, {
            origin: 'https://untrusted.example.com',
          }),
        )
      ).status,
    ).toBe(403)
  })

  it('serves an authenticated MCP initialization handshake', async () => {
    process.env.MCP_ENABLED = 'true'
    process.env.MCP_AUTH_TOKEN = 'test-secret'
    const response = await handleMcpHttpRequest(
      initializeRequest('test-secret'),
    )

    expect(response.status).toBe(200)
    const text = await response.text()
    const dataLine = text.split('\n').find((line) => line.startsWith('data: '))
    expect(dataLine).toBeDefined()
    expect(JSON.parse(dataLine!.slice('data: '.length))).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-11-25',
        serverInfo: { name: 'bladevault' },
      },
    })
  })
})
