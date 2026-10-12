import { NextResponse, type NextRequest } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import {
  assertVaultGeneration,
  getVaultAccessState,
  VAULT_GENERATION_HEADER,
  VaultAccessError,
  vaultAccessErrorResponse,
} from '@/lib/vault-access'

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname
  if (
    pathname === '/unlock' ||
    pathname === '/api/app-lock' ||
    pathname === '/mcp'
  )
    return NextResponse.next()
  try {
    const locked = requireAppUnlock(request)
    if (!locked) {
      const state = getVaultAccessState()
      const statusRoute =
        pathname === '/api/vault/status' ||
        pathname === '/api/cloud-backup/restore-job'
      if (state.phase === 'switching' && !statusRoute)
        throw new VaultAccessError('VAULT_RESTORE_BUSY', state)
      const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
      if (mutation && !statusRoute) {
        const expected = request.headers.get(VAULT_GENERATION_HEADER)
        if (expected) assertVaultGeneration(expected)
        if (state.readOnly)
          throw new VaultAccessError('VAULT_RESTORE_BUSY', state)
      }
      const response = NextResponse.next()
      response.headers.set(VAULT_GENERATION_HEADER, state.generation)
      return response
    }
    if (pathname.startsWith('/api/') || pathname === '/_next/image')
      return locked
  } catch (error) {
    const busy = vaultAccessErrorResponse(error)
    if (busy) {
      if (
        !pathname.startsWith('/api/') &&
        pathname !== '/_next/image' &&
        error instanceof VaultAccessError &&
        error.state.phase === 'switching'
      ) {
        // A navigation can arrive before the current tab observes the switch.
        // Retry the same URL, rather than displaying an API error as a page.
        const headers = new Headers(busy.headers)
        headers.set('Content-Type', 'text/html; charset=utf-8')
        return new Response(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${error.state.recoveryRequired ? '' : '<meta http-equiv="refresh" content="1">'}<title>BladeVault | Applying restored vault</title><style>html{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:14px system-ui,sans-serif}main{max-width:30rem;padding:2rem;text-align:center}</style></head><body><main role="status" aria-live="polite">${error.state.recoveryRequired ? 'Restart BladeVault to retry recovery. Your existing data is protected.' : 'Applying restored vault…'}</main></body></html>`,
          { status: 503, headers },
        )
      }
      return busy
    }
    throw error
  }
  const protocol =
    request.headers.get('x-forwarded-proto') === 'https'
      ? 'https:'
      : request.nextUrl.protocol
  const host = request.headers.get('host') || request.nextUrl.host
  const url = new URL('/unlock', `${protocol}//${host}`)
  url.searchParams.set('next', `${pathname}${request.nextUrl.search}`)
  const response = NextResponse.redirect(url)
  response.headers.set('Cache-Control', 'no-store')
  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/webpack-hmr|favicon.ico|icon.svg).*)'],
}
