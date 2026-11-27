/**
 * React-free data owner of the panel's workflow block (D29): one per DSH
 * session, polling `acpResume/workflows(ownerSessionId)` only while someone
 * subscribes (fetch on the first subscription, then every
 * {@link POLL_INTERVAL_MS}; the last unsubscription stops it). Independent of
 * the chats source. The snapshot reference stays the same while the content
 * does not change (D21). A failed fetch keeps the last good data.
 * @module dsh-acp-resume/client/workflows-source
 */

import { callPanel, POLL_INTERVAL_MS, type PanelRpc } from './chats-source.ts'
import type { Observable, WorkflowsSnapshot } from './face.ts'

export class WorkflowsSource implements Observable<WorkflowsSnapshot> {
  private snapshot: WorkflowsSnapshot = { status: 'loading', running: [], recent: [] }
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  private latest = 0
  private disposed = false

  /**
   * @param rpc - Connection RPC caller.
   * @param ownerSessionId - the session whose workflows to show.
   * @param poll - false reads only recent history on open and manual refresh.
   * @param now - clock for `fetchedAt`.
   * @param intervalMs - poll period while subscribed.
   */
  constructor(
    private readonly rpc: PanelRpc,
    private readonly ownerSessionId: string,
    private readonly poll = true,
    private readonly now: () => number = Date.now,
    private readonly intervalMs: number = POLL_INTERVAL_MS,
  ) {}

  readonly getSnapshot = (): WorkflowsSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1 && !this.disposed) {
      void this.refresh()
      clearInterval(this.timer)
      if (this.poll) this.timer = setInterval(() => { void this.refresh() }, this.intervalMs)
    }
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size > 0) return
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** A manual panel refresh reads history only while this owner's block is mounted. */
  refreshIfSubscribed(): void {
    if (this.listeners.size) void this.refresh()
  }

  /** Fetch now; never rejects. A failure (e.g. an older host) keeps the last data. */
  async refresh(): Promise<void> {
    if (this.disposed) return
    const id = ++this.latest
    try {
      const value = await callPanel(this.rpc, 'workflows', { ownerSessionId: this.ownerSessionId }) as Partial<WorkflowsSnapshot> | null
      if (this.disposed || id !== this.latest) return
      if (value === null || !Array.isArray(value.running) || !Array.isArray(value.recent)) throw new Error('acpResume/workflows returned no workflows')
      const next: WorkflowsSnapshot = { status: 'ready', running: this.poll ? value.running : [], recent: value.recent, fetchedAt: this.now() }
      const { fetchedAt: _old, ...was } = this.snapshot
      const { fetchedAt: _new, ...is } = next
      // Unchanged content keeps the reference even while a run is active (`LiveElapsed` ticks locally; D49).
      if (JSON.stringify(was) === JSON.stringify(is)) return
      this.publish(next)
    } catch {
      if (this.disposed || id !== this.latest || this.snapshot.status !== 'loading') return
      this.publish({ status: 'error', running: [], recent: [] })
    }
  }

  dispose(): void {
    this.disposed = true
    clearInterval(this.timer)
    this.timer = undefined
    this.listeners.clear()
  }

  private publish(next: WorkflowsSnapshot): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}
