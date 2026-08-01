import { describe, expect, it } from 'vitest'
import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'

describe('API response helpers', () => {
  it('parses JSON and treats an empty response as an empty object', async () => {
    await expect(
      readJsonResponse<{ ok: boolean }>(
        new Response(JSON.stringify({ ok: true })),
      ),
    ).resolves.toEqual({ ok: true })
    await expect(readJsonResponse(new Response(''))).resolves.toEqual({})
  })

  it('reports invalid server responses with status and a bounded preview', async () => {
    const response = new Response(`<html>${'broken '.repeat(40)}</html>`, {
      status: 502,
    })
    await expect(readJsonResponse(response)).rejects.toThrow(
      /invalid server response \(HTTP 502\).*\.\.\./,
    )
  })

  it('uses supported error shapes before the fallback', () => {
    expect(getApiErrorMessage({ error: 'first' }, 'fallback')).toBe('first')
    expect(getApiErrorMessage({ message: 'second' }, 'fallback')).toBe('second')
    expect(
      getApiErrorMessage({ details: { message: 'third' } }, 'fallback'),
    ).toBe('third')
    expect(getApiErrorMessage(null, 'fallback')).toBe('fallback')
  })
})
