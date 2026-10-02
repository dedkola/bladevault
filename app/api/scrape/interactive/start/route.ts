import { requireAppUnlock } from '@/lib/app-lock'
import { NextResponse } from 'next/server'
import { startInteractiveSession } from '@/lib/scrape-interactive'
import { validateExternalUrl } from '@/lib/url-validation'

export async function POST(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked

  try {
    const body = await request.json()
    const url = typeof body.url === 'string' ? body.url.trim() : ''

    if (!url) {
      return NextResponse.json({ error: 'URL is required' }, { status: 400 })
    }

    const validation = await validateExternalUrl(url)
    if (!validation.ok) {
      return NextResponse.json({ error: validation.reason }, { status: 400 })
    }

    const sessionId = await startInteractiveSession(validation.url.href)
    return NextResponse.json({ sessionId })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
