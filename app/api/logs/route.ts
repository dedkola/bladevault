import { NextResponse } from 'next/server'
import { getStorage } from '@/lib/storage'

export async function GET() {
  try {
    const events = await getStorage().getAuditLog()
    return NextResponse.json({ events })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
