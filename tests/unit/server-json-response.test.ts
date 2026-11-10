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
  it('returns plain JSON in Docker even when the client accepts gzip', async () => {
    // Next strips Content-Encoding from route responses, so a manually
    // gzipped body would reach the browser undecodable.
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

    expect(response.headers.get('Content-Encoding')).toBeNull()
    expect(response.headers.get('Content-Type')).toBe(
      'application/json; charset=utf-8',
    )
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Vary')).toBe('RSC')
    expect(await response.json()).toEqual(payload)
  })

  it('keeps a caller-provided Cache-Control and status', async () => {
    const request = new Request('http://localhost/api/logs')

    const response = await dockerJsonResponse(
      request,
      { events: [] },
      { status: 201, headers: { 'Cache-Control': 'no-cache' } },
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('Cache-Control')).toBe('no-cache')
    expect(await response.json()).toEqual({ events: [] })
  })
})
