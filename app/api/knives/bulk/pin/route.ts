import { NextResponse } from 'next/server'
import { getStorage } from '@/lib/storage'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const ids = body.ids
    const pinned = body.pinned

    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json(
        { error: 'ids must be a non-empty array' },
        { status: 400 },
      )
    }
    if (typeof pinned !== 'boolean') {
      return NextResponse.json(
        { error: 'pinned must be a boolean' },
        { status: 400 },
      )
    }

    const storage = getStorage()
    const knives = await storage.bulkUpdateKnives(ids, { pinned })
    return NextResponse.json({ knives })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    const status = message.includes('not found') ? 404 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
