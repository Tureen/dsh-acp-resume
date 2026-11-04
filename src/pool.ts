/**
 * Persistent ACP session pool: the asset behind the continuable chat tools.
 * Each pooled chat owns one remote agent session (spawned process kept alive
 * between turns), a durable registry entry (remote session id + cwd, so a
 * dead process reconnects through `session/load`), an idle timer that
 * releases the process while PRESERVING the registry, and single-flight
 * prompt semantics per chat. Only a protocol-level rejection of
 * `session/load` falls back to a fresh remote session; any other reconnect
 * failure fails the send and leaves the saved remote session id untouched.
 * A reconnect whose registry entry was recorded under a different
 * command/args fails without loading: the saved session belongs to another
 * agent. A turn that settles `aborted` or `error` releases its process.
 * Teardown (`close`, `disposeAll`) aborts open windows and cancels in-flight
 * turns, each wait bounded by `disposeGraceMs`, so a hung `session/load`
 * cannot stall it and no process outlives the pool.
 * Each `completed` turn bumps the entry's `turnCount` and, while the entry
 * has no title yet, records the turn's message (trimmed, first 40
 * characters) as its `title`; `aborted` and `error` turns record neither.
 * `steer` forwards a private `_session/steer` to the live connection while a
 * turn is in flight. The reconnect fingerprint ignores `--agent-engine` (D19).
 * Optional send observers ({@link PoolSendHooks}) receive the turn's text
 * chunks as they stream and learn of a fresh-session fallback before the
 * prompt goes out.
 *
 * @module dsh-acp-resume/pool
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AcpConnection, AcpSteerResult } from './connection.js'
import { AcpConnectionError, openAcpConnection } from './connection.js'
import { assertUsableCwd } from '@deepseek-ai/dsh-subagent'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { AcpRunSpec } from './run.js'
import { stripAgentEngine } from './engine.js'

/** One pooled chat as reportable state (registry projection + liveness). */
export interface PooledChatInfo {
  readonly chatId: string
  readonly remoteSessionId: string
  readonly cwd: string
  /** Caller-chosen display label, when one was given at start. */
  readonly label?: string
  /** First completed turn's message, trimmed and cut to 40 characters; absent until one exists. */
  readonly title?: string
  /** Completed turns so far; absent until the first one (registries written before turn counting omit it). */
  readonly turnCount?: number
  /** A live process is attached (false once idle-released or after a restart). */
  readonly active: boolean
  readonly lastActive: number
}

/** Terminal result of one pooled send. */
export interface PoolSendResult {
  readonly chatId: string
  readonly remoteSessionId: string
  /** The turn's assistant text. */
  readonly output: string
  readonly stopReason: string
  /** True when the remote session was lost and a FRESH one answered instead. */
  readonly freshSession: boolean
  readonly diagnostic: string | undefined
}

/** Optional observers of one {@link AcpSessionPool.send}; a throwing observer is contained. */
export interface PoolSendHooks {
  /** Called once, before the prompt is sent, when a FRESH remote session replaced the lost one. */
  readonly onFreshSession?: () => void
  /** Each assistant text chunk of this turn, in arrival order; their concatenation is `output`. */
  readonly onText?: (text: string) => void
}

/** Pool construction inputs: the spawn base plus durability knobs. */
export interface PoolOptions {
  /** Everything except `cwd` of the per-run spawn spec (command/args/env/…). */
  readonly specBase: Omit<AcpRunSpec, 'cwd'>
  /** Registry file path; created (with parent dirs) on first change. */
  readonly registryPath: string
  /** Idle window (ms) after a settled turn before the process is released; positive, ≤ `MAX_TIMER_DELAY_MS`. */
  readonly idleTimeoutMs: number
  /** Non-fatal pool conditions (e.g. a corrupt registry file set aside). */
  readonly onWarn?: (message: string) => void
}

