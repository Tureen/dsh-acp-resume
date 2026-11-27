/** One demand-driven Remote stream for expanded viewers of the same viewing session and chat turn. @module */
import type { InvocationDescriptor, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { LiveFrame } from '../live-buffer.ts'

const stringCodec = { mode: 'strict', typeSymbol: 'string', create: () => ({ parse(value: unknown) {
  if (typeof value !== 'string') throw new Error('Expected a string')
  return value
} }) } as const

/** The public ClientRemote mount selects the Desktop local carrier or the Gateway WebSocket. */
export const watchDescriptor: InvocationDescriptor = {
  id: 'dsh-acp-resume#acpResume/watch', namespace: 'acpResume', service: 'acpResume', method: 'watch', mode: 'stream',
  invocation: { kind: 'direct' }, cancellation: { parameter: 'signal' }, result: { mode: 'src-json' },
  parameters: ['chatId', 'sessionId'].map(name => ({ name, wire: name, source: 'json', codec: stringCodec })),
}

export interface WatchRemote extends TypertClientRemote {
  readonly acpResume: { watch(chatId: string, sessionId: string, signal: AbortSignal): AsyncIterable<LiveFrame> & { dispose(): void } }
}

export type LiveView = LiveFrame | { kind: 'error' }
type Listener = (view: LiveView) => void
type Open = (chatId: string, owner: string, signal: AbortSignal) => AsyncIterable<LiveFrame>
export type FollowTurn = (chatId: string, startedAt: number, listener: Listener) => () => void

interface Watching {
  chatId: string
  owner: string
  listeners: Set<Listener>
  controller: AbortController
  latest?: LiveView
}

/** Reference counts live bodies only. The title and the list never acquire a stream. */
export class LiveSource {
  private readonly streams = new Map<string, Watching>()
  constructor(private readonly open: Open, private readonly settled: (chatId: string) => void) {}

  subscribe(chatId: string, owner: string | undefined, startedAt: number, listener: Listener): () => void {
    if (!owner) { listener({ kind: 'error' }); return () => {} }
    const key = JSON.stringify([owner, chatId, startedAt])
    let stream = this.streams.get(key)
    if (!stream) {
      stream = { chatId, owner, listeners: new Set([listener]), controller: new AbortController() }
      this.streams.set(key, stream)
      void this.consume(stream)
    } else {
      stream.listeners.add(listener)
      if (stream.latest) listener(stream.latest)
    }
    return () => {
      if (!stream.listeners.delete(listener) || stream.listeners.size) return
      stream.controller.abort()
      this.streams.delete(key)
    }
  }

  reset(): void {
    for (const stream of this.streams.values()) {
      stream.controller.abort()
      if (stream.latest?.kind === 'settled') continue
      stream.controller = new AbortController()
      void this.consume(stream)
    }
  }

  dispose(): void {
    for (const stream of this.streams.values()) { stream.controller.abort(); stream.listeners.clear() }
    this.streams.clear()
  }

  private async consume(stream: Watching): Promise<void> {
    const { signal } = stream.controller
    const publish = (view: LiveView) => {
      stream.latest = view
      for (const listener of stream.listeners) listener(view)
    }
    try {
      for await (const frame of this.open(stream.chatId, stream.owner, signal)) {
        if (signal.aborted) return
        publish(frame)
        if (frame.kind === 'settled') { this.settled(stream.chatId); return }
      }
      if (!signal.aborted) throw new Error('watch ended before the settled frame')
    } catch (error) {
      if (signal.aborted) return
      console.warn(`dsh-acp-resume: live output stream failed for ${stream.chatId}`, error)
      publish({ kind: 'error' })
    }
  }
}
