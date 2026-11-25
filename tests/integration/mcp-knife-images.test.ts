import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { lookup, requestExternalUrl, scrapeProductPage } = vi.hoisted(() => ({
  lookup: vi.fn(),
  requestExternalUrl: vi.fn(),
  scrapeProductPage: vi.fn(),
}))
vi.mock('dns/promises', () => ({ lookup }))
vi.mock('@/lib/external-http', () => ({ requestExternalUrl }))
vi.mock('@/lib/services/product-scrape-service', () => ({ scrapeProductPage }))

import { handleMcpHttpRequest } from '@/lib/mcp/http'
import { getLocalDb } from '@/lib/local-db'
import { getStorage } from '@/lib/storage'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

const ENV_KEYS = [
  'MCP_ENABLED',
  'MCP_WRITE_ENABLED',
  'MCP_AUTH_TOKEN',
  'MCP_IMAGE_HOST_ALLOWLIST',
] as const
const previousEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
)

let vault: TempVault | null = null

function png(seed: number) {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed])
}

/** Image bodies served per URL; anything else is a 404. */
let served: Record<string, Buffer | string> = {}

beforeEach(async () => {
  vault = await createTempVault()
  process.env.MCP_ENABLED = 'true'
  process.env.MCP_WRITE_ENABLED = 'true'
  process.env.MCP_AUTH_TOKEN = 'test-secret'
  delete process.env.MCP_IMAGE_HOST_ALLOWLIST
  lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  served = {
    'https://cdn.example.com/one.png': png(1),
    'https://cdn.example.com/two.png': png(2),
    'https://cdn.example.com/three.png': png(3),
    'https://cdn.example.com/copy-of-one.png': png(1),
    'https://cdn.example.com/page.html': '<!doctype html><html></html>',
  }
  requestExternalUrl.mockImplementation(async (url: URL) => {
    const body = served[url.href]
    return body === undefined
      ? new Response('missing', { status: 404 })
      : new Response(typeof body === 'string' ? body : new Uint8Array(body), {
          headers: { 'content-type': 'image/png' },
        })
  })
})

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key]
    else process.env[key] = previousEnv[key]
  }
  lookup.mockReset()
  requestExternalUrl.mockReset()
  scrapeProductPage.mockReset()
  await vault?.cleanup()
  vault = null
})

type ToolResult = {
  isError?: boolean
  content?: Array<{ text: string }>
  structuredContent?: Record<string, unknown> & {
    previewHash?: string
    images?: Array<Record<string, unknown>>
  }
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
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
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
  )
  const text = await response.text()
  const data = text.split('\n').find((line) => line.startsWith('data: '))
  const parsed = JSON.parse(data ? data.slice('data: '.length) : text) as {
    result: ToolResult
  }
  return parsed.result
}

async function previewThenApply(name: string, args: Record<string, unknown>) {
  const preview = await callTool(name, args)
  expect(preview.isError).toBeFalsy()
  return callTool(name, {
    ...args,
    apply: true,
    preview_hash: preview.structuredContent?.previewHash,
  })
}

async function addMarten(imageUrls: string[] = []) {
  const added = await previewThenApply('add_knife', {
    name: 'Marten',
    brand: 'Vosteed',
    source_url: 'https://vosteed.example.com/marten',
    ...(imageUrls.length ? { image_urls: imageUrls } : {}),
  })
  expect(added.structuredContent).toMatchObject({ applied: true })
  return getStorage().getKnifeById('marten')
}

function auditRows() {
  return getLocalDb()
    .prepare(
      'SELECT event_type, actor, source, summary FROM audit_log ORDER BY id',
    )
    .all() as Array<Record<string, string>>
}

