/** D46: real rc.5 browser stream handle, loopback mux, and Gateway SRC Remote reflection. */
import { once } from 'node:events'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import * as ClientGateway from '@deepseek-ai/dsh-api-gateway/client'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it } from 'vitest'
import { watchDescriptor, type WatchRemote } from '../src/client/live-source.ts'
import type { LiveFrame } from '../src/live-buffer.ts'

async function fixture(test: (remote: WatchRemote, counts: { aborted: number; timers: number; finally: number }, done: Promise<void>) => Promise<void>) {
  const host = new Context(), client = new Context()
  const server = createServer()
  const done = Promise.withResolvers<void>()
  const counts = { aborted: 0, timers: 0, finally: 0 }
  class Fixture extends TypertRemoteService {
    constructor(ctx: Context) { super(ctx, 'acpResume') }
    @Remote({ mode: 'stream' })
    async *watch(chatId: string, sessionId: string, signal: AbortSignal): AsyncIterable<LiveFrame> {
      const aborted = Promise.withResolvers<void>()
      const stop = () => { counts.aborted++; aborted.resolve() }
      signal.addEventListener('abort', stop, { once: true })
      const timer = setTimeout(stop, 10_000)
      counts.timers++
      try {
        yield { kind: 'snapshot', seq: 1, truncated: false, text: chatId }
        yield { kind: 'snapshot', seq: 2, truncated: false, text: sessionId }
        if (!signal.aborted) await aborted.promise
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', stop)
        counts.timers--
        counts.finally++
        done.resolve()
      }
    }
  }
  const peer = { ctx: host, principal: { kind: 'owner' }, interactions: 'answer', signal: new AbortController().signal }
  host.provide('typert', { local: { get() {}, hasSeen: () => false }, lookups: { definitions: () => [] } } as never)
  host.provide('remoteAccess', {} as never)
  host.provide('connection', { rpc: { intercept() {} }, admitConnection: () => ({ peer, release: async () => {} }) } as never)
  host.provide('webServer', { registerUpgrade({ handler }: { handler: Parameters<typeof server.on>[1] }) {
    server.on('upgrade', handler)
    return () => server.off('upgrade', handler)
  } } as never)
  try {
    await host.plugin(Fixture)
    await host.plugin(Gateway)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('missing test port')
    client.provide('typert', { remotes: { register: () => () => {} } } as never)
    client.provide('connection', { rpc: {}, interactions: 'none', openWebSocket: (path: string) =>
      new WebSocket('ws://127.0.0.1:' + address.port + path) } as never)
    await client.plugin(ClientGateway)
    const remote = client.get('remote') as WatchRemote
    await remote.$mount({ package: 'dsh-acp-resume', descriptors: [watchDescriptor] })
    await test(remote, counts, done.promise)
  } finally {
    await client.fiber.dispose()
    await host.fiber.dispose()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

it('propagates a two-frame for-await break to the host signal before transport teardown', async () => {
  await fixture(async (remote, counts, done) => {
    const seen: number[] = []
    const caller = AbortSignal.timeout(4000)
    for await (const frame of remote.acpResume.watch('chat', 'owner', caller)) {
      seen.push(frame.seq)
      if (seen.length === 2) break
    }
    await done
    expect(caller.aborted).toBe(false)
    expect(seen).toEqual([1, 2])
    expect(counts.aborted).toBe(1)
  })
})

it('runs host finally and clears the timer when an open detail is disposed during a pending next', async () => {
  await fixture(async (remote, counts, done) => {
    const handle = remote.acpResume.watch('chat', 'owner', AbortSignal.timeout(4000))
    const iterator = handle[Symbol.asyncIterator]()
    await iterator.next(); await iterator.next()
    const pending = iterator.next()
    handle.dispose()
    await done
    expect((await pending).done).toBe(true)
    expect(counts).toEqual({ aborted: 1, finally: 1, timers: 0 })
  })
})
