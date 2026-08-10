import { NextResponse } from 'next/server'
import { getStorage } from '@/lib/storage'

function normalizeEtag(value: string) {
  return value.startsWith('W/') ? value.slice(2) : value
}

function matchesIfNoneMatch(headerValue: string | null, etag: string) {
  if (!headerValue) return false

  return headerValue.split(',').some((candidate) => {
    const trimmed = candidate.trim()
    return trimmed === '*' || normalizeEtag(trimmed) === normalizeEtag(etag)
  })
}

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

    if (etag && matchesIfNoneMatch(request.headers.get('if-none-match'), etag)) {
      const headers: Record<string, string> = {
        ETag: etag,
        'Cache-Control': 'public, max-age=31536000, immutable',
      }
      if (lastModified) headers['Last-Modified'] = lastModified

      return new NextResponse(null, {
        status: 304,
        headers,
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
