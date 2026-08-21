import { timingSafeEqual } from 'node:crypto'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { createBladeVaultMcpServer } from '@/lib/mcp/create-server'
import { recordMcpHttpRequest } from '@/lib/mcp/activity'
import { getMcpAuthToken, isMcpEnabled } from '@/lib/mcp/config'

const handler = createMcpHandler(() => createBladeVaultMcpServer('http'), {
  onerror(error) {
    console.error('[bladevault-mcp]', error)
  },
})

function unauthorized(): Response {
  return Response.json(
    { error: 'A valid MCP bearer token is required.' },
    {
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' },
    },
  )
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  )
}

function allowedHost(request: Request): boolean {
  const configured = process.env.MCP_ALLOWED_HOSTS?.split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  const allowed = configured?.length
    ? configured
    : ['localhost', '127.0.0.1', '[::1]']
  const host = request.headers.get('host')?.toLowerCase()
  if (!host) return false
  const hostname = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':')[0]
  return allowed.includes(host) || allowed.includes(hostname)
}

function localHost(request: Request): boolean {
  const host = request.headers.get('host')?.toLowerCase()
  if (!host) return false
  const hostname = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':')[0]
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
}

function allowedOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true
  const configured = process.env.MCP_ALLOWED_ORIGINS?.split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (configured?.length) return configured.includes(origin)

  try {
    const url = new URL(origin)
    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  } catch {
    return false
  }
}

export async function handleMcpHttpRequest(
  request: Request,
): Promise<Response> {
  if (!isMcpEnabled()) {
    return Response.json({ error: 'Not found' }, { status: 404 })
  }
  if (!allowedOrigin(request)) {
    return Response.json(
      { error: 'Forbidden MCP request origin.' },
      { status: 403 },
    )
  }

  const auth = getMcpAuthToken()
  const authorization = request.headers.get('authorization') || ''
  const actual = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : ''
  const authenticated = Boolean(actual && tokenMatches(actual, auth.token))
  const isLocal = localHost(request)

  if (!allowedHost(request) && !authenticated) return unauthorized()
  if ((auth.managedByEnvironment || !isLocal) && !authenticated) {
    return unauthorized()
  }

  recordMcpHttpRequest()
  return handler.fetch(request)
}
