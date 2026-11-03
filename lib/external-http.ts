import {
  request as requestHttp,
  type ClientRequest,
  type IncomingMessage,
} from 'node:http'
import { request as requestHttps } from 'node:https'
import { isIP } from 'node:net'
import { PassThrough, Readable, pipeline, type Transform } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { ScrapeError } from '@/lib/scrape-errors'
import { createScrapeOperation } from '@/lib/scrape-operation'

/** Send to an already validated numeric address without resolving the hostname again. */
export async function requestExternalUrl(
  url: URL,
  address: { address: string; family: number },
  init: RequestInit,
): Promise<Response> {
  const initialSignal = init.signal ?? undefined
  initialSignal?.throwIfAborted()
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Only HTTP and HTTPS requests are supported')
  }
  if (url.username || url.password) {
    throw new ScrapeError(
      'invalid_url',
      'Product URLs must not include a username or password. Use the public product URL.',
    )
  }
  const method = (init.method ?? 'GET').toUpperCase()
  if ((method !== 'GET' && method !== 'HEAD') || init.body != null) {
    throw new TypeError(
      'External downloads support GET and HEAD requests without a body',
    )
  }
  if (!isIP(address.address) || isIP(address.address) !== address.family) {
    throw new TypeError(
      'External downloads require a validated numeric IP address',
    )
  }

  const secure = url.protocol === 'https:'
  const endpointHost =
    address.family === 6 ? `[${address.address}]` : address.address
  // Keep the socket destination separate from the original request target.
  const endpoint = new URL(`${secure ? 'https:' : 'http:'}//${endpointHost}/`)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const headers = new Headers(init.headers)
  headers.set('Host', url.host)
  if (!headers.has('Accept-Encoding'))
    headers.set('Accept-Encoding', 'identity')
  const options = {
    hostname: address.address,
    family: address.family,
    port: url.port || (secure ? 443 : 80),
    path: url.pathname + url.search,
    method,
    headers: Object.fromEntries(headers),
    agent: false as const,
    ...(secure && !isIP(hostname) ? { servername: hostname } : {}),
  }
  // Some image-download callers have no parent deadline. Keep the deadline
  // alive through the body, rather than stopping it when headers arrive.
  const operation = createScrapeOperation({ signal: initialSignal })
  const signal = operation.signal

  return new Promise<Response>((resolve, reject) => {
    let request: ClientRequest | undefined
    let incoming: IncomingMessage | undefined
    let body: PassThrough | undefined
    let decoders: Transform[] = []
    let settled = false
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
      operation.dispose()
    }
    const abortReason = () =>
      signal?.reason instanceof Error
        ? signal.reason
        : new DOMException('The request was aborted', 'AbortError')
    const networkFailure = (error: unknown) =>
      signal?.aborted
        ? abortReason()
        : error instanceof ScrapeError
          ? error
          : new ScrapeError('network')
    const stop = (error?: Error) => {
      cleanup()
      body?.destroy(error)
      for (const decoder of decoders) decoder.destroy(error)
      incoming?.destroy(error)
      request?.destroy(error)
    }
    const fail = (error: unknown) => {
      const failure = networkFailure(error)
      stop(failure)
      if (!settled) {
        settled = true
        reject(failure)
      }
    }
    const onAbort = () => fail(abortReason())
    const onResponse = (response: IncomingMessage) => {
      incoming = response
      response.once('error', fail)
      response.once('aborted', () => fail(new ScrapeError('network')))
      if (settled) {
        stop()
        return
      }
      if (signal?.aborted) {
        onAbort()
        return
      }
      try {
        const responseHeaders = new Headers()
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          responseHeaders.append(
            response.rawHeaders[index],
            response.rawHeaders[index + 1],
          )
        }
        const status = response.statusCode ?? 502
        const noBody = method === 'HEAD' || [204, 205, 304].includes(status)
        if (noBody) {
          const result = new Response(null, {
            status,
            statusText: response.statusMessage,
            headers: responseHeaders,
          })
          Object.defineProperty(result, 'url', { value: url.href })
          settled = true
          resolve(result)
          stop()
          return
        }

        const encodings = (responseHeaders.get('content-encoding') ?? '')
          .split(',')
          .map((encoding) => encoding.trim().toLowerCase())
          .filter((encoding) => encoding && encoding !== 'identity')
        decoders = encodings.reverse().map((encoding) => {
          if (encoding === 'gzip' || encoding === 'x-gzip')
            return createGunzip()
          if (encoding === 'deflate') return createInflate()
          if (encoding === 'br') return createBrotliDecompress()
          throw new ScrapeError('network')
        })
        if (decoders.length) {
          responseHeaders.delete('content-encoding')
          responseHeaders.delete('content-length')
        }
        body = new PassThrough({ highWaterMark: 16 * 1024 })
        body.once('end', cleanup)
        body.once('close', cleanup)
        pipeline([response, ...decoders, body], (error) => {
          if (error) fail(error)
        })
        const reader = (
          Readable.toWeb(body) as ReadableStream<Uint8Array>
        ).getReader()
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read()
              if (chunk.done) controller.close()
              else controller.enqueue(chunk.value)
            } catch (error) {
              const failure = networkFailure(error)
              stop(failure)
              controller.error(failure)
            }
          },
          async cancel(reason) {
            stop()
            await reader.cancel(reason).catch(() => {})
          },
        })
        const result = new Response(stream, {
          status,
          statusText: response.statusMessage,
          headers: responseHeaders,
        })
        Object.defineProperty(result, 'url', { value: url.href })
        settled = true
        resolve(result)
      } catch (error) {
        fail(error)
      }
    }
    try {
      request = (secure ? requestHttps : requestHttp)(
        endpoint,
        { ...options, signal },
        onResponse,
      )
      request.on('error', fail)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
      else request.end()
    } catch (error) {
      fail(error)
    }
  })
}
