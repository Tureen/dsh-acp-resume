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

import type { PanelTranslate } from './locales.ts'
import type { ChatsSnapshot, Observable, PanelChat, PanelUsage } from './face.ts'
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
export type PanelMethod = 'list' | 'close' | 'purge' | 'turns' | 'turn' | 'usage' | 'workflows' | 'chatOptions' | 'setChatModel' | 'setChatEffort' | 'teamRoles'

/** The updated panel can only use owner-aware methods on a reloaded host. */
class HostReloadRequired extends Error {}

export function panelActionError(error: unknown, t: PanelTranslate): string {
  return error instanceof HostReloadRequired ? t('restartForChatActions') : t('actionFailed', { message: message(error) })
}

/**
 * Call one host panel method; carrier throws and `ok: false` both reject.
 * @param rpc - the Connection RPC caller.
 * @param method - host method under `acpResume`.
 * @param args - named wire arguments.
 * @returns the method's value.
 */
export async function callPanel(rpc: PanelRpc, method: PanelMethod, args: Readonly<Record<string, unknown>>): Promise<unknown> {
  const setting = method === 'chatOptions' || method === 'setChatModel' || method === 'setChatEffort'
  const owned = setting || method === 'close' || method === 'purge'
  if ((owned || method === 'teamRoles') && (typeof args.sessionId !== 'string' || !args.sessionId.trim())) {
    throw new Error('current DSH sessionId is required')
  }
  const result = await rpc.call('/api', `acpResume/${method}`, { args })
  if (!result.ok) {
    const { code, message } = result.error
    if ((owned && code === 'gateway/arguments-invalid' && message.includes('unexpected "sessionId"'))
      || (setting && code === 'gateway/invocation-unavailable')) throw new HostReloadRequired(message)
    throw new Error(`${code}: ${message}`)
  }
  return result.value
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Observable panel data plus its commands.
 *
 * The snapshot reference is stable between content changes (D21/D49): a poll whose
 * payload equals the current snapshot keeps the existing object, so
 * `useSyncExternalStore` sees no change and the panel does not re-render. Only
 * a real change (or a status flip) publishes a new reference, and `fetchedAt`
 * then marks that change — it does not advance on unchanged polls. While a
 * prompt runs, the source keeps the fast poll cadence so settlement is picked up
 * promptly without emitting duplicate snapshots (`LiveElapsed` ticks locally).
 * Polling backs off to {@link IDLE_POLL_INTERVAL_MS} after
 * {@link QUIET_POLLS_BEFORE_BACKOFF} unchanged idle polls; a change or a
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

  /** Last usage answer (D28); kept across list refreshes. */
  private usage: readonly PanelUsage[] | undefined
  /** A usage request is in flight; another refresh does not start a second one. */
  private usagePending = false
  /** Active per-session subscribers so `teamRoles` refreshes on the same poll tick as `list` without extra timers (D47). */
  private readonly activeSessions = new Map<string, number>()
  /** Last defined workspace roles per session id; kept across list refreshes. */
  private readonly teamRoles = new Map<string, readonly string[]>()
  /** Cached session-scoped observables sharing this source's single polling timer. */
  private readonly sessionViews = new Map<string, Observable<ChatsSnapshot>>()

  /**
   * Session-scoped view over this source (D47 2026-11-27). Piggybacks
   * `acpResume/teamRoles(sessionId)` onto the exact same refresh round and
   * single timer as `acpResume/list`, returning a stable snapshot reference
   * until chats, usage, or that session's role list changes.
   */
  forSession(sessionId: string | undefined): Observable<ChatsSnapshot> {
    if (sessionId === undefined || !sessionId.trim()) return this
    const existing = this.sessionViews.get(sessionId)
    if (existing !== undefined) return existing
    let cachedBase: ChatsSnapshot | undefined
    let cachedRoles: readonly string[] | undefined
    let cachedSnapshot: ChatsSnapshot | undefined
    const view: Observable<ChatsSnapshot> = {
      getSnapshot: () => {
        const base = this.snapshot
        const roles = this.teamRoles.get(sessionId)
        if (cachedSnapshot !== undefined && base === cachedBase && roles === cachedRoles) {
          return cachedSnapshot
        }
        cachedBase = base
        cachedRoles = roles
        cachedSnapshot = roles === undefined ? base : { ...base, teamRoles: roles }
        return cachedSnapshot
      },
      subscribe: (listener) => {
        const hadListeners = this.listeners.size > 0
        this.activeSessions.set(sessionId, (this.activeSessions.get(sessionId) ?? 0) + 1)
        const unsub = this.subscribe(listener)
        if (hadListeners && !this.disposed && !this.teamRoles.has(sessionId)) {
          void this.refresh()
        }
        return () => {
          const count = (this.activeSessions.get(sessionId) ?? 0) - 1
          if (count <= 0) this.activeSessions.delete(sessionId)
          else this.activeSessions.set(sessionId, count)
          unsub()
        }
      },
    }
    this.sessionViews.set(sessionId, view)
    return view
  }

  /** Fetch the list now and publish it, plus active sessions' team roles and backend usage beside it. Never rejects; a list failure is published as `error`. */
  async refresh(): Promise<void> {
    if (this.disposed) return
    // Usage never holds up the rows: it is fetched on its own and merged when it lands.
    void this.refreshUsage()
    const id = ++this.latest
    const sessionIds = [...this.activeSessions.keys()]
    try {
      const [value, rolesResults] = await Promise.all([
        callPanel(this.rpc, 'list', {}),
        Promise.all(sessionIds.map(async (sessionId): Promise<[string, readonly string[] | undefined]> => {
          try {
            const res = await callPanel(this.rpc, 'teamRoles', { sessionId })
            if (Array.isArray(res) && res.every((item): item is string => typeof item === 'string')) {
              return [sessionId, res]
            }
            return [sessionId, undefined]
          } catch {
            // Optional on older hosts; keep the last known roles and never fail the list.
            return [sessionId, undefined]
          }
        })),
      ])
      if (!Array.isArray(value)) throw new Error('acpResume/list returned no list')
      if (this.stale(id)) return
      let rolesChanged = false
      for (const [sessionId, roles] of rolesResults) {
        if (roles === undefined) continue
        const prev = this.teamRoles.get(sessionId)
        if (prev === undefined || prev.length !== roles.length || !prev.every((name, i) => name === roles[i])) {
          this.teamRoles.set(sessionId, roles)
          rolesChanged = true
        }
      }
      const chats = [...value as PanelChat[]].sort((a, b) => b.lastActive - a.lastActive)
      this.publish({ status: 'ready', chats, fetchedAt: this.now(), ...this.usageField() }, rolesChanged)
    } catch (error: unknown) {
      if (this.stale(id)) return
      const { chats, fetchedAt } = this.snapshot
      this.publish({ status: 'error', chats, error: message(error), ...(fetchedAt === undefined ? {} : { fetchedAt }), ...this.usageField() })
    }
  }

  private usageField(): { readonly usage?: readonly PanelUsage[] } {
    return this.usage === undefined ? {} : { usage: this.usage }
  }

  /** Fetch backend usage (D28). A failure (e.g. an older host without the method) keeps the last answer. */
  private async refreshUsage(): Promise<void> {
    if (this.usagePending) return
    this.usagePending = true
    try {
      const value = await callPanel(this.rpc, 'usage', {})
      if (this.disposed || !Array.isArray(value)) return
      this.usage = value as PanelUsage[]
      // Merge into the current rows without counting as a poll (the list poll drives the backoff).
      const next: ChatsSnapshot = { ...this.snapshot, usage: this.usage }
      if (this.snapshot.status === 'loading' || listSnapshotEqual(this.snapshot, next)) return
      this.snapshot = next
      for (const listener of [...this.listeners]) listener()
    } catch { /* usage is optional: the rows stay as they are */ } finally {
      this.usagePending = false
    }
  }

  /** Release the chat's process (record kept), then refresh. */
  close(chatId: string, sessionId: string | undefined): Promise<void> {
    return this.command('close', chatId, sessionId)
  }

  /** Release the chat and delete its record, then refresh. */
  purge(chatId: string, sessionId: string | undefined): Promise<void> {
    return this.command('purge', chatId, sessionId)
  }

  /** Stop polling and drop every later answer. */
  dispose(): void {
    this.disposed = true
    this.stopPolling()
    this.listeners.clear()
    this.activeSessions.clear()
    this.sessionViews.clear()
  }

  private async command(method: 'close' | 'purge', chatId: string, sessionId: string | undefined): Promise<void> {
    try {
      await callPanel(this.rpc, method, { chatId, sessionId })
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

  /**
   * Publish only when content changed (D21/D49). While a turn is in flight,
   * keep the fast poll cadence without publishing duplicate snapshots
   * (`LiveElapsed` ticks locally every second).
   */
  private publish(next: ChatsSnapshot, forceNotify = false): void {
    const hasInFlight = next.chats.some(chat => chat.inFlight !== undefined)
    if (!forceNotify && listSnapshotEqual(this.snapshot, next)) {
      if (hasInFlight) {
        this.quietPolls = 0
        if (this.listeners.size > 0 && this.currentInterval !== this.intervalMs) this.arm(this.intervalMs)
        return
      }
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
