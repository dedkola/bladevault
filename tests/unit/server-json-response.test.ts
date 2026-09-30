import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { dockerJsonResponse } from '@/lib/server-json-response'

const originalDockerRuntime = process.env.BLADEVAULT_DOCKER_RUNTIME

afterEach(() => {
  if (originalDockerRuntime === undefined) {
    delete process.env.BLADEVAULT_DOCKER_RUNTIME
  } else {
    process.env.BLADEVAULT_DOCKER_RUNTIME = originalDockerRuntime
  }
})

describe('dockerJsonResponse', () => {
  it('compresses large Docker JSON responses when the client accepts gzip', async () => {
    process.env.BLADEVAULT_DOCKER_RUNTIME = '1'
    const payload = {
      knives: Array.from({ length: 100 }, (_, id) => ({
        id,
        name: `Performance fixture ${id}`,
      })),
    }
    const request = new Request('http://localhost/api/knives', {
      headers: { 'Accept-Encoding': 'gzip, deflate' },
    })

    const response = await dockerJsonResponse(request, payload, {
      headers: { Vary: 'RSC' },
    })
    const compressed = Buffer.from(await response.arrayBuffer())

    expect(response.headers.get('Content-Encoding')).toBe('gzip')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Vary')).toBe('RSC, Accept-Encoding')
    expect(JSON.parse(gunzipSync(compressed).toString('utf8'))).toEqual(payload)
  })

  it('keeps responses uncompressed outside Docker', async () => {
    delete process.env.BLADEVAULT_DOCKER_RUNTIME
    const payload = { events: Array.from({ length: 100 }, (_, id) => ({ id })) }
    const request = new Request('http://localhost/api/logs', {
      headers: { 'Accept-Encoding': 'gzip' },
    })

    const response = await dockerJsonResponse(request, payload)

    expect(response.headers.get('Content-Encoding')).toBeNull()
    expect(await response.json()).toEqual(payload)
  })

  it('honors clients that explicitly reject gzip', async () => {
    process.env.BLADEVAULT_DOCKER_RUNTIME = '1'
    const payload = { activity: 'x'.repeat(2_000) }
    const request = new Request('http://localhost/api/activity', {
      headers: { 'Accept-Encoding': 'gzip;q=0, identity' },
    })

    const response = await dockerJsonResponse(request, payload)

    expect(response.headers.get('Content-Encoding')).toBeNull()
    expect(await response.json()).toEqual(payload)
  })

  it('lets an explicit gzip rejection override a wildcard', async () => {
    process.env.BLADEVAULT_DOCKER_RUNTIME = '1'
    const payload = { knives: 'x'.repeat(2_000) }
    const request = new Request('http://localhost/api/knives', {
      headers: { 'Accept-Encoding': 'gzip;q=0, *;q=1' },
    })

    const response = await dockerJsonResponse(request, payload)

    expect(response.headers.get('Content-Encoding')).toBeNull()
  })
})
