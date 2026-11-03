import { afterEach, describe, expect, it, vi } from 'vitest'
import { createScrapeOperation } from '@/lib/scrape-operation'

describe('scrape operation deadlines', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('times out work that never settles and aborts its signal', async () => {
    vi.useFakeTimers()
    const operation = createScrapeOperation({ timeoutMs: 100 })
    const result = operation.run(() => new Promise(() => {}))
    const failed = expect(result).rejects.toMatchObject({ code: 'timeout' })

    await vi.advanceTimersByTimeAsync(100)

    await failed
    expect(operation.signal.aborted).toBe(true)
    operation.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shares one deadline across stages rather than restarting for a fallback', async () => {
    vi.useFakeTimers()
    const operation = createScrapeOperation({ timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(70)
    await expect(operation.run(async () => 'first stage')).resolves.toBe(
      'first stage',
    )
    const fallback = operation.run(() => new Promise(() => {}))
    const failed = expect(fallback).rejects.toMatchObject({ code: 'timeout' })

    await vi.advanceTimersByTimeAsync(30)

    await failed
    expect(() => operation.remainingMs()).toThrow()
    operation.dispose()
  })

  it('stops promptly when its caller cancels without waiting for the deadline', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const operation = createScrapeOperation({
      signal: controller.signal,
      timeoutMs: 100,
    })
    const result = operation.run(() => new Promise(() => {}))
    const failed = expect(result).rejects.toMatchObject({ code: 'cancelled' })

    controller.abort()

    await failed
    expect(operation.signal.aborted).toBe(true)
    operation.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not start work for a request that was already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const operation = createScrapeOperation({ signal: controller.signal })
    const work = vi.fn(async () => 'late result')

    await expect(operation.run(work)).rejects.toMatchObject({
      code: 'cancelled',
    })
    expect(work).not.toHaveBeenCalled()
    operation.dispose()
  })

  it('treats a custom caller abort reason as cancellation', async () => {
    const controller = new AbortController()
    controller.abort(new Error('Client disconnected'))
    const operation = createScrapeOperation({ signal: controller.signal })
    await expect(operation.run(async () => 'unused')).rejects.toMatchObject({
      code: 'cancelled',
    })
    operation.dispose()
  })

  it('releases its deadline timer after a successful operation', async () => {
    vi.useFakeTimers()
    const operation = createScrapeOperation({ timeoutMs: 100 })

    await expect(operation.run(async () => 'product')).resolves.toBe('product')
    operation.dispose()

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(operation.signal.aborted).toBe(false)
  })
})
