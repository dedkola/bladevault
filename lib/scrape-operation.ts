import {
  SCRAPE_TIMEOUT_MS,
  ScrapeError,
  toScrapeError,
} from '@/lib/scrape-errors'

/** Also bounds APIs such as DNS and body reads that may ignore cancellation. */
export async function runWithSignal<T>(
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  if (!signal) return work()
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => {
      cleanup()
      reject(toScrapeError(signal.reason))
    }
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted()
        return work()
      })
      .then(
        (value) => {
          cleanup()
          resolve(value)
        },
        (error) => {
          cleanup()
          reject(error)
        },
      )
  })
}

export class ScrapeOperation {
  private readonly controller = new AbortController()
  private readonly deadline: number
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly parent?: AbortSignal
  private readonly onParentAbort: () => void
  private readonly timeoutError: ScrapeError

  constructor({
    signal,
    timeoutMs = SCRAPE_TIMEOUT_MS,
  }: { signal?: AbortSignal; timeoutMs?: number } = {}) {
    this.deadline = Date.now() + timeoutMs
    this.timeoutError = new ScrapeError(
      'timeout',
      timeoutMs === SCRAPE_TIMEOUT_MS
        ? undefined
        : `The request did not finish within ${Math.ceil(timeoutMs / 1000)} seconds. Try again or check that the website and BladeVault server are available.`,
    )
    this.parent = signal
    this.onParentAbort = () => {
      const failure = toScrapeError(signal?.reason)
      this.abort(
        failure.code === 'unknown' ? new ScrapeError('cancelled') : failure,
      )
    }
    this.timer = setTimeout(() => this.abort(this.timeoutError), timeoutMs)
    this.timer.unref?.()
    if (signal?.aborted) this.onParentAbort()
    else signal?.addEventListener('abort', this.onParentAbort, { once: true })
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  remainingMs(): number {
    if (!this.signal.aborted && Date.now() >= this.deadline)
      this.abort(this.timeoutError)
    if (this.signal.aborted) throw toScrapeError(this.signal.reason)
    return Math.max(1, this.deadline - Date.now())
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    this.remainingMs()
    return runWithSignal(this.signal, work)
  }

  abort(reason: Error = new ScrapeError('cancelled')): void {
    this.controller.abort(reason)
  }

  dispose(): void {
    clearTimeout(this.timer)
    this.parent?.removeEventListener('abort', this.onParentAbort)
  }
}

export function createScrapeOperation(options?: {
  signal?: AbortSignal
  timeoutMs?: number
}): ScrapeOperation {
  return new ScrapeOperation(options)
}
