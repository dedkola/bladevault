import fs from 'node:fs'
import { performance } from 'node:perf_hooks'

// On Linux, thread IDs share the PID namespace and `kill(tid, 0)` succeeds for
// them. In a container, a stale lease from an earlier run can name an ID that
// is now a thread of the current server, which would block restore forever.
function readLinuxThreadGroupId(pid: number): number | null | 'gone' {
  if (process.platform !== 'linux') return null
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
    const match = /^Tgid:\s*(\d+)/m.exec(status)
    return match ? Number(match[1]) : null
  } catch (error) {
    // Unknown /proc layouts fall back to the kill() result.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : null
  }
}

/**
 * Reports whether a lease owner process may still be running. `startedAt`
 * (the owner's `performance.timeOrigin`) detects reuse of our own PID.
 */
export function isProcessAlive(pid: number, startedAt?: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  if (
    pid === process.pid &&
    startedAt !== undefined &&
    startedAt !== performance.timeOrigin
  )
    return false
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false
  }
  const threadGroupId = readLinuxThreadGroupId(pid)
  if (threadGroupId === 'gone') return false
  return threadGroupId === null || threadGroupId === pid
}