describe('MCP knife images', () => {
  it('add_knife logs an MCP audit entry and saves image_urls as photos', async () => {
    const knife = await addMarten([
      'https://cdn.example.com/one.png',
      'https://cdn.example.com/missing.png',
    ])
    expect(knife?.images).toEqual(['marten/image-01.png'])
    const { buffer } = await getStorage().getImage('marten/image-01.png')
    expect(buffer.equals(png(1))).toBe(true)
    expect(auditRows()).toContainEqual(
      expect.objectContaining({
        event_type: 'created',
        actor: 'MCP client',
        source: 'MCP / add_knife',
        summary: expect.stringContaining('https://cdn.example.com/one.png'),
      }),
    )
    const changeLog = getLocalDb()
      .prepare('SELECT transport FROM knife_change_log WHERE knife_id = ?')
      .all('marten')
    expect(changeLog).toEqual([{ transport: 'http' }])
  })

  it('previews without saving and refuses to apply with writes off', async () => {
    await addMarten()
    process.env.MCP_WRITE_ENABLED = 'false'
    const args = {
      knife_id: 'marten',
      image_urls: [
        'https://cdn.example.com/one.png',
        'https://cdn.example.com/page.html',
        'http://cdn.example.com/two.png',
        'https://10.0.0.1/x.png',
      ],
    }
    const preview = await callTool('add_knife_images', args)
    expect(preview.structuredContent).toMatchObject({
      applied: false,
      okCount: 1,
      errorCount: 3,
      galleryBefore: 0,
      galleryAfter: 1,
    })
    expect(preview.structuredContent?.images).toEqual([
      expect.objectContaining({ status: 'ok', mime: 'image/png' }),
      expect.objectContaining({ status: 'error', code: 'not_image' }),
      expect.objectContaining({ status: 'error', code: 'not_https' }),
      expect.objectContaining({ status: 'error', code: 'blocked_url' }),
    ])
    expect((await getStorage().getKnifeById('marten'))?.images).toEqual([])

    const apply = await callTool('add_knife_images', {
      ...args,
      apply: true,
      preview_hash: preview.structuredContent?.previewHash,
    })
    expect(apply.isError).toBe(true)
    expect(apply.content?.[0]?.text).toContain('write tools are disabled')
    expect((await getStorage().getKnifeById('marten'))?.images).toEqual([])
  })

  it('appends good images, skips failures and duplicates, and audits', async () => {
    await addMarten(['https://cdn.example.com/one.png'])
    const result = await previewThenApply('add_knife_images', {
      knife_id: 'marten',
      image_urls: [
        'https://cdn.example.com/two.png',
        'https://cdn.example.com/copy-of-one.png',
        'https://cdn.example.com/missing.png',
        'https://cdn.example.com/three.png',
      ],
    })
    expect(result.structuredContent).toMatchObject({
      applied: true,
      okCount: 2,
      duplicateCount: 1,
      errorCount: 1,
    })
    expect(result.structuredContent?.images?.[1]).toMatchObject({
      status: 'duplicate',
      duplicateOf: 'marten/image-01.png',
    })
    expect((await getStorage().getKnifeById('marten'))?.images).toEqual([
      'marten/image-01.png',
      'marten/image-02.png',
      'marten/image-03.png',
    ])
    expect(auditRows().at(-1)).toMatchObject({
      event_type: 'updated',
      actor: 'MCP client',
      source: 'MCP / add_knife_images',
      summary: expect.stringContaining('https://cdn.example.com/three.png'),
    })
  })

  it('makes the preview stale when the knife changes', async () => {
    const knife = await addMarten()
    const args = {
      knife_id: 'marten',
      image_urls: ['https://cdn.example.com/one.png'],
    }
    const preview = await callTool('add_knife_images', args)
    await getStorage().updateKnife(
      'marten',
      { brand: 'Other' },
      {
        expectedUpdatedAt: knife?.updatedAt,
      },
    )
    const apply = await callTool('add_knife_images', {
      ...args,
      apply: true,
      preview_hash: preview.structuredContent?.previewHash,
    })
    expect(apply.isError).toBe(true)
    expect(apply.content?.[0]?.text).toContain('stale')
  })

  it('replace swaps the photos and removes the old files', async () => {
    await addMarten(['https://cdn.example.com/one.png'])
    const result = await previewThenApply('add_knife_images', {
      knife_id: 'marten',
      mode: 'replace',
      image_urls: ['https://cdn.example.com/two.png'],
    })
    expect(result.structuredContent).toMatchObject({ applied: true })
    expect((await getStorage().getKnifeById('marten'))?.images).toEqual([
      'marten/image-02.png',
    ])
    await expect(getStorage().getImage('marten/image-01.png')).rejects.toThrow()
  })

  it('honors the host allowlist from the environment', async () => {
    await addMarten()
    process.env.MCP_IMAGE_HOST_ALLOWLIST = 'images.example.org'
    const preview = await callTool('add_knife_images', {
      knife_id: 'marten',
      image_urls: ['https://cdn.example.com/one.png'],
    })
    expect(preview.structuredContent?.images).toEqual([
      expect.objectContaining({ status: 'error', code: 'host_not_allowed' }),
    ])
  })

  it('refill fails clearly without a source_url', async () => {
    const added = await previewThenApply('add_knife', { name: 'Plain' })
    expect(added.structuredContent).toMatchObject({ applied: true })
    const preview = await callTool('refill_knife_images', { knife_id: 'plain' })
    expect(preview.isError).toBe(true)
    expect(preview.content?.[0]?.text).toContain('no source_url')
    expect(scrapeProductPage).not.toHaveBeenCalled()
  })

  it('refill fails clearly when the page has no images', async () => {
    await addMarten()
    scrapeProductPage.mockResolvedValue({ result: { product: { images: [] } } })
    const preview = await callTool('refill_knife_images', {
      knife_id: 'marten',
    })
    expect(preview.isError).toBe(true)
    expect(preview.content?.[0]?.text).toContain('No product images')
  })

  it('refill replaces the gallery with the scraped images', async () => {
    await addMarten(['https://cdn.example.com/one.png'])
    scrapeProductPage.mockResolvedValue({
      result: {
        product: {
          images: [
            'https://cdn.example.com/two.png',
            'https://cdn.example.com/three.png',
          ],
        },
      },
    })
    const result = await previewThenApply('refill_knife_images', {
      knife_id: 'marten',
    })
    expect(result.structuredContent).toMatchObject({
      applied: true,
      okCount: 2,
    })
    expect((await getStorage().getKnifeById('marten'))?.images).toEqual([
      'marten/image-02.png',
      'marten/image-03.png',
    ])
    expect(auditRows().at(-1)).toMatchObject({
      source: 'MCP / refill_knife_images',
      summary: expect.stringContaining('https://vosteed.example.com/marten'),
    })
  })

  it('refill preview goes stale when the page images change', async () => {
    await addMarten()
    scrapeProductPage.mockResolvedValue({
      result: { product: { images: ['https://cdn.example.com/two.png'] } },
    })
    const preview = await callTool('refill_knife_images', {
      knife_id: 'marten',
    })
    scrapeProductPage.mockResolvedValue({
      result: { product: { images: ['https://cdn.example.com/three.png'] } },
    })
    const apply = await callTool('refill_knife_images', {
      knife_id: 'marten',
      apply: true,
      preview_hash: preview.structuredContent?.previewHash,
    })
    expect(apply.isError).toBe(true)
    expect(apply.content?.[0]?.text).toContain('stale')
  })
})
