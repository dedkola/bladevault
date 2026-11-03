import { EventEmitter } from 'node:events'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import { PassThrough } from 'node:stream'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestExternalUrl } from '@/lib/external-http'
import { ScrapeError } from '@/lib/scrape-errors'

const mocks = vi.hoisted(() => ({ http: vi.fn(), https: vi.fn() }))
vi.mock('node:http', () => ({ request: mocks.http }))
vi.mock('node:https', () => ({ request: mocks.https }))

const target = new URL(
  'https://shop.example:8443/products/knife?variant=123#details',
)
const address = { address: '93.184.216.34', family: 4 }
let callback: (incoming: IncomingMessage) => void
let request: EventEmitter & {
  end: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  destroyed: boolean
}
let incoming: PassThrough & {
  rawHeaders: string[]
  statusCode: number
  statusMessage: string
}

function respond(status = 200, headers: string[] = []) {
  incoming = Object.assign(new PassThrough(), {
    rawHeaders: headers,
    statusCode: status,
    statusMessage: status === 200 ? 'OK' : '',
  })
  callback(incoming as unknown as IncomingMessage)
  return incoming
}

beforeEach(() => {
  vi.resetAllMocks()
  request = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    destroy: vi.fn(),
    destroyed: false,
  })
  request.destroy.mockImplementation((error?: Error) => {
    if (!request.destroyed) {
      request.destroyed = true
      if (error) queueMicrotask(() => request.emit('error', error))
    }
    return request
  })
  const start = (
    _endpoint: URL,
    _options: RequestOptions,
    onResponse: (response: IncomingMessage) => void,
  ) => {
    callback = onResponse
    return request as unknown as ClientRequest
  }
  mocks.http.mockImplementation(start)
  mocks.https.mockImplementation(start)
})
afterEach(() => {
  incoming?.destroy()
  vi.useRealTimers()
})

