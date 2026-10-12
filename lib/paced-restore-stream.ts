import { Transform, type TransformCallback } from 'node:stream'

const RESTORE_BYTES_PER_SECOND = 2 * 1024 * 1024

// Bound restore I/O and yield between chunks so foreground reads remain useful.
export class PacedRestoreStream extends Transform {
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(private readonly maximumBytes = Number.MAX_SAFE_INTEGER) {
    super({ highWaterMark: 64 * 1024 })
  }
  private bytes = 0

  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ) {
    this.bytes += chunk.length
    if (this.bytes > this.maximumBytes) {
      callback(new Error('Backup archive exceeds the supported restore size.'))
      return
    }
    this.timer = setTimeout(
      () => {
        this.timer = null
        callback(null, chunk)
      },
      Math.max(1, Math.ceil((chunk.length / RESTORE_BYTES_PER_SECOND) * 1000)),
    )
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    callback(error)
  }
}
