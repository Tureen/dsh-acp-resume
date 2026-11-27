/**
 * D46 consumer-shape regression, through the real rc.5 Gateway.
 *
 * Cordis checks service access per injected name on the *accessing* scope. The shipped client
 * (`src/client/index.ts`) injects `remote` at the top level so `scope.remote.$mount(...)` and
 * `faceScope.remote` resolve via the ancestor chain, and reads `remote.acpResume` only from a
 * child scope that injected `remote.acpResume`. From 0.7.2 to 0.7.7 it lifted the whole `remote`
 * object out of `inject(['remote'])` and touched `.acpResume` outside, which the DSH client
 * rejects with `cannot get property "remote.acpResume" without inject` — and every detail page
 * showed "live output unavailable". This file loads the real `src/client/index.ts` plugin over
 * real `Gateway` + `ClientGateway` so any regression in production code turns red here.
 *
 * @module dsh-acp-resume/tests/live-gateway-consumer
 */
import { once } from 'node:events'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import * as ClientGateway from '@deepseek-ai/dsh-api-gateway/client'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const noop = () => null
  return {
    Button: noop,
    Input: noop,
    Switch: noop,
    IconArchiveOutlineRegular: noop,
    IconChevronDownOutlineRegular: noop,
    IconChevronUpOutlineRegular: noop,
    IconEllipsisOutlineRegular: noop,
    IconRefreshOutlineRegular: noop,
    IconSettingsOutlineRegular: noop,
    IconSlidersTwoOutlineRegular: noop,
    IconWarningOutlineRegular: noop,
    DisclosureRow: noop,
    MarkdownText: noop,
    Pill: noop,
    TextShimmer: noop,
    extractMarkdownPlainText: (text: string) => text,
    useClipboardCopy: () => ({ copied: false, onCopy: () => {} }),
    Modal: noop,
    Tag: noop,
    StateDot: noop,
    Menu: noop,
  }
})

import type { ChatDetailInjected } from '../src/client/face.ts'
import * as clientPlugin from '../src/client/index.ts'
import { watchDescriptor, type LiveView, type WatchRemote } from '../src/client/live-source.ts'
import type { LiveFrame } from '../src/live-buffer.ts'

function stubServices() {
  const tabs: Record<string, unknown>[] = []
  const bodies: { options: { name: string; key: string; locale?: string; inject: (sessionId?: string) => unknown }; component: unknown }[] = []
  const dictionaries: string[] = []
  return {
    tabs, bodies, dictionaries,
    slots: {
      inject: (_name: string, register: () => () => void) => register(),
      register(options: (typeof bodies)[number]['options'], component: unknown) {
        const entry = { options, component }
        bodies.push(entry)
        return () => { bodies.splice(bodies.indexOf(entry), 1) }
      },
    },
    sidebarRightTabs: {
      register(definition: Record<string, unknown>) {
        tabs.push(definition)
        return () => { tabs.splice(tabs.indexOf(definition), 1) }
      },
    },
    locale: {
      register(namespace: string) {
        dictionaries.push(namespace)
        return () => { dictionaries.splice(dictionaries.indexOf(namespace), 1) }
      },
      bind: () => (key: string) => key,
    },
  }
}

/** A synthetic consumer plugin used only for mechanism reproduction (not production code). */
function consumer(topInject: string[], body: (scope: Context, out: string[]) => Promise<void>) {
  const out: string[] = []
  const plugin = {
    inject: topInject,
    apply(ctx: Context) {
      ctx.inject(['connection'], (scope: Context) => { void body(scope, out).catch(error => { out.push('THROWS ' + (error as Error).message) }) })
    },
  }
  return { out, plugin }
}

async function firstLine(out: string[]): Promise<string> {
  for (let i = 0; i < 100 && out.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 50))
  return out[0] ?? 'NO OUTPUT'
}

interface GatewayHarness {
  readonly client: Context
  readonly counts: { aborted: number; finally: number }
  readonly done: Promise<void>
  readonly registerRemote: ReturnType<typeof vi.fn>
}

