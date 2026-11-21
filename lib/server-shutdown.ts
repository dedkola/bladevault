/**
 * How the server process ends (installed from instrumentation.ts).
 *
 * Next's own SIGTERM/SIGINT handler closes the HTTP server and waits for
 * every open connection to finish before it exits. In production it never
 * drops idle keep-alive or MCP client connections, so the process can stay
 * up indefinitely after the desktop app quits, keep the vault open and keep
 * running the price worker of an outdated build. Here a signal stops the
 * price worker, releases its lease and exits shortly after, whatever Next
 * is still waiting for. A desktop server whose app process is gone (the app
 * crashed or was killed, so no signal came) shuts itself down the same way.
 */

export const WORKER_STOP_MS = 2000
/** Time Next gets to finish requests after the worker stopped. */
export const EXIT_GRACE_MS = 1500
export const PARENT_POLL_MS = 5000

export type ShutdownReason = 'SIGTERM' | 'SIGINT' | 'parent-exited'

const EXIT_CODES: Record<ShutdownReason, number> = {
  SIGINT: 130,
  SIGTERM: 143,
  'parent-exited': 0,
}

export type ServerShutdownDeps = {
  /** Stops the price worker and releases its lease within `timeoutMs`. */
  stopWorker: (timeoutMs: number) => Promise<void>
  exit: (code: number) => void
  setTimer: (callback: () => void, ms: number) => unknown
  /** Whether a process with this id is still running. */
  isAlive: (pid: number) => boolean
  log: (message: string) => void
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists but belongs to someone else (a reused id); treat it
    // as gone only when it does not exist at all.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const realDeps: Omit<ServerShutdownDeps, 'stopWorker'> = {
  exit: (code) => process.exit(code),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  isAlive: processIsAlive,
  log: (message) => console.log(`[bladevault-server] ${message}`),
}

export function createServerShutdown(
  deps: Pick<ServerShutdownDeps, 'stopWorker'> & Partial<ServerShutdownDeps>,
) {
  const { stopWorker, exit, setTimer, log } = { ...realDeps, ...deps }
  let shutdown: Promise<void> | null = null
  return (reason: ShutdownReason): Promise<void> => {
    shutdown ??= (async () => {
      log(`Shutting down (${reason}).`)
      try {
        await stopWorker(WORKER_STOP_MS)
      } catch (error) {
        console.error(
          '[bladevault-server] Could not stop the price worker',
          error,
        )
      }
      await new Promise<void>((resolve) => setTimer(resolve, EXIT_GRACE_MS))
      exit(EXIT_CODES[reason])
    })()
    return shutdown
  }
}

const INSTALLED = Symbol.for('bladevault.server-shutdown')

/**
 * Handles SIGTERM/SIGINT and, when `parentPid` is set (the desktop app's
 * process), watches for the parent to go away. Installs once per process.
 */
export function installServerShutdown(
  deps: Pick<ServerShutdownDeps, 'stopWorker'> & {
    parentPid?: number | null
  } & Partial<ServerShutdownDeps>,
) {
  const scope = globalThis as typeof globalThis & { [INSTALLED]?: boolean }
  if (scope[INSTALLED]) return
  scope[INSTALLED] = true
  const shutdown = createServerShutdown(deps)
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))

  const parentPid = deps.parentPid
  if (!parentPid || !Number.isInteger(parentPid) || parentPid <= 1) return
  const isAlive = deps.isAlive ?? realDeps.isAlive
  const watch = setInterval(() => {
    if (isAlive(parentPid)) return
    clearInterval(watch)
    void shutdown('parent-exited')
  }, PARENT_POLL_MS)
  watch.unref?.()
}