interface RegistryEntry {
  chatId: string
  remoteSessionId: string
  cwd: string
  /** Optional; registries written before labels existed omit it. */
  label?: string
  /** Optional; set once by the first completed turn with non-empty message text. */
  title?: string
  /** Optional; completed turns only. Older registries omit it and count from 0. */
  turnCount?: number
  command: string
  args: readonly string[]
  lastActive: number
}

/** Optional inputs for {@link AcpSessionPool.start}. */
export interface PoolStartOptions {
  /** Display label persisted with the chat (trimmed; empty means none). */
  readonly label?: string
}

/** An open window (`start` or reconnect) and the controller teardown aborts it with. */
interface OpenWindow {
  readonly promise: Promise<unknown>
  readonly controller: AbortController
}

interface RegistryFile {
  version: 1
  sessions: RegistryEntry[]
}

/** A pooled chat's live state (absent while released). */
interface LiveChat {
  readonly chatId: string
  conn: AcpConnection
  idleTimer: NodeJS.Timeout | undefined
  busy: boolean
  /** The in-flight turn's promise; a release cancels it and waits (bounded) for it to settle. */
  busyPromise: Promise<unknown> | undefined
  /** Set once a release started; concurrent closes share it. */
  closing: Promise<void> | undefined
}

/** Maximum `title` length, in characters (code points, so a surrogate pair is never split). */
const TITLE_MAX_CHARS = 40

/**
 * The registry entry after a settled turn. Only `completed` turns count and
 * may set the title. An entry written before these fields existed (no
 * `turnCount`, no `title`) is the established case of "no completed turn
 * recorded yet": its first completed turn counts as 1 and writes the title.
 * A non-numeric `turnCount` (hand-edited file) is treated the same way.
 */
function settledEntry(entry: RegistryEntry, stopReason: string, message: string, now: number): RegistryEntry {
  if (stopReason !== 'completed') return { ...entry, lastActive: now }
  const prior = typeof entry.turnCount === 'number' && Number.isFinite(entry.turnCount) ? entry.turnCount : 0
  const next: RegistryEntry = { ...entry, turnCount: prior + 1, lastActive: now }
  if (typeof entry.title !== 'string' || entry.title === '') {
    const title = Array.from(message.trim()).slice(0, TITLE_MAX_CHARS).join('')
    if (title !== '') next.title = title
  }
  return next
}

function emptyRegistry(): RegistryFile {
  return { version: 1, sessions: [] }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function blockText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.text).join('')
}

/** Resolve once `promise` settles or `ms` elapses, whichever comes first. Never rejects. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const elapsed = new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.ceil(ms)) })
  try {
    await Promise.race([promise.then(() => undefined, () => undefined), elapsed])
  } finally {
    clearTimeout(timer)
  }
}

/** The caller's signal joined with the pool-owned window controller. */
function windowSignal(controller: AbortController, signal: AbortSignal | undefined): AbortSignal {
  return signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function sameArgs(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function isRegistryFile(value: unknown): value is RegistryFile {
  return typeof value === 'object' && value !== null
    && Reflect.get(value, 'version') === 1
    && Array.isArray(Reflect.get(value, 'sessions'))
}

/**
 * Durable, atomically-written chat registry. Single-writer (this pool).
 * A missing file is an empty registry. An unreadable, unparsable, or
 * mis-shaped file is renamed to `<path>.corrupt-<timestamp>` and the pool
 * continues with an empty registry, reporting through `onWarn`.
 */
class ChatRegistry {
  private file: RegistryFile

  constructor(private readonly path: string, onWarn: ((message: string) => void) | undefined) {
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error: unknown) {
      if (Reflect.get(toError(error), 'code') === 'ENOENT') {
        this.file = emptyRegistry()
        return
      }
      this.file = this.setAside(`unreadable (${toError(error).message})`, onWarn)
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error: unknown) {
      this.file = this.setAside(`not valid JSON (${toError(error).message})`, onWarn)
      return
    }
    this.file = isRegistryFile(parsed)
      ? parsed
      : this.setAside('not a version 1 registry with a sessions array', onWarn)
  }

  private setAside(reason: string, onWarn: ((message: string) => void) | undefined): RegistryFile {
    const target = `${this.path}.corrupt-${Date.now()}`
    try {
      renameSync(this.path, target)
      onWarn?.(`acp-resume: registry ${this.path} is ${reason}; moved to ${target}, starting with an empty registry`)
    } catch (error: unknown) {
      onWarn?.(`acp-resume: registry ${this.path} is ${reason} and could not be moved to ${target} (${toError(error).message}); starting with an empty registry, the next write replaces the file`)
    }
    return emptyRegistry()
  }

  all(): readonly RegistryEntry[] {
    return this.file.sessions
  }

  get(chatId: string): RegistryEntry | undefined {
    return this.file.sessions.find(s => s.chatId === chatId)
  }

  remove(chatId: string): void {
    this.write({ version: 1, sessions: this.file.sessions.filter(s => s.chatId !== chatId) })
  }

  upsert(entry: RegistryEntry): void {
    const next = this.file.sessions.filter(s => s.chatId !== entry.chatId)
    next.push(entry)
    this.write({ version: 1, sessions: next })
  }

  private write(next: RegistryFile): void {
    this.file = next
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(next, undefined, 2))
    renameSync(tmp, this.path)
  }
}

