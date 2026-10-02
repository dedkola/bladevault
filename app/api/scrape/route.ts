import { requireAppUnlock } from '@/lib/app-lock'
import { NextResponse } from 'next/server'
import { scrapeAndEnrichProduct } from '@/lib/scrape'
import { fetchExternalUrl, validateExternalUrl } from '@/lib/url-validation'

export async function POST(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked

  try {
    const body = await request.json()
    const url = typeof body.url === 'string' ? body.url.trim() : ''

    if (!url) {
      return NextResponse.json({ error: 'URL is required' }, { status: 400 })
    }

    const validation = await validateExternalUrl(url)
    if (!validation.ok) {
      return NextResponse.json({ error: validation.reason }, { status: 400 })
    }

    const normalizedUrl = validation.url.href

    let html: string
    let finalUrl: string
    let screenshot: string | undefined
    let screenshotWarning: string | undefined

    try {
      const { fetchRenderedHtml } = await import('@/lib/scrape-playwright')
      const rendered = await fetchRenderedHtml(normalizedUrl)
      html = rendered.html
      finalUrl = rendered.finalUrl
      screenshot = rendered.screenshot
      screenshotWarning = rendered.screenshotWarning
    } catch (renderError) {
      // Playwright can time out on pages with heavy/never-ending network activity.
      // Many Shopify stores still render the product HTML server-side, so fall
      // back to a plain HTTP fetch before giving up.
      const response = await fetchExternalUrl(validation.url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      })

      if (!response.ok) {
        throw renderError
      }

      screenshotWarning =
        'Product details were imported using the HTML fallback. A webpage screenshot could not be captured; you can retry from the saved item.'
      html = await response.text()
      finalUrl = response.url
    }

    const result = await scrapeAndEnrichProduct(html, finalUrl, normalizedUrl)
    if (screenshot) result.product.images.push(screenshot)
    return NextResponse.json({ ...result, screenshotWarning })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
