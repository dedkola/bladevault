import { spawnSync } from 'node:child_process'
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

const MONTHS = 'JanFebMarAprMayJunJulAugSepOctNovDec'
// Restore drains poll leases every 25 ms; a start time only changes when the
// ID is reused, so a short cache keeps that loop from spawning `ps` constantly.
const DARWIN_CACHE_TTL_MS = 1_000
const darwinStartCache = new Map<
  number,
  { at: number; value: number | 'gone' | null }
>()

// macOS has no /proc and recycles IDs too: a lease left by an app that quit
// with the vault open can name an unrelated system process weeks later.
function readDarwinStartedAtMs(pid: number): number | 'gone' | null {
  if (process.platform !== 'darwin') return null
  const cached = darwinStartCache.get(pid)
  if (cached && Date.now() - cached.at < DARWIN_CACHE_TTL_MS)
    return cached.value
  let value: number | 'gone' | null
  const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    timeout: 2_000,
  })
  // `ps -p` exits 1 with no rows when the ID is no longer in use.
  const output = result.stdout?.trim() ?? ''
  if (result.status === 1 && !output) value = 'gone'
  else {
    // e.g. "Thu Nov 12 08:23:05 2026" in UTC, with whole-second precision.
    const match =
      /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(
        output,
      )
    const month = match ? MONTHS.indexOf(match[1]) : -1
    value =
      match && month >= 0 && month % 3 === 0
        ? Date.UTC(
            Number(match[6]),
            month / 3,
            Number(match[2]),
            Number(match[3]),
            Number(match[4]),
            Number(match[5]),
          )
        : null
  }
  darwinStartCache.set(pid, { at: Date.now(), value })
  return value
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
  const darwinStartedAtMs = readDarwinStartedAtMs(pid)
  if (darwinStartedAtMs === 'gone') return false
  if (darwinStartedAtMs !== null)
    return (
      writtenAtMs === undefined ||
      writtenAtMs >= darwinStartedAtMs - START_TIME_TOLERANCE_MS
    )
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
