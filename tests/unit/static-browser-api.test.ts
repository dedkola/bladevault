// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBrowserApi, resetSession } from '../../static-app/browser-api'

let restore: () => void
const nativeFetch = vi.fn<typeof fetch>()
async function request(path: string, method = 'GET', body?: unknown) {
  const response = await window.fetch(path, {
    method,
    ...(body
      ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  })
  return { status: response.status, data: await response.json() }
}

beforeEach(() => {
  sessionStorage.clear()
  resetSession()
  nativeFetch.mockReset().mockResolvedValue(Response.json({ asset: true }))
  window.fetch = nativeFetch
  restore = installBrowserApi()
})
afterEach(() => {
  restore()
  vi.restoreAllMocks()
  sessionStorage.clear()
})

describe('empty static browser app', () => {
  it('starts without collection records, activity, logs, or sample collections', async () => {
    expect((await request('/api/knives')).data.knives).toEqual([])
    expect((await request('/api/activity')).data.activity).toEqual([])
    expect((await request('/api/logs')).data.events).toEqual([])
    expect((await request('/api/smart-collections')).data.collections).toEqual(
      [],
    )
    expect((await request('/api/comparisons')).data.lists[0].ids).toEqual([])
  })

  it('supports creating, editing, and deleting a record only in this tab', async () => {
    const created = await request('/api/knives', 'POST', {
      name: 'Browser test',
      specs: { bladeLength: '80 mm' },
    })
    const { id, addedAt } = created.data.knife
    const edited = await request(`/api/knives/${id}`, 'PATCH', {
      name: 'Edited',
      pinned: true,
      description: 'Temporary',
      specs: { bladeMaterial: 'Test steel' },
    })
    expect(edited.data.knife).toMatchObject({
      id,
      addedAt,
      name: 'Edited',
      pinned: true,
      description: 'Temporary',
      specs: { bladeLength: '80 mm', bladeMaterial: 'Test steel' },
    })
    expect(sessionStorage.length).toBe(1)
    await request('/api/compare', 'POST', { id })
    await request(`/api/knives/${id}`, 'DELETE')
    expect((await request('/api/knives')).data.knives).toEqual([])
    expect((await request('/api/compare')).data.compareIds).toEqual([])
  })

  it('rejects stale bulk updates without partially modifying records', async () => {
    const first = (await request('/api/knives', 'POST', { name: 'First' })).data
      .knife
    const second = (await request('/api/knives', 'POST', { name: 'Second' }))
      .data.knife
    const result = await request('/api/knives/bulk', 'PATCH', {
      ids: [first.id, second.id],
      field: 'brand',
      value: 'Changed',
      expectedUpdatedAt: { [first.id]: first.updatedAt, [second.id]: 'stale' },
    })
    expect(result.status).toBe(409)
    expect(
      (await request('/api/knives')).data.knives.map(
        (k: { brand: string }) => k.brand,
      ),
    ).toEqual(['', ''])
  })

  it('rolls back a mutation when the tab storage is full', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Full', 'QuotaExceededError')
    })
    const result = await request('/api/knives', 'POST', { name: 'Unsaved' })
    expect(result.status).toBe(400)
    expect(result.data.error).toContain('full')
    expect((await request('/api/knives')).data.knives).toEqual([])
    expect((await request('/api/logs')).data.events).toEqual([])
  })

  it('disables server features and preserves normal asset fetches', async () => {
    expect((await request('/api/runtime-config')).data).toEqual({
      authUrl: '',
      backupUrl: '',
    })
    expect((await request('/api/settings/mcp')).data.mcp.enabled).toBe(false)
    expect(
      (await request('/api/scrape', 'POST', { url: 'https://example.com' }))
        .status,
    ).toBe(501)
    expect((await request('/api/cloud-backup/job', 'POST', {})).status).toBe(
      501,
    )
    expect(
      (await request('/api/local-backup/archive', 'POST', {})).status,
    ).toBe(501)
    expect(nativeFetch).not.toHaveBeenCalled()
    const asset = await window.fetch('/logo.svg')
    expect(await asset.json()).toEqual({ asset: true })
    expect(nativeFetch).toHaveBeenCalledWith('/logo.svg', undefined)
  })
})
