import fs from 'node:fs'
import { performance } from 'node:perf_hooks'

// Linux reports /proc start times in USER_HZ ticks, which is 100 on every
// mainstream architecture.
const CLOCK_TICKS_PER_SECOND = 100
// Covers whole-second boot time rounding and coarse filesystem timestamps.
const START_TIME_TOLERANCE_MS = 2_000

let bootTimeMs: number | null | undefined

function readBootTimeMs(): number | null {
  if (bootTimeMs !== undefined) return bootTimeMs
  try {
    const match = /^btime\s+(\d+)/m.exec(fs.readFileSync('/proc/stat', 'utf8'))
    bootTimeMs = match ? Number(match[1]) * 1000 : null
  } catch {
    bootTimeMs = null
  }
  return bootTimeMs
}

type LinuxProcessInfo = {
  threadGroupId: number | null
  startedAtMs: number | null
}

// Containers reuse small IDs across runs, so a lease left by an earlier run can
// name an ID that now belongs to something else. On Linux, thread IDs share the
// PID namespace and `kill(tid, 0)` succeeds for them too.
function readLinuxProcessInfo(pid: number): LinuxProcessInfo | 'gone' | null {
  if (process.platform !== 'linux') return null
  let status: string
  try {
    status = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
  } catch (error) {
    // Unknown /proc layouts fall back to the kill() result.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : null
  }
  const tgid = /^Tgid:\s*(\d+)/m.exec(status)
  let startedAtMs: number | null = null
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    // Field 22 (starttime); the command name in field 2 may contain spaces.
    const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19])
    const boot = readBootTimeMs()
    if (boot !== null && Number.isFinite(ticks))
      startedAtMs = boot + (ticks * 1000) / CLOCK_TICKS_PER_SECOND
  } catch {}
  return { threadGroupId: tgid ? Number(tgid[1]) : null, startedAtMs }
}

/**
 * Reports whether a lease owner process may still be running. `startedAt`
 * (the owner's `performance.timeOrigin`) detects reuse of our own PID, and
 * `writtenAtMs` (the lease file's modification time) rejects a process that
 * started after the lease was written, so it cannot be the lease's owner.
 */
export function isProcessAlive(
  pid: number,
  startedAt?: number,
  writtenAtMs?: number,
): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  if (pid === process.pid && startedAt !== undefined)
    return startedAt === performance.timeOrigin
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false
  }
  const info = readLinuxProcessInfo(pid)
  if (info === 'gone') return false
  if (!info) return true
  if (info.threadGroupId !== null && info.threadGroupId !== pid) return false
  if (
    writtenAtMs !== undefined &&
    info.startedAtMs !== null &&
    writtenAtMs < info.startedAtMs - START_TIME_TOLERANCE_MS
  )
    return false
  return true
}

/** `isProcessAlive` for an owner recorded in `filePath`, using its age. */
export function isLeaseOwnerAlive(
  filePath: string,
  pid: number,
  startedAt?: number,
): boolean {
  let writtenAtMs: number | undefined
  try {
    writtenAtMs = fs.statSync(filePath).mtimeMs
  } catch {}
  return isProcessAlive(pid, startedAt, writtenAtMs)
}
