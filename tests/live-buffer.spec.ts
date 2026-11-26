import { afterEach, expect, it, vi } from 'vitest'
import { LiveBuffer } from '../src/live-buffer.ts'

afterEach(() => vi.useRealTimers())

it('keeps a valid UTF-8 suffix within 64 KiB across both wraparound and split surrogate pairs', async () => {
  vi.useFakeTimers()
  const text = 'ab中🙂'.repeat(18000)
  const b = new LiveBuffer(text, () => {})
  b.append('\ud83d')
  b.append('\ude42')
  const s = b.subscribe()
  const it = s.frames[Symbol.asyncIterator]()
  const frame = (await it.next()).value
  expect(frame.kind).toBe('snapshot')
  expect(frame.truncated).toBe(true)
  expect(Buffer.byteLength(frame.text)).toBeLessThanOrEqual(65536)
  expect(frame.text).not.toContain('\ufffd')
  expect((text + '🙂').endsWith(frame.text)).toBe(true)
  expect(frame.text.endsWith('🙂')).toBe(true)
  s.close()
})

it('coalesces 100 chunks of 1 KiB at 5ms spacing, with no ordinary frame closer than 150ms', async () => {
  vi.useFakeTimers({ now: 0 })
  const b = new LiveBuffer('', () => {})
  const s = b.subscribe()
  const frames: { t: number; bytes: number }[] = []
  const read = (async () => {
    for await (const frame of s.frames) {
      if (frame.kind === 'snapshot') frames.push({ t: Date.now(), bytes: Buffer.byteLength(frame.text) })
    }
  })()
  await vi.advanceTimersByTimeAsync(0)
  for (let i = 0; i < 100; ++i) {
    await vi.advanceTimersByTimeAsync(5)
    b.append('x'.repeat(1024))
  }
  await vi.advanceTimersByTimeAsync(110)
  b.settle()
  await read
  expect(frames.map(f => f.t)).toEqual([0, 150, 300, 450, 600])
  expect(frames.at(-1)?.bytes).toBe(65536)
  console.log('100 chunks:', JSON.stringify(frames))
  expect(vi.getTimerCount()).toBe(0)
})

it('shares one timer, releases a pending reader on close, and drops the last subscription', async () => {
  vi.useFakeTimers()
  const empty = vi.fn()
  const b = new LiveBuffer('', empty)
  expect(vi.getTimerCount()).toBe(0)
  const a = b.subscribe(), c = b.subscribe()
  const first = a.frames[Symbol.asyncIterator](), second = c.frames[Symbol.asyncIterator]()
  await first.next(); await second.next()
  const waitA = first.next(), waitC = second.next()
  b.append('x')
  expect(vi.getTimerCount()).toBe(1)
  a.close()
  expect((await waitA).done).toBe(true)
  expect(empty).not.toHaveBeenCalled()
  c.close()
  expect((await waitC).done).toBe(true)
  expect(empty).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})
