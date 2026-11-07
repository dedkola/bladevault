import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it } from 'vitest'
import { isLeaseOwnerAlive, isProcessAlive } from '@/lib/process-liveness'

const isLinux = process.platform === 'linux'
let child: ChildProcess | null = null
let directory: string | null = null

afterEach(() => {
  child?.kill('SIGKILL')
  child = null
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
  directory = null
})

function startChild(): number {
  child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  return child.pid!
}

function writeLease(ageMs: number): string {
  directory ??= fs.mkdtempSync(path.join(os.tmpdir(), 'bladevault-liveness-'))
  const filePath = path.join(directory, `${ageMs}.json`)
  fs.writeFileSync(filePath, '{}')
  const writtenAt = new Date(Date.now() - ageMs)
  fs.utimesSync(filePath, writtenAt, writtenAt)
  return filePath
}

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

  it.skipIf(!isLinux)(
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

describe('isLeaseOwnerAlive', () => {
  it('accepts a lease written by a running process', () => {
    const pid = startChild()
    expect(isLeaseOwnerAlive(writeLease(0), pid)).toBe(true)
  })

  it('treats a missing lease file as unknown age', () => {
    const pid = startChild()
    expect(isLeaseOwnerAlive('/nonexistent/lease.json', pid)).toBe(true)
  })

  it.skipIf(!isLinux)(
    'rejects a lease written before the process with that ID started',
    () => {
      // Mirrors a container restart where the old server's ID now belongs to
      // another process, such as Xvfb or docker-init.
      const pid = startChild()
      expect(isLeaseOwnerAlive(writeLease(60_000), pid)).toBe(false)
    },
  )
})
