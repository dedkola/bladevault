import { requireAppUnlock } from '@/lib/app-lock'
import { NextResponse } from 'next/server'
import { captureInteractiveSession } from '@/lib/scrape-interactive'
import { scrapeAndEnrichProduct } from '@/lib/scrape'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const locked = requireAppUnlock(_request)
  if (locked) return locked

  try {
    const { id } = await params
    const { html, finalUrl, screenshot, screenshotWarning } =
      await captureInteractiveSession(id)
    const result = await scrapeAndEnrichProduct(html, finalUrl, finalUrl)
    if (screenshot) result.product.images.push(screenshot)
    return NextResponse.json({ ...result, screenshotWarning })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
