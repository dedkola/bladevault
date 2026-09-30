import { NextResponse } from 'next/server'
import { getStorage } from '@/lib/storage'
import { dockerJsonResponse } from '@/lib/server-json-response'

export async function GET(
  request = new Request('http://localhost/api/activity'),
) {
  try {
    const activity = await getStorage().getKnifeActivity()
    return await dockerJsonResponse(request, { activity })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
