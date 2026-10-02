import { requireAppUnlock } from '@/lib/app-lock'
import { NextResponse } from 'next/server'
import { getInteractiveSessionStatus } from '@/lib/scrape-interactive'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const locked = requireAppUnlock(_request)
  if (locked) return locked

  try {
    const { id } = await params
    const status = await getInteractiveSessionStatus(id)
    return NextResponse.json(status)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
