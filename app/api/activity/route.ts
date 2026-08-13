import { NextResponse } from 'next/server'
import { getStorage } from '@/lib/storage'

export async function GET() {
  try {
    const activity = await getStorage().getKnifeActivity()
    return NextResponse.json({ activity })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