describe('pinned external HTTP transport', () => {
  it('uses a fallback deadline for stuck headers even with an unbounded parent signal', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const pending = requestExternalUrl(target, address, {
      signal: controller.signal,
    })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(request.destroyed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(request.destroyed).toBe(true)
    expect(controller.signal.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the fallback deadline active for a stuck compressed body without a parent signal', async () => {
    vi.useFakeTimers()
    const pending = requestExternalUrl(target, address, {})
    respond(200, ['Content-Encoding', 'gzip'])
    const response = await pending
    const rejected = expect(response.text()).rejects.toMatchObject({
      code: 'timeout',
    })
    await vi.advanceTimersByTimeAsync(60_000)
    await rejected
    expect(incoming.destroyed).toBe(true)
    expect(request.destroyed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['success', 'cancel'] as const)(
    'clears the fallback deadline on body %s',
    async (outcome) => {
      vi.useFakeTimers()
      const pending = requestExternalUrl(target, address, {})
      respond()
      const response = await pending
      expect(vi.getTimerCount()).toBe(1)
      if (outcome === 'success') {
        incoming.end('Knife')
        await expect(response.text()).resolves.toBe('Knife')
      } else {
        await response.body!.cancel()
      }
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('connects to the validated numeric endpoint while preserving Host, path, port and TLS identity', async () => {
    const pending = requestExternalUrl(target, address, {
      headers: {
        Host: 'wrong.example',
        Accept: 'text/html',
        Referer: 'https://shop.example/',
      },
    })
    respond(200, [
      'Content-Type',
      'text/html',
      'Set-Cookie',
      'one=1',
      'Set-Cookie',
      'two=2',
    ]).end('<h1>Knife</h1>')
    const response = await pending
    const [endpoint, options] = mocks.https.mock.calls[0]
    expect(endpoint).toBeInstanceOf(URL)
    expect(endpoint.href).toBe('https://93.184.216.34/')
    expect(options).toMatchObject({
      hostname: address.address,
      family: 4,
      port: '8443',
      path: '/products/knife?variant=123',
      method: 'GET',
      agent: false,
      servername: 'shop.example',
    })
    expect(options.headers).toMatchObject({
      host: 'shop.example:8443',
      accept: 'text/html',
      referer: 'https://shop.example/',
      'accept-encoding': 'identity',
    })
    expect(options.rejectUnauthorized).toBeUndefined()
    expect(options.checkServerIdentity).toBeUndefined()
    expect(mocks.http).not.toHaveBeenCalled()
    expect(request.end).toHaveBeenCalledOnce()
    expect(response.url).toBe(target.href)
    expect(response.headers.get('content-type')).toBe('text/html')
    expect(response.headers.getSetCookie()).toEqual(['one=1', 'two=2'])
    await expect(response.text()).resolves.toBe('<h1>Knife</h1>')
  })

  it('supports a pinned IPv6 literal without sending an IP as TLS servername', async () => {
    const url = new URL('https://[2001:4860:4860::8888]/knife')
    const pending = requestExternalUrl(
      url,
      { address: '2001:4860:4860::8888', family: 6 },
      {},
    )
    respond().end('Knife')
    const response = await pending
    const [endpoint, options] = mocks.https.mock.calls[0]
    expect(endpoint.href).toBe('https://[2001:4860:4860::8888]/')
    expect(options).toMatchObject({
      hostname: '2001:4860:4860::8888',
      family: 6,
      port: 443,
    })
    expect(options.servername).toBeUndefined()
    expect(options.headers.host).toBe('[2001:4860:4860::8888]')
    await response.text()
  })

  it('uses HTTP for an HTTP target and leaves redirect handling to its caller', async () => {
    const url = new URL('http://shop.example/old')
    const pending = requestExternalUrl(url, address, { redirect: 'follow' })
    respond(302, ['Location', 'http://next.example/product']).end()
    const response = await pending
    expect(mocks.http).toHaveBeenCalledOnce()
    expect(mocks.https).not.toHaveBeenCalled()
    expect(mocks.http.mock.calls[0][0].href).toBe('http://93.184.216.34/')
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('http://next.example/product')
    await response.body?.cancel()
  })

  it.each([
    ['gzip', gzipSync],
    ['deflate', deflateSync],
    ['br', brotliCompressSync],
    ['gzip, br', (buffer: Buffer) => brotliCompressSync(gzipSync(buffer))],
  ] as const)(
    'decodes %s incrementally and removes stale compression headers',
    async (encoding, compress) => {
      const content = 'Knife specifications — stainless steel'
      const compressed = compress(Buffer.from(content))
      const pending = requestExternalUrl(target, address, {})
      respond(200, [
        'Content-Encoding',
        encoding,
        'Content-Length',
        String(compressed.length),
        'Content-Type',
        'text/html',
      ]).end(compressed)
      const response = await pending
      expect(response.headers.get('content-encoding')).toBeNull()
      expect(response.headers.get('content-length')).toBeNull()
      expect(response.headers.get('content-type')).toBe('text/html')
      await expect(response.text()).resolves.toBe(content)
    },
  )

  it('returns headers before the body ends and destroys upstream when its reader cancels', async () => {
    const pending = requestExternalUrl(target, address, {})
    respond()
    const response = await pending
    const reader = response.body!.getReader()
    incoming.write(Buffer.from('first chunk'))
    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: new Uint8Array(Buffer.from('first chunk')),
    })
    expect(incoming.writableEnded).toBe(false)
    await reader.cancel()
    expect(incoming.destroyed).toBe(true)
    expect(request.destroy).toHaveBeenCalled()
  })

  it('propagates abort before headers and destroys the request', async () => {
    const controller = new AbortController()
    const pending = requestExternalUrl(target, address, {
      signal: controller.signal,
    })
    const failure = new ScrapeError('timeout')
    controller.abort(failure)
    await expect(pending).rejects.toBe(failure)
    expect(request.destroy).toHaveBeenCalledWith(failure)
  })

  it('keeps abort active after headers while body reading is pending', async () => {
    const controller = new AbortController()
    const pending = requestExternalUrl(target, address, {
      signal: controller.signal,
    })
    respond()
    const response = await pending
    const body = response.text()
    const failure = new ScrapeError('timeout')
    controller.abort(failure)
    await expect(body).rejects.toBe(failure)
    expect(incoming.destroyed).toBe(true)
    expect(request.destroy).toHaveBeenCalledWith(failure)
  })

  it('destroys both the decoder and upstream when a compressed response is cancelled', async () => {
    const pending = requestExternalUrl(target, address, {})
    respond(200, ['Content-Encoding', 'gzip'])
    const response = await pending
    await response.body!.cancel()
    expect(incoming.destroyed).toBe(true)
    expect(request.destroy).toHaveBeenCalled()
  })

  it('reports request and body failures as network errors', async () => {
    const pending = requestExternalUrl(target, address, {})
    request.emit(
      'error',
      Object.assign(new Error('socket disconnected'), { code: 'ECONNRESET' }),
    )
    await expect(pending).rejects.toMatchObject({ code: 'network' })

    const next = requestExternalUrl(target, address, {})
    respond()
    const response = await next
    const body = response.text()
    incoming.destroy(new Error('connection lost'))
    await expect(body).rejects.toMatchObject({ code: 'network' })
  })

  it('does not expose malformed compressed bytes as product data', async () => {
    const pending = requestExternalUrl(target, address, {})
    respond(200, ['Content-Encoding', 'gzip']).end('not gzip')
    const response = await pending
    await expect(response.text()).rejects.toMatchObject({ code: 'network' })
    expect(request.destroy).toHaveBeenCalled()
  })

  it.each([204, 205, 304])(
    'returns no body and closes transport for HTTP %s',
    async (status) => {
      const pending = requestExternalUrl(target, address, {})
      respond(status)
      const response = await pending
      expect(response.status).toBe(status)
      expect(response.body).toBeNull()
      expect(incoming.destroyed).toBe(true)
      expect(request.destroy).toHaveBeenCalled()
    },
  )

  it('supports HEAD without constructing a response body', async () => {
    const pending = requestExternalUrl(target, address, { method: 'HEAD' })
    respond(200, ['Content-Length', '100'])
    const response = await pending
    expect(response.body).toBeNull()
    expect(response.headers.get('content-length')).toBe('100')
    expect(mocks.https.mock.calls[0][1].method).toBe('HEAD')
  })

  it('rejects nonnumeric addresses, unsupported methods, credentials and pre-aborted signals before connecting', async () => {
    await expect(
      requestExternalUrl(target, { address: 'shop.example', family: 4 }, {}),
    ).rejects.toThrow('numeric IP address')
    await expect(
      requestExternalUrl(target, { address: address.address, family: 6 }, {}),
    ).rejects.toThrow('numeric IP address')
    await expect(
      requestExternalUrl(target, address, { method: 'POST', body: 'x' }),
    ).rejects.toThrow('GET and HEAD')
    await expect(
      requestExternalUrl(
        new URL('https://user:password@shop.example/'),
        address,
        {},
      ),
    ).rejects.toMatchObject({
      code: 'invalid_url',
      message: expect.stringContaining('username or password'),
    })
    await expect(
      requestExternalUrl(new URL('file:///tmp/knife'), address, {}),
    ).rejects.toThrow('HTTP and HTTPS')
    const controller = new AbortController()
    controller.abort(new ScrapeError('cancelled'))
    await expect(
      requestExternalUrl(target, address, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(mocks.http).not.toHaveBeenCalled()
    expect(mocks.https).not.toHaveBeenCalled()
  })
})