async function gateway(run: (harness: GatewayHarness) => Promise<void>): Promise<void> {
  const host = new Context(), client = new Context()
  const server = createServer()
  const done = Promise.withResolvers<void>()
  const counts = { aborted: 0, finally: 0 }
  const registerRemote = vi.fn(() => () => {})

  class Face extends TypertRemoteService {
    constructor(ctx: Context) { super(ctx, 'acpResume') }
    @Remote({ mode: 'stream' })
    async *watch(chatId: string, sessionId: string, signal: AbortSignal): AsyncIterable<LiveFrame> {
      const aborted = Promise.withResolvers<void>()
      const stop = () => { counts.aborted++; aborted.resolve() }
      signal.addEventListener('abort', stop, { once: true })
      try {
        yield { kind: 'snapshot', seq: 1, truncated: false, text: `frame-for-${chatId}:${sessionId}` }
        if (!signal.aborted) await aborted.promise
      } finally {
        signal.removeEventListener('abort', stop)
        counts.finally++
        done.resolve()
      }
    }
  }

  const peer = { ctx: host, principal: { kind: 'owner' }, interactions: 'answer', signal: new AbortController().signal }
  host.provide('typert', { local: { get() {}, hasSeen: () => false }, lookups: { definitions: () => [] } } as never)
  host.provide('remoteAccess', {} as never)
  host.provide('connection', { rpc: { intercept() {} }, admitConnection: () => ({ peer, release: async () => {} }) } as never)
  host.provide('webServer', { registerUpgrade({ handler }: { handler: (req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void }) {
    server.on('upgrade', handler)
    return () => server.off('upgrade', handler)
  } } as never)
  try {
    new Face(host)
    await host.plugin(Gateway as never)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('missing test port')
    client.provide('typert', { remotes: { register: registerRemote } } as never)
    client.provide('connection', {
      rpc: { call: async () => ({ ok: true, value: [] }) },
      interactions: 'none',
      openWebSocket: (path: string) => new WebSocket('ws://127.0.0.1:' + address.port + path),
    } as never)
    await client.plugin(ClientGateway as never)
    await run({ client, counts, done: done.promise, registerRemote })
  } finally {
    await client.fiber.dispose()
    await host.fiber.dispose()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

it('rejects `remote.acpResume` on a scope that injected only `remote` — 0.7.2–0.7.7 机制复现，不覆盖生产代码', async () => {
  await gateway(async ({ client }) => {
    const { out, plugin } = consumer(['connection', 'remote'], async (scope, out) => {
      // 0.7.5's shape: mount inside inject(['remote']), lift the whole `remote` out, touch `.acpResume` outside.
      let lifted: WatchRemote | undefined
      await scope.inject(['remote'], async (remoteScope: Context) => {
        const remote = remoteScope.get('remote') as WatchRemote
        await remote.$mount({ package: 'dsh-acp-resume', descriptors: [watchDescriptor] })
        lifted = remote
      }).await()
      try { out.push('accessed watch=' + typeof lifted!.acpResume.watch) } catch (error) { out.push('THROWS ' + (error as Error).message) }
    })
    await client.plugin(plugin as never)
    expect(await firstLine(out)).toBe('THROWS cannot get property "remote.acpResume" without inject')
  })
})

it('loads real src/client/index.ts over Gateway, mounts once, delivers snapshot via followTurn, and cleans up host on cancel', async () => {
  await gateway(async ({ client, counts, done, registerRemote }) => {
    const services = stubServices()
    client.provide('slots', services.slots as never)
    client.provide('sidebarRightTabs', services.sidebarRightTabs as never)
    client.provide('locale', services.locale as never)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fiber = await client.plugin(clientPlugin as never)
      const detail = services.bodies.find(
        b => b.options.name === 'sidebar.right.pane.tab' && b.options.key === 'dsh-acp-resume/chat',
      )
      expect(detail).toBeDefined()
      const face = detail!.options.inject('owner-session') as ChatDetailInjected
      expect(face.followTurn).toBeTypeOf('function')

      const views: LiveView[] = []
      const stop = face.followTurn!('chat-real', Date.now(), view => { views.push(view) })
      await vi.waitFor(() => { expect(views.length).toBeGreaterThan(0) }, { timeout: 5000 })
      expect(views[0]).toEqual({ kind: 'snapshot', seq: 1, truncated: false, text: 'frame-for-chat-real:owner-session' })

      stop()
      await done
      expect(counts).toEqual({ aborted: 1, finally: 1 })
      expect(registerRemote).toHaveBeenCalledTimes(1)
      expect(registerRemote).toHaveBeenCalledWith({ package: 'dsh-acp-resume', descriptors: [watchDescriptor] })
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('live output stream failed'), expect.anything())

      await fiber.dispose()
    } finally {
      warn.mockRestore()
    }
  })
})
