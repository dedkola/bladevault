import { NextResponse } from 'next/server'
import { getStorage } from '@/lib/storage'
import { dockerJsonResponse } from '@/lib/server-json-response'

export async function GET(request = new Request('http://localhost/api/logs')) {
  try {
    const events = await getStorage().getAuditLog()
    return await dockerJsonResponse(
      request,
      { events },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
