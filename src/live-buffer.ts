/** Demand-owned UTF-8 tail for one in-flight turn. Readers pull the latest revision; no frame queues. @module */
export type LiveFrame = { kind: 'snapshot'; text: string; truncated: boolean; seq: number } | { kind: 'settled'; seq: number }
export interface LiveSubscription { frames: AsyncIterable<LiveFrame>; close(): void }

const LIMIT = 64 * 1024
const INTERVAL = 150
interface Reader {
  initial?: LiveFrame
  seen: number
  nextAt: number
  wake?: () => void
}

/** One shared byte ring and at most one wake-up timer for all readers of a turn. */
export class LiveBuffer {
  private bytes = Buffer.allocUnsafe(LIMIT)
  private end = 0
  private size = 0
  private truncated = false
  private high = ''
  private seq = 0
  private cached?: LiveFrame
  private readonly readers = new Set<Reader>()
  private timer?: ReturnType<typeof setTimeout>
  private ended = false

  constructor(initial: string, private readonly onEmpty: () => void) { this.append(initial) }

  /** Append a delta without making a frame for each token. */
  append(chunk: string): void {
    if (this.ended || !chunk) return
    // At most LIMIT UTF-16 units need encoding, even for a multi-megabyte initial report.
    if (chunk.length > LIMIT) this.truncated = true
    const text = chunk.length > LIMIT ? chunk.slice(-LIMIT) : this.high + chunk
    const last = text.charCodeAt(text.length - 1)
    this.high = last >= 0xd800 && last <= 0xdbff ? text.slice(-1) : ''
    const encoded = Buffer.from(this.high ? text.slice(0, -1) : text)
    const tail = encoded.subarray(-LIMIT)
    if (encoded.length + this.size > LIMIT) this.truncated = true
    const first = tail.copy(this.bytes, this.end)
    tail.copy(this.bytes, 0, first)
    this.size = Math.min(LIMIT, this.size + tail.length)
    this.end = (this.end + tail.length) % LIMIT
    ++this.seq
    this.cached = undefined
    this.schedule()
  }

  private snapshot(): LiveFrame {
    if (this.cached) return this.cached
    const start = (this.end - this.size + LIMIT) % LIMIT
    const first = Math.min(LIMIT - start, this.size)
    const all = Buffer.concat([this.bytes.subarray(start, start + first), this.bytes.subarray(0, this.size - first), Buffer.from(this.high)])
    let offset = Math.max(0, all.length - LIMIT)
    while (offset < all.length && (all[offset]! & 0xc0) === 0x80) ++offset
    return this.cached = { kind: 'snapshot', text: all.toString('utf8', offset), truncated: this.truncated || offset > 0, seq: this.seq }
  }

  private schedule(): void {
    if (this.timer || this.ended) return
    let earliest = Infinity
    for (const reader of this.readers) {
      if (reader.wake && reader.seen !== this.seq) earliest = Math.min(earliest, reader.nextAt)
    }
    if (earliest === Infinity) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      for (const reader of this.readers) reader.wake?.()
    }, Math.max(0, Math.ceil(earliest - performance.now())))
    this.timer.unref?.()
  }

  /** Capture the opening snapshot now and make cancellation safe even between iterator pulls. */
  subscribe(): LiveSubscription {
    const reader: Reader = { initial: this.snapshot(), seen: this.seq, nextAt: 0 }
    this.readers.add(reader)
    const close = () => {
      if (!this.readers.delete(reader)) return
      reader.initial = undefined
      reader.wake?.()
      if (!this.readers.size) {
        clearTimeout(this.timer)
        this.timer = undefined
        this.ended = true
        this.cached = undefined
        this.bytes = Buffer.alloc(0)
        this.high = ''
        this.onEmpty()
      }
    }
    return { frames: this.frames(reader, close), close }
  }

  private async *frames(reader: Reader, close: () => void): AsyncGenerator<LiveFrame> {
    try {
      if (reader.initial) {
        const initial = reader.initial
        reader.initial = undefined
        reader.nextAt = performance.now() + INTERVAL
        yield initial
      }
      while (this.readers.has(reader)) {
        if (this.ended) { yield { kind: 'settled', seq: this.seq }; return }
        const now = performance.now()
        if (reader.seen !== this.seq && now >= reader.nextAt) {
          reader.seen = this.seq
          const frame = this.snapshot()
          reader.nextAt = performance.now() + INTERVAL
          yield frame
        } else {
          const pending = Promise.withResolvers<void>()
          reader.wake = pending.resolve
          this.schedule()
          await pending.promise
          reader.wake = undefined
        }
      }
    } finally { close() }
  }

  /** Wake all readers immediately; the turn log is now authoritative. */
  settle(): void {
    this.ended = true
    ++this.seq
    clearTimeout(this.timer)
    this.timer = undefined
    for (const reader of this.readers) reader.wake?.()
  }
}
