import { NextResponse } from 'next/server'
import { getStorage } from '@/lib/storage'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const storage = getStorage()
    const knife = await storage.duplicateKnife(id)
    return NextResponse.json({ knife })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    const status = message.includes('not found') ? 404 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
