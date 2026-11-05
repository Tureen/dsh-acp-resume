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
import { listSnapshotEqual } from './snapshot-equal.ts'

/** Fast poll period while the panel is open and recently changing (§2.4). */
export const POLL_INTERVAL_MS = 5000
/** Idle poll period after {@link QUIET_POLLS_BEFORE_BACKOFF} unchanged polls (D21 backoff). */
export const IDLE_POLL_INTERVAL_MS = 30_000
/** Unchanged polls in a row before the source backs off to the idle period. */
export const QUIET_POLLS_BEFORE_BACKOFF = 3

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

/**
 * Observable panel data plus its commands.
 *
 * The snapshot reference is stable between content changes (D21): a poll whose
 * payload equals the current snapshot keeps the existing object, so
 * `useSyncExternalStore` sees no change and the panel does not re-render. Only
 * a real change (or a status flip) publishes a new reference, and `fetchedAt`
 * then marks that change — it does not advance on unchanged polls. Polling runs
 * fast while the data is moving and backs off to {@link IDLE_POLL_INTERVAL_MS}
 * after {@link QUIET_POLLS_BEFORE_BACKOFF} unchanged polls; a change or a
 * command resets it to fast.
 */
export class ChatsSource implements Observable<ChatsSnapshot> {
  private snapshot: ChatsSnapshot = { status: 'loading', chats: [] }
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  private latest = 0
  private disposed = false
  /** Unchanged polls in a row; drives the backoff to the idle period. */
  private quietPolls = 0
  /** The interval the current timer runs at, so a backoff only reschedules on change. */
  private currentInterval: number

  /**
   * @param rpc - Connection RPC caller.
   * @param now - clock for `fetchedAt`.
   * @param intervalMs - fast poll period while subscribed.
   * @param idleIntervalMs - idle poll period after a run of unchanged polls.
   */
  constructor(
    private readonly rpc: PanelRpc,
    private readonly now: () => number = Date.now,
    private readonly intervalMs: number = POLL_INTERVAL_MS,
    private readonly idleIntervalMs: number = IDLE_POLL_INTERVAL_MS,
  ) {
    this.currentInterval = intervalMs
  }

  /** Current snapshot; the same reference until the data changes. */
  readonly getSnapshot = (): ChatsSnapshot => this.snapshot

  /** Subscribe; the first subscriber starts polling and the last one stops it. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1 && !this.disposed) {
      this.quietPolls = 0
      void this.refresh()
      this.arm(this.intervalMs)
    }
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size > 0) return
      this.stopPolling()
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
    this.stopPolling()
    this.listeners.clear()
  }

  private async command(method: 'close' | 'purge', chatId: string): Promise<void> {
    try {
      await callPanel(this.rpc, method, { chatId })
    } finally {
      // A command is a deliberate change: poll fast again regardless of backoff.
      this.quietPolls = 0
      if (!this.disposed && this.listeners.size > 0 && this.currentInterval !== this.intervalMs) this.arm(this.intervalMs)
      void this.refresh()
    }
  }

  private stale(id: number): boolean {
    return this.disposed || id !== this.latest
  }

  /** Publish only when content changed; otherwise keep the reference and step the backoff. */
  private publish(next: ChatsSnapshot): void {
    if (listSnapshotEqual(this.snapshot, next)) {
      this.quietPolls += 1
      if (this.listeners.size > 0 && this.quietPolls >= QUIET_POLLS_BEFORE_BACKOFF && this.currentInterval !== this.idleIntervalMs) {
        this.arm(this.idleIntervalMs)
      }
      return
    }
    this.quietPolls = 0
    if (this.listeners.size > 0 && this.currentInterval !== this.intervalMs) this.arm(this.intervalMs)
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }

  private arm(intervalMs: number): void {
    this.currentInterval = intervalMs
    clearInterval(this.timer)
    this.timer = setInterval(() => { void this.refresh() }, intervalMs)
  }

  private stopPolling(): void {
    clearInterval(this.timer)
    this.timer = undefined
    this.currentInterval = this.intervalMs
    this.quietPolls = 0
  }
}
