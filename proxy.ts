import { NextResponse, type NextRequest } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname
  if (
    pathname === '/unlock' ||
    pathname === '/api/app-lock' ||
    pathname === '/mcp'
  )
    return NextResponse.next()
  const locked = requireAppUnlock(request)
  if (!locked) return NextResponse.next()
  if (pathname.startsWith('/api/') || pathname === '/_next/image') return locked
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
