/**
 * React-free data owner of one chat's detail tab (D18, apply world): polls
 * `acpResume/turns` over `connection.rpc` while someone subscribes (the tab is
 * mounted), as {@link ChatsSource} does for the list, and fetches single
 * entries in full on demand. A response older than the latest started refresh
 * is dropped. A host answer of `acp-resume/unknown-chat` publishes `gone` (the
 * chat was deleted) and stops polling; any other failure keeps the last good
 * data under `error`.
 * @module dsh-acp-resume/client/detail-source
 */

import { callPanel, POLL_INTERVAL_MS, type PanelRpc } from './chats-source.ts'
import type { DetailSnapshot, DetailSource, EventItem, FullEntry, PanelChat, TurnItem } from './face.ts'

/** Entries requested on open, and added by each "load earlier". */
export const DETAIL_PAGE = 50
/** The host's ceiling for `limit`. */
export const DETAIL_MAX = 200

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Observable detail data of one chat plus its on-demand entry reads. */
export class ChatDetailSource implements DetailSource {
  private snapshot: DetailSnapshot = { status: 'loading', entries: [], total: 0 }
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  private latest = 0
  private limit = DETAIL_PAGE
  private disposed = false

  /**
   * @param rpc - Connection RPC caller.
   * @param chatId - the chat this source follows.
   * @param now - clock for `fetchedAt`.
   * @param intervalMs - poll period while subscribed.
   */
  constructor(
    private readonly rpc: PanelRpc,
    private readonly chatId: string,
    private readonly now: () => number = Date.now,
    private readonly intervalMs: number = POLL_INTERVAL_MS,
  ) {}

  /** Current snapshot; the same reference until the data changes. */
  readonly getSnapshot = (): DetailSnapshot => this.snapshot

  /** Subscribe; the first subscriber starts polling and the last one stops it. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1 && !this.disposed && this.snapshot.status !== 'gone') {
      void this.refresh()
      this.timer = setInterval(() => { void this.refresh() }, this.intervalMs)
    }
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size > 0) return
      this.stopPolling()
    }
  }

  /** Fetch now and publish. Never rejects. */
  async refresh(): Promise<void> {
    if (this.disposed) return
    const id = ++this.latest
    try {
      const value = await callPanel(this.rpc, 'turns', { chatId: this.chatId, limit: this.limit }) as
        { chat?: PanelChat; entries?: (TurnItem | EventItem)[]; total?: number } | null
      if (value === null || typeof value !== 'object' || value.chat === undefined || !Array.isArray(value.entries)) {
        throw new Error('acpResume/turns returned no detail')
      }
      if (this.stale(id)) return
      this.publish({ status: 'ready', chat: value.chat, entries: value.entries, total: value.total ?? value.entries.length, fetchedAt: this.now() })
    } catch (error: unknown) {
      if (this.stale(id)) return
      const text = message(error)
      if (text.startsWith('acp-resume/unknown-chat')) {
        this.stopPolling()
        this.publish({ status: 'gone', entries: [], total: 0, error: text })
        return
      }
      const { chat, entries, total, fetchedAt } = this.snapshot
      this.publish({
        status: 'error', entries, total, error: text,
        ...(chat === undefined ? {} : { chat }), ...(fetchedAt === undefined ? {} : { fetchedAt }),
      })
    }
  }

  /** Request a longer history (up to the host ceiling) and refetch. */
  loadMore(): Promise<void> {
    this.limit = Math.min(this.limit + DETAIL_PAGE, DETAIL_MAX)
    return this.refresh()
  }

  /** One entry in full; rejects with the failure text. */
  async loadEntry(seq: number): Promise<FullEntry> {
    return await callPanel(this.rpc, 'turn', { chatId: this.chatId, seq }) as FullEntry
  }

  /** Stop polling and drop every later answer. */
  dispose(): void {
    this.disposed = true
    this.stopPolling()
    this.listeners.clear()
  }

  private stopPolling(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }

  private stale(id: number): boolean {
    return this.disposed || id !== this.latest
  }

  private publish(next: DetailSnapshot): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}
