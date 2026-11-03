import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'
import {
  isScrapeErrorCode,
  ScrapeError,
  toScrapeError,
} from '@/lib/scrape-errors'
import { createScrapeOperation } from '@/lib/scrape-operation'

/** Keep the deadline active until the complete response body has been read. */
export async function requestScrape<T>(
  input: string,
  init?: RequestInit,
  options?: { timeoutMs?: number },
): Promise<T> {
  const operation = createScrapeOperation({
    signal: init?.signal ?? undefined,
    ...options,
  })
  try {
    return await operation.run(async () => {
      const response = await fetch(input, { ...init, signal: operation.signal })
      let data: T & { error?: string; code?: unknown }
      try {
        data = await readJsonResponse<T & { error?: string; code?: unknown }>(
          response,
        )
      } catch (error) {
        operation.remainingMs()
        const failure = toScrapeError(error)
        if (failure.code === 'network') throw failure
        throw new ScrapeError('invalid_response')
      }
      if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new ScrapeError('invalid_response')
      if (!response.ok) {
        const code = isScrapeErrorCode(data.code) ? data.code : 'unknown'
        throw new ScrapeError(
          code,
          getApiErrorMessage(data, new ScrapeError(code).message),
          response.status,
        )
      }
      return data
    })
  } catch (error) {
    throw toScrapeError(error)
  } finally {
    operation.dispose()
  }
}
