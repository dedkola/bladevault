import { NextResponse } from 'next/server'
import { getStorage } from '@/lib/storage'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path: segments } = await params
    const relativePath = segments.join('/')
    const storage = getStorage()
    const { buffer, contentType, etag, lastModified } =
      await storage.getImage(relativePath)

    if (etag && request.headers.get('if-none-match') === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          ETag: etag,
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      })
    }

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    }
    if (etag) headers.ETag = etag
    if (lastModified) headers['Last-Modified'] = lastModified

    return new NextResponse(new Uint8Array(buffer), { headers })
  } catch {
    return NextResponse.json({ error: 'Image not found' }, { status: 404 })
  }
}
