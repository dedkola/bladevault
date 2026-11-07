import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { isProcessAlive } from '@/lib/process-liveness'

describe('isProcessAlive', () => {
  it('accepts the current process', () => {
    expect(isProcessAlive(process.pid, performance.timeOrigin)).toBe(true)
  })

  it('rejects a reused PID of the current process', () => {
    expect(isProcessAlive(process.pid, performance.timeOrigin - 1)).toBe(false)
  })

  it('rejects invalid IDs', () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(Number.NaN)).toBe(false)
  })

  it.skipIf(process.platform !== 'linux')(
    'rejects a thread ID even though kill(tid, 0) succeeds',
    () => {
      // Node always runs worker threads (V8 platform, libuv), so the current
      // process owns task IDs other than its PID.
      const threadId = fs
        .readdirSync('/proc/self/task')
        .map(Number)
        .find((id) => id !== process.pid)
      expect(threadId).toBeDefined()
      expect(() => process.kill(threadId!, 0)).not.toThrow()
      expect(isProcessAlive(threadId!)).toBe(false)
    },
  )
})
