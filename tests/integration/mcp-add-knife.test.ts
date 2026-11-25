import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleMcpHttpRequest } from '@/lib/mcp/http'
import { getKnifeDetails } from '@/lib/services/collection-service'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

const previousEnv = {
  enabled: process.env.MCP_ENABLED,
  writeEnabled: process.env.MCP_WRITE_ENABLED,
  token: process.env.MCP_AUTH_TOKEN,
}

let vault: TempVault | null = null

beforeEach(async () => {
  vault = await createTempVault()
  process.env.MCP_ENABLED = 'true'
  process.env.MCP_AUTH_TOKEN = 'test-secret'
})

afterEach(async () => {
  for (const [key, value] of [
    ['MCP_ENABLED', previousEnv.enabled],
    ['MCP_WRITE_ENABLED', previousEnv.writeEnabled],
    ['MCP_AUTH_TOKEN', previousEnv.token],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await vault?.cleanup()
  vault = null
})

type ToolResponse = {
  result?: {
    tools?: Array<{ name: string; annotations?: Record<string, unknown> }>
    isError?: boolean
    content?: Array<{ text: string }>
    structuredContent?: Record<string, unknown>
  }
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const response = await handleMcpHttpRequest(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        host: 'localhost',
        authorization: 'Bearer test-secret',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: name === 'tools/list' ? 'tools/list' : 'tools/call',
        params: name === 'tools/list' ? {} : { name, arguments: args },
      }),
    }),
  )
  const text = await response.text()
  const data = text.split('\n').find((line) => line.startsWith('data: '))
  return JSON.parse(data ? data.slice('data: '.length) : text) as ToolResponse
}

const para3 = {
  name: ' Para 3 ',
  brand: 'Spyderco',
  handle_material: 'G-10',
  specs: { model_number: 'C223GP', blade_material: 'CPM S45VN' },
}

describe('MCP add_knife', () => {
  it('previews without saving and needs write mode to apply', async () => {
    process.env.MCP_WRITE_ENABLED = 'false'
    const list = await callTool('tools/list', {})
    const tool = list.result?.tools?.find((entry) => entry.name === 'add_knife')
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false })

    const preview = await callTool('add_knife', para3)
    expect(preview.result?.structuredContent).toMatchObject({
      applied: false,
      knife: { name: 'Para 3', specs: { modelNumber: 'C223GP' } },
      possibleDuplicates: [],
    })
    const apply = await callTool('add_knife', {
      ...para3,
      apply: true,
      preview_hash: preview.result?.structuredContent?.previewHash,
    })
    expect(apply.result?.isError).toBe(true)
    expect(apply.result?.content?.[0]?.text).toContain(
      'write tools are disabled',
    )
    await expect(getKnifeDetails('para-3')).rejects.toThrow()
  })

  it('applies a fresh preview and guards stale hashes and duplicates', async () => {
    process.env.MCP_WRITE_ENABLED = 'true'
    const stale = await callTool('add_knife', {
      ...para3,
      apply: true,
      preview_hash: 'stale',
    })
    expect(stale.result?.content?.[0]?.text).toContain('stale')

    const preview = await callTool('add_knife', para3)
    const hash = preview.result?.structuredContent?.previewHash
    const changed = await callTool('add_knife', {
      ...para3,
      name: 'Para 3 Lightweight',
      apply: true,
      preview_hash: hash,
    })
    expect(changed.result?.isError).toBe(true)

    const added = await callTool('add_knife', {
      ...para3,
      apply: true,
      preview_hash: hash,
    })
    expect(added.result?.structuredContent).toMatchObject({
      applied: true,
      knife: { id: 'para-3', name: 'Para 3', images: [] },
    })
    expect((await getKnifeDetails('para-3')).knife).toMatchObject({
      brand: 'Spyderco',
      specs: { bladeMaterial: 'CPM S45VN' },
    })

    const again = await callTool('add_knife', para3)
    expect(again.result?.structuredContent?.possibleDuplicates).toEqual([
      expect.objectContaining({ id: 'para-3' }),
    ])
    const blocked = await callTool('add_knife', {
      ...para3,
      apply: true,
      preview_hash: again.result?.structuredContent?.previewHash,
    })
    expect(blocked.result?.content?.[0]?.text).toContain('duplicate')
    const allowed = await callTool('add_knife', {
      ...para3,
      apply: true,
      allow_duplicate: true,
      preview_hash: again.result?.structuredContent?.previewHash,
    })
    expect(allowed.result?.structuredContent).toMatchObject({ applied: true })
  })

  it('rejects a source URL that is not http or https', async () => {
    const preview = await callTool('add_knife', {
      ...para3,
      source_url: 'javascript:alert(1)',
    })
    expect(preview.result?.isError).toBe(true)
  })
})