/**
 * The persistent ACP chat pool. One instance per plugin; chats are addressed
 * by their parent-minted chatId and survive process release, pool
 * reconstruction, and host restarts through the registry file.
 */
export class AcpSessionPool {
  private readonly live = new Map<string, LiveChat>()
  /**
   * Open windows in progress (`start` and reconnects), keyed by chatId. Each
   * promise settles only after its connection is tracked or disposed. Teardown
   * aborts the window's controller (the startup race then disposes the child)
   * and waits at most `disposeGraceMs`; a window that settles later with a
   * connection sees its aborted controller and discards it.
   */
  private readonly starting = new Map<string, OpenWindow>()
  private readonly registry: ChatRegistry
  private disposed = false

  constructor(private readonly opts: PoolOptions) {
    const idle = opts.idleTimeoutMs
    if (!Number.isFinite(idle) || idle <= 0 || idle > MAX_TIMER_DELAY_MS) {
      throw new Error(`acp-resume: idleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
    }
    this.registry = new ChatRegistry(opts.registryPath, opts.onWarn)
  }

  /** Registry rows (durable chats, live or released). */
  listChats(): readonly PooledChatInfo[] {
    return this.registry.all().map(e => ({
      chatId: e.chatId,
      remoteSessionId: e.remoteSessionId,
      cwd: e.cwd,
      ...(typeof e.label === 'string' && e.label !== '' ? { label: e.label } : {}),
      ...(typeof e.title === 'string' && e.title !== '' ? { title: e.title } : {}),
      ...(typeof e.turnCount === 'number' ? { turnCount: e.turnCount } : {}),
      active: this.live.has(e.chatId),
      lastActive: e.lastActive,
    }))
  }

  /** Does the chatId exist in the durable registry? */
  knows(chatId: string): boolean {
    return this.registry.get(chatId) !== undefined
  }

  /** Start a fresh durable chat: new process, new remote session. */
  async start(cwd: string, signal?: AbortSignal, options: PoolStartOptions = {}): Promise<PooledChatInfo> {
    this.assertLive()
    // Fail loud at the earliest resolvable point, mirroring the official provider start.
    assertUsableCwd('acp-resume', 'chat cwd', cwd)
    const label = options.label?.trim() ?? ''
    const chatId = `chat-${randomUUID()}`
    const now = Date.now()
    const controller = new AbortController()
    const opening = (async (): Promise<AcpConnection> => {
      const conn = await openAcpConnection({ ...this.opts.specBase, cwd }, { mode: 'new' }, windowSignal(controller, signal))
      if (this.disposed) await this.discard(conn, 'acp-resume: pool already disposed')
      if (controller.signal.aborted) await this.discard(conn, `acp-resume: chat ${chatId} was released before it started`)
      this.registry.upsert({
        chatId,
        remoteSessionId: conn.remoteSessionId,
        cwd,
        ...(label === '' ? {} : { label }),
        command: this.opts.specBase.command,
        args: this.opts.specBase.args,
        lastActive: now,
      })
      this.track(chatId, conn)
      return conn
    })()
    this.starting.set(chatId, { promise: opening, controller })
    let conn: AcpConnection
    try {
      conn = await opening
    } catch (error: unknown) {
      this.assertLive()
      throw error
    } finally {
      this.starting.delete(chatId)
    }
    this.assertLive()
    return { chatId, remoteSessionId: conn.remoteSessionId, cwd, ...(label === '' ? {} : { label }), active: true, lastActive: now }
  }

  /**
   * Send one message to a durable chat, reconnecting through `session/load`
   * when no live process exists. A protocol-level `session/load` rejection
   * answers from a FRESH remote session (`freshSession: true`); any other
   * reconnect failure rejects and keeps the saved remote session id.
   * Rejects while another prompt on the same chat is in flight, and rejects
   * an already-aborted signal without touching the chat's connection. The
   * in-flight claim is taken synchronously within this call (before its first
   * await) unless a release of the chat is already underway.
   */
  async send(chatId: string, message: string, signal?: AbortSignal, hooks: PoolSendHooks = {}): Promise<PoolSendResult> {
    this.assertLive()
    if (isAborted(signal)) throw new Error('acp-resume: send aborted before it started')
    if (this.registry.get(chatId) === undefined) throw new Error(`acp-resume: unknown chat ${chatId}`)
    const existing = this.live.get(chatId)
    if (existing?.busy === true || this.starting.has(chatId)) {
      throw new Error(`acp-resume: chat ${chatId} already has a prompt in flight`)
    }
    if (existing?.closing !== undefined) {
      // A release is underway: let it finish, then take the released path.
      await existing.closing.catch(() => undefined)
      return this.send(chatId, message, signal, hooks)
    }
    if (existing?.conn.processSettled === true) {
      // The process already exited: release the dead connection and reconnect.
      await this.close(chatId).catch((error: unknown) => { this.report(error) })
      return this.send(chatId, message, signal, hooks)
    }

    let freshSession = false
    if (existing === undefined) {
      const entry = this.registry.get(chatId) as RegistryEntry
      this.assertSameAgent(entry)
      const released = `acp-resume: chat ${chatId} was released before the prompt started`
      // Claim the open window BEFORE awaiting: a concurrent send on this chat
      // must be rejected above, not leak a second connection.
      const controller = new AbortController()
      const reconnect = (async (): Promise<boolean> => {
        const opened = await this.reopen(entry, windowSignal(controller, signal))
        if (this.disposed) await this.discard(opened.conn, 'acp-resume: pool already disposed')
        if (controller.signal.aborted) await this.discard(opened.conn, released)
        const current = this.registry.get(chatId)
        if (current === undefined) await this.discard(opened.conn, `acp-resume: chat ${chatId} was removed while reconnecting`)
        else if (opened.fresh) {
          this.registry.upsert({ ...current, remoteSessionId: opened.conn.remoteSessionId, lastActive: Date.now() })
        }
        this.track(chatId, opened.conn)
        return opened.fresh
      })()
      this.starting.set(chatId, { promise: reconnect, controller })
      try {
        freshSession = await reconnect
      } catch (error: unknown) {
        // A teardown-aborted window reports the teardown, not the startup race's abort text.
        this.assertLive()
        if (controller.signal.aborted && !isAborted(signal)) throw new Error(released, { cause: error })
        throw error
      } finally {
        this.starting.delete(chatId)
      }
      this.assertLive()
      if (freshSession && hooks.onFreshSession !== undefined) {
        try { hooks.onFreshSession() } catch { /* an observer cannot break the send */ }
      }
    }

    const chat = this.live.get(chatId)
    if (chat === undefined || chat.closing !== undefined) {
      throw new Error(`acp-resume: chat ${chatId} was released before the prompt started`)
    }
    const conn = chat.conn
    chat.busy = true
    this.clearIdleTimer(chat)
    const turnPromise = conn.prompt([{ type: 'text', text: message }], signal ?? new AbortController().signal, hooks.onText)
    chat.busyPromise = turnPromise
    try {
      const turn = await turnPromise
      // Re-read: a purge during the turn must not be resurrected by this update.
      const current = this.registry.get(chatId)
      if (current !== undefined) this.registry.upsert(settledEntry(current, turn.stopReason, message, Date.now()))
      // A cancelled turn leaves the connection's stream state indeterminate: ACP
      // updates carry no turn identity, so a late chunk from the cancelled turn
      // would pollute the next turn on the SAME connection. A failed turn usually
      // means a dead or broken child. The official one-shot answers both with
      // process teardown; the pool does the same and lets the next send rebuild
      // context through session/load. The turn result outranks a teardown failure.
      if (turn.stopReason === 'aborted' || turn.stopReason === 'error') {
        await this.close(chatId).catch((error: unknown) => { this.report(error) })
      }
      return {
        chatId,
        remoteSessionId: conn.remoteSessionId,
        output: blockText(turn.output),
        stopReason: turn.stopReason,
        freshSession,
        diagnostic: turn.diagnostic,
      }
    } finally {
      chat.busy = false
      chat.busyPromise = undefined
      if (!this.disposed) this.armIdle(chat)
    }
  }

  /**
   * Synchronous preflight with the same verdicts {@link send} reaches before
   * it claims the chat: throws when the pool is disposed, the chat is unknown,
   * a prompt is already in flight on it, or (for a released chat) its record
   * belongs to another agent command. Lets a caller refuse a send before
   * committing to background work.
   */
  assertSendable(chatId: string): void {
    this.assertLive()
    const entry = this.registry.get(chatId)
    if (entry === undefined) throw new Error(`acp-resume: unknown chat ${chatId}`)
    const existing = this.live.get(chatId)
    if (existing?.busy === true || this.starting.has(chatId)) {
      throw new Error(`acp-resume: chat ${chatId} already has a prompt in flight`)
    }
    if (existing === undefined) this.assertSameAgent(entry)
  }

  /**
   * Queue a steering message into the chat's in-flight turn. Needs a live
   * connection with a turn in flight; it neither claims the chat nor touches
   * the turn, so several steers may be sent while a turn runs (the agent
   * queues them in order).
   * @throws when the pool is disposed, the chat is unknown, or no turn is in
   *   flight; {@link AcpSteerUnsupportedError} when the agent lacks `_session/steer`.
   */
  async steer(chatId: string, message: string): Promise<AcpSteerResult> {
    this.assertLive()
    if (this.registry.get(chatId) === undefined) throw new Error(`acp-resume: unknown chat ${chatId}`)
    const chat = this.live.get(chatId)
    if (chat === undefined || !chat.busy || chat.closing !== undefined) {
      throw new Error(`acp-resume: chat ${chatId} has no turn in flight, so there is nothing to steer; use send instead`)
    }
    return chat.conn.steer(message)
  }

  /**
   * Release the process AND delete the durable record (cannot reconnect
   * afterwards). If the release fails, the record is kept and the error says so.
   */
  async remove(chatId: string): Promise<void> {
    try {
      await this.close(chatId)
    } catch (error: unknown) {
      throw new Error(`acp-resume: releasing chat ${chatId} failed; its record is kept: ${toError(error).message}`, { cause: error })
    }
    this.registry.remove(chatId)
  }

  /**
   * Release the chat's process; the registry entry survives for reconnect.
   * An open window in progress is aborted and awaited for up to
   * `disposeGraceMs` (the aborted startup disposes its own child). An
   * in-flight turn is cancelled (`session/cancel`) and given up to
   * `disposeGraceMs` to settle before the process is torn down.
   */
  async close(chatId: string): Promise<void> {
    const pending = this.starting.get(chatId)
    if (pending !== undefined) await this.abortWindow(pending)
    const chat = this.live.get(chatId)
    if (chat === undefined) return
    chat.closing ??= this.release(chatId, chat)
    return chat.closing
  }

  /**
   * Stop admission, abort open windows (each wait bounded by
   * `disposeGraceMs`), cancel in-flight turns (bounded the same way), then
   * release every live process. Registry survives.
   */
  async disposeAll(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.starting.values()].map(window => this.abortWindow(window)))
    await Promise.allSettled([...this.live.keys()].map(id => this.close(id)))
  }

  /** Abort an open window and wait for it to settle, at most `disposeGraceMs`. */
  private async abortWindow(window: OpenWindow): Promise<void> {
    window.controller.abort(new Error('acp-resume: open window aborted by pool teardown'))
    await settleWithin(window.promise, this.opts.specBase.disposeGraceMs)
  }

  /** A saved session is only reloaded by the agent that created it. */
  private assertSameAgent(entry: RegistryEntry): void {
    const { command, args } = this.opts.specBase
    // The engine flag is not part of the fingerprint (D19): saved sessions load across engines.
    if (entry.command === command && Array.isArray(entry.args) && sameArgs(stripAgentEngine(entry.args), stripAgentEngine(args))) return
    throw new Error(
      `acp-resume: chat ${entry.chatId} was recorded for agent ${JSON.stringify([entry.command, ...(Array.isArray(entry.args) ? entry.args : [])])}, `
      + `but the plugin is now configured for ${JSON.stringify([command, ...args])}; the saved session belongs to another agent and was not loaded. `
      + 'Restore the old command/args to continue it, or start a new chat.',
    )
  }

  private async release(chatId: string, chat: LiveChat): Promise<void> {
    this.clearIdleTimer(chat)
    if (chat.busyPromise !== undefined) {
      chat.conn.notifyCancel()
      await settleWithin(chat.busyPromise, this.opts.specBase.disposeGraceMs)
    }
    if (this.live.get(chatId) === chat) this.live.delete(chatId)
    await chat.conn.dispose()
  }

  /** Reconnect a saved remote session; only a protocol-level load rejection degrades to a fresh one. */
  private async reopen(entry: RegistryEntry, signal: AbortSignal | undefined): Promise<{ conn: AcpConnection; fresh: boolean }> {
    const spec = { ...this.opts.specBase, cwd: entry.cwd }
    try {
      const conn = await openAcpConnection(spec, { mode: 'load', sessionId: entry.remoteSessionId }, signal)
      return { conn, fresh: false }
    } catch (error: unknown) {
      const sessionGone = error instanceof AcpConnectionError
        && error.stage === 'load-session'
        && error.category === 'protocol'
      if (!sessionGone) throw error
      this.assertLive()
      const conn = await openAcpConnection(spec, { mode: 'new' }, signal)
      return { conn, fresh: true }
    }
  }

  /** Dispose a connection that must not join the pool, then reject with `reason`. */
  private async discard(conn: AcpConnection, reason: string): Promise<never> {
    await conn.dispose().catch((error: unknown) => { this.report(error) })
    throw new Error(reason)
  }

  private report(error: unknown): void {
    try { this.opts.specBase.onError?.(toError(error), 'error') } catch { /* sink cannot replace the failure */ }
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('acp-resume: pool already disposed')
  }

  private track(chatId: string, conn: AcpConnection): void {
    const chat: LiveChat = { chatId, conn, idleTimer: undefined, busy: false, busyPromise: undefined, closing: undefined }
    this.live.set(chatId, chat)
    this.armIdle(chat)
  }

  private armIdle(chat: LiveChat): void {
    // A released (or replaced) chat object must not re-arm a timer.
    if (chat.busy || chat.closing !== undefined || this.live.get(chat.chatId) !== chat) return
    this.clearIdleTimer(chat)
    chat.idleTimer = setTimeout(() => {
      this.close(chat.chatId).catch((error: unknown) => { this.report(error) })
    }, this.opts.idleTimeoutMs)
    chat.idleTimer.unref()
  }

  private clearIdleTimer(chat: LiveChat): void {
    if (chat.idleTimer !== undefined) {
      clearTimeout(chat.idleTimer)
      chat.idleTimer = undefined
    }
  }
}
