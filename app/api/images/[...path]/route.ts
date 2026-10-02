import { requireAppUnlock, isAppLockEnabled } from '@/lib/app-lock'
import { NextResponse } from 'next/server'
import { getStorage } from '@/lib/storage'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const locked = requireAppUnlock(_request)
  if (locked) return locked

  try {
    const { path: segments } = await params
    const relativePath = segments.join('/')
    const storage = getStorage()
    const cacheControl = isAppLockEnabled()
      ? 'private, no-store'
      : 'public, max-age=31536000, immutable'

    if (storage.getImageStream) {
      const { stream, contentType } = await storage.getImageStream(relativePath)

      return new NextResponse(stream, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': cacheControl,
        },
      })
    }

    const { buffer, contentType } = await storage.getImage(relativePath)

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': cacheControl,
      },
    })
  } catch {
    return NextResponse.json({ error: 'Image not found' }, { status: 404 })
  }
}
