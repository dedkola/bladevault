import { Transform, type TransformCallback } from 'node:stream'

// Enforce archive size limits without delaying transfer chunks.
export class RestoreSizeLimitStream extends Transform {
  constructor(private readonly maximumBytes: number) {
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
    callback(null, chunk)
  }
}
