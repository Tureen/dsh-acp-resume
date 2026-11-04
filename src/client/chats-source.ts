/**
 * React-free data owner of the panel (apply world): calls the host Remote
 * methods over `connection.rpc` (PANEL-DESIGN §3.6.1 channel B) and publishes
 * one {@link ChatsSnapshot} source. Polling runs only while someone subscribes
 * (the panel is open): fetch on the first subscription, then every
 * {@link POLL_INTERVAL_MS}; the last unsubscription stops it. `close` and
 * `purge` refresh once they settle, success or not. A response older than the
 * latest started refresh is dropped.
 * @module dsh-acp-resume/client/chats-source
 */

import type { ChatsSnapshot, Observable, PanelChat } from './face.ts'

/** Poll period while the panel is open (§2.4). */
export const POLL_INTERVAL_MS = 5000

/** Connection RPC result as the carrier returns it. */
export type PanelRpcResult =
  | { readonly ok: true; readonly value?: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** The slice of the official `ClientConnectionRpc` the panel uses. */
export interface PanelRpc {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<PanelRpcResult>
}

/** Host method names under the `acpResume` namespace (wire `purge`, not `remove`; §3.6.0 #2). */
export type PanelMethod = 'list' | 'close' | 'purge' | 'turns' | 'turn'

/**
 * Call one host panel method; carrier throws and `ok: false` both reject.
 * @param rpc - the Connection RPC caller.
 * @param method - host method under `acpResume`.
 * @param args - named wire arguments.
 * @returns the method's value.
 */
export async function callPanel(rpc: PanelRpc, method: PanelMethod, args: Readonly<Record<string, unknown>>): Promise<unknown> {
  const result = await rpc.call('/api', `acpResume/${method}`, { args })
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Observable panel data plus its commands. */
export class ChatsSource implements Observable<ChatsSnapshot> {
  private snapshot: ChatsSnapshot = { status: 'loading', chats: [] }
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  private latest = 0
  private disposed = false

  /**
   * @param rpc - Connection RPC caller.
   * @param now - clock for `fetchedAt`.
   * @param intervalMs - poll period while subscribed.
   */
  constructor(
    private readonly rpc: PanelRpc,
    private readonly now: () => number = Date.now,
    private readonly intervalMs: number = POLL_INTERVAL_MS,
  ) {}

  /** Current snapshot; the same reference until the data changes. */
  readonly getSnapshot = (): ChatsSnapshot => this.snapshot

  /** Subscribe; the first subscriber starts polling and the last one stops it. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1 && !this.disposed) {
      void this.refresh()
      this.timer = setInterval(() => { void this.refresh() }, this.intervalMs)
    }
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size > 0) return
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** Fetch the list now and publish it. Never rejects; a failure is published as `error`. */
  async refresh(): Promise<void> {
    if (this.disposed) return
    const id = ++this.latest
    try {
      const value = await callPanel(this.rpc, 'list', {})
      if (!Array.isArray(value)) throw new Error('acpResume/list returned no list')
      if (this.stale(id)) return
      const chats = [...value as PanelChat[]].sort((a, b) => b.lastActive - a.lastActive)
      this.publish({ status: 'ready', chats, fetchedAt: this.now() })
    } catch (error: unknown) {
      if (this.stale(id)) return
      const { chats, fetchedAt } = this.snapshot
      this.publish({ status: 'error', chats, error: message(error), ...(fetchedAt === undefined ? {} : { fetchedAt }) })
    }
  }

  /** Release the chat's process (record kept), then refresh. */
  close(chatId: string): Promise<void> {
    return this.command('close', chatId)
  }

  /** Release the chat and delete its record, then refresh. */
  purge(chatId: string): Promise<void> {
    return this.command('purge', chatId)
  }

  /** Stop polling and drop every later answer. */
  dispose(): void {
    this.disposed = true
    clearInterval(this.timer)
    this.timer = undefined
    this.listeners.clear()
  }

  private async command(method: 'close' | 'purge', chatId: string): Promise<void> {
    try {
      await callPanel(this.rpc, method, { chatId })
    } finally {
      void this.refresh()
    }
  }

  private stale(id: number): boolean {
    return this.disposed || id !== this.latest
  }

  private publish(next: ChatsSnapshot): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}
