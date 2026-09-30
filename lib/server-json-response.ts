import { gzip } from 'node:zlib'
import { promisify } from 'node:util'

const gzipAsync = promisify(gzip)
const MINIMUM_COMPRESSION_BYTES = 1_024

function acceptsGzip(value: string | null): boolean {
  if (!value) return false

  const encodings = value.split(',').map((entry) => {
    const [encoding, ...parameters] = entry.trim().toLowerCase().split(';')
    const quality = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => parameter.startsWith('q='))
    return {
      encoding,
      quality: quality ? Number(quality.slice(2)) : 1,
    }
  })

  const gzip = encodings.find((entry) => entry.encoding === 'gzip')
  if (gzip) return gzip.quality > 0

  return Boolean(
    encodings.find((entry) => entry.encoding === '*' && entry.quality > 0),
  )
}

function appendVary(headers: Headers, value: string) {
  const existing = headers.get('Vary')
  const values = new Set(
    existing
      ?.split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  values.add(value)
  headers.set('Vary', [...values].join(', '))
}

export async function dockerJsonResponse(
  request: Request,
  payload: unknown,
  init: ResponseInit = {},
): Promise<Response> {
  const body = JSON.stringify(payload)
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  if (!headers.has('Cache-Control')) {
    headers.set('Cache-Control', 'private, no-store')
  }

  const shouldCompress =
    process.env.BLADEVAULT_DOCKER_RUNTIME === '1' &&
    Buffer.byteLength(body) >= MINIMUM_COMPRESSION_BYTES &&
    acceptsGzip(request.headers.get('Accept-Encoding'))

  if (!shouldCompress) {
    return new Response(body, { ...init, headers })
  }

  const compressed = await gzipAsync(body, { level: 1 })
  appendVary(headers, 'Accept-Encoding')
  headers.set('Content-Encoding', 'gzip')
  headers.set('Content-Length', String(compressed.byteLength))

  return new Response(compressed, { ...init, headers })
}
