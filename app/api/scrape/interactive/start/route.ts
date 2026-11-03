import { requireAppUnlock } from '@/lib/app-lock'
import { NextResponse } from 'next/server'
import { startInteractiveSession } from '@/lib/scrape-interactive'
import { validateExternalUrl } from '@/lib/url-validation'
import { createScrapeOperation } from '@/lib/scrape-operation'
import { ScrapeError, scrapeErrorResponse } from '@/lib/scrape-errors'

export async function POST(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked

  const operation = createScrapeOperation({ signal: request.signal })
  try {
    return await operation.run(async () => {
      const body = await operation
        .run(() => request.json())
        .catch((error) => {
          if (error instanceof SyntaxError) throw new ScrapeError('invalid_url')
          throw error
        })
      const url = typeof body?.url === 'string' ? body.url.trim() : ''

      if (!url) throw new ScrapeError('invalid_url')

      const validation = await validateExternalUrl(url, {
        signal: operation.signal,
      })
      if (!validation.ok) {
        throw new ScrapeError(
          validation.code ??
            (validation.reason.includes('Private')
              ? 'blocked_url'
              : 'invalid_url'),
          validation.reason,
        )
      }

      const sessionId = await startInteractiveSession(
        validation.url.href,
        operation,
      )
      return NextResponse.json({ sessionId })
    })
  } catch (error) {
    return scrapeErrorResponse(error)
  } finally {
    operation.dispose()
  }
}
