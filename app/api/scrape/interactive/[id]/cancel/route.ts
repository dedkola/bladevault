import { requireAppUnlock } from '@/lib/app-lock'
import { NextResponse } from 'next/server'
import { cancelInteractiveSession } from '@/lib/scrape-interactive'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const locked = requireAppUnlock(_request)
  if (locked) return locked

  try {
    const { id } = await params
    await cancelInteractiveSession(id)
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
