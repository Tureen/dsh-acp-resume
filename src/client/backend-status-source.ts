/**
 * Profile-wide backend readiness for the sidebar. Polls only the cached Host
 * snapshot while subscribed; only `check()` calls the explicit probe RPC.
 * @module dsh-acp-resume/client/backend-status-source
 */

import type { BackendStatusSnapshot } from '../backend-status.ts'
import { POLL_INTERVAL_MS, type PanelRpc } from './chats-source.ts'
import type { BackendStatusSourceFace, BackendStatusView } from './face.ts'

function isSnapshot(value: unknown): value is BackendStatusSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const snapshot = value as Partial<BackendStatusSnapshot>
  return typeof snapshot.checking === 'boolean' && typeof snapshot.dispatchEnabled === 'boolean'
    && (snapshot.defaultBackend === undefined || typeof snapshot.defaultBackend === 'string')
    && Array.isArray(snapshot.backends) && snapshot.backends.every(row => row !== null && typeof row === 'object'
      && typeof row.id === 'string' && typeof row.label === 'string' && typeof row.configured === 'boolean'
      && (row.automatic === undefined || row.automatic === true)
      && typeof row.compatibility === 'string' && typeof row.readiness === 'string'
      && (row.version === undefined || typeof row.version === 'string')
      && (row.range === undefined || typeof row.range === 'string')
      && (row.reason === undefined || typeof row.reason === 'string'))
}

/** One observable per Client connection, shared across session-scoped sidebar mounts. */
export class BackendStatusSource implements BackendStatusSourceFace {
  private view: BackendStatusView = { status: 'loading', checking: false }
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  private activeRead: symbol | undefined
  private disposed = false

  /** @param rpc - Connection RPC caller; `intervalMs` is the snapshot poll period. */
  constructor(private readonly rpc: PanelRpc, private readonly intervalMs: number = POLL_INTERVAL_MS) {}

  readonly getSnapshot = (): BackendStatusView => this.view

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    if (this.listeners.size === 1 && this.timer === undefined) {
      void this.read()
      this.timer = setInterval(() => { void this.read() }, this.intervalMs)
    }
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size > 0) return
      this.stopPolling()
    }
  }

  /** Run one explicit check. While pending, keep the last snapshot visible and skip snapshot polls. */
  async check(): Promise<void> {
    if (this.disposed || this.view.checking || this.view.data?.checking || this.view.status === 'unavailable') return
    // A read started before the check must not overwrite the check's newer answer.
    this.activeRead = undefined
    this.publish({ ...this.view, checking: true, checkFailed: false, checkCompleted: false })
    try {
      const result = await this.rpc.call('/api', 'acpResume/checkBackends', { args: {} })
      if (!result.ok || !isSnapshot(result.value)) throw new Error('Backend check failed')
      this.publish({ status: 'ready', data: result.value, checking: false, checkCompleted: true })
    } catch {
      this.publish({ ...this.view, checking: false, checkFailed: true })
    }
  }

  /** Stop polling and discard responses from the disposed connection. */
  dispose(): void {
    this.disposed = true
    this.stopPolling()
    this.listeners.clear()
  }

  private async read(): Promise<void> {
    if (this.disposed || this.activeRead !== undefined || this.view.checking) return
    const read = this.activeRead = Symbol()
    try {
      const result = await this.rpc.call('/api', 'acpResume/backends', { args: {} })
      if (this.activeRead !== read) return
      if (!result.ok) {
        // SRC mode reports an unmounted or missing Remote by this code.
        if (result.error.code === 'gateway/invocation-unavailable' && this.view.data === undefined) {
          this.publish({ status: 'unavailable', checking: false })
          return
        }
        throw new Error('Backend snapshot read failed')
      }
      if (!isSnapshot(result.value)) throw new Error('Backend snapshot was malformed')
      this.publish({ ...this.view, status: 'ready', data: result.value })
    } catch {
      if (this.activeRead === read) this.publish({ ...this.view, status: 'error' })
    } finally {
      if (this.activeRead === read) this.activeRead = undefined
    }
  }

  private stopPolling(): void {
    clearInterval(this.timer)
    this.timer = undefined
    this.activeRead = undefined
  }

  private publish(next: BackendStatusView): void {
    if (this.disposed) return
    const was = this.view
    if (was.status === next.status && was.checking === next.checking && was.checkFailed === next.checkFailed && was.checkCompleted === next.checkCompleted
      && JSON.stringify(was.data) === JSON.stringify(next.data)) return
    this.view = next
    for (const listener of [...this.listeners]) listener()
  }
}
