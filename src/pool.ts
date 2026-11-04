/**
 * Persistent ACP session pool: the asset behind the continuable chat tools.
 * Each pooled chat owns one remote agent session (spawned process kept alive
 * between turns), a durable registry entry (remote session id + cwd, so a
 * dead process reconnects through `session/load`), an idle timer that
 * releases the process while PRESERVING the registry, and single-flight
 * prompt semantics per chat. A failed reconnect falls back to a fresh remote
 * session and reports it.
 *
 * @module dsh-acp-resume/pool
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AcpConnection } from './connection.js'
import { openAcpConnection } from './connection.js'
import { assertUsableCwd } from '@deepseek-ai/dsh-subagent'
import type { AcpRunSpec } from './run.js'

/** One pooled chat as reportable state (registry projection + liveness). */
export interface PooledChatInfo {
  readonly chatId: string
  readonly remoteSessionId: string
  readonly cwd: string
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

/** Pool construction inputs: the spawn base plus durability knobs. */
export interface PoolOptions {
  /** Everything except `cwd` of the per-run spawn spec (command/args/env/…). */
  readonly specBase: Omit<AcpRunSpec, 'cwd'>
  /** Registry file path; created (with parent dirs) on first change. */
  readonly registryPath: string
  /** Idle window after a settled turn before the process is released. */
  readonly idleTimeoutMs: number
}

interface RegistryEntry {
  chatId: string
  remoteSessionId: string
  cwd: string
  command: string
  args: readonly string[]
  lastActive: number
}

interface RegistryFile {
  version: 1
  sessions: RegistryEntry[]
}

/** A pooled chat's live state (absent while released). */
interface LiveChat {
  conn: AcpConnection
  idleTimer: NodeJS.Timeout | undefined
  busy: boolean
  /** The in-flight turn's promise, awaited by disposeAll before releasing. */
  busyPromise: Promise<unknown> | undefined
}

function emptyRegistry(): RegistryFile {
  return { version: 1, sessions: [] }
}

function blockText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.text).join('')
}

/** Durable, atomically-written chat registry. Single-writer (this pool). */
class ChatRegistry {
  private file: RegistryFile

  constructor(private readonly path: string) {
    try {
      this.file = JSON.parse(readFileSync(path, 'utf8')) as RegistryFile
    } catch {
      this.file = emptyRegistry()
    }
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
  /** Reconnect windows in progress; a concurrent send on the same chat is rejected. */
  private readonly starting = new Map<string, Promise<AcpConnection>>()
  private readonly registry: ChatRegistry
  private disposed = false

  constructor(private readonly opts: PoolOptions) {
    this.registry = new ChatRegistry(opts.registryPath)
  }

  /** Registry rows (durable chats, live or released). */
  listChats(): readonly PooledChatInfo[] {
    return this.registry.all().map(e => ({
      chatId: e.chatId,
      remoteSessionId: e.remoteSessionId,
      cwd: e.cwd,
      active: this.live.has(e.chatId),
      lastActive: e.lastActive,
    }))
  }

  /** Does the chatId exist in the durable registry? */
  knows(chatId: string): boolean {
    return this.registry.get(chatId) !== undefined
  }

  /** Start a fresh durable chat: new process, new remote session. */
  async start(cwd: string, signal?: AbortSignal): Promise<PooledChatInfo> {
    this.assertLive()
    // Fail loud at the earliest resolvable point, mirroring the official provider start.
    assertUsableCwd('acp-resume', 'chat cwd', cwd)
    const conn = await openAcpConnection({ ...this.opts.specBase, cwd }, { mode: 'new' }, signal)
    const chatId = `chat-${randomUUID()}`
    const now = Date.now()
    this.registry.upsert({
      chatId,
      remoteSessionId: conn.remoteSessionId,
      cwd,
      command: this.opts.specBase.command,
      args: this.opts.specBase.args,
      lastActive: now,
    })
    this.track(chatId, conn)
    return { chatId, remoteSessionId: conn.remoteSessionId, cwd, active: true, lastActive: now }
  }

  /**
   * Send one message to a durable chat, reconnecting through `session/load`
   * when no live process exists. A rejected reconnect answers from a FRESH
   * remote session (`freshSession: true`) instead of failing the send.
   * Rejects while another prompt on the same chat is in flight.
   */
  async send(chatId: string, message: string, signal?: AbortSignal): Promise<PoolSendResult> {
    this.assertLive()
    const entry = this.registry.get(chatId)
    if (entry === undefined) throw new Error(`acp-resume: unknown chat ${chatId}`)
    const existing = this.live.get(chatId)
    if (existing?.busy === true || this.starting.has(chatId)) {
      throw new Error(`acp-resume: chat ${chatId} already has a prompt in flight`)
    }

    let conn: AcpConnection | undefined = existing?.conn
    let freshSession = false
    if (conn === undefined) {
      const spec = { ...this.opts.specBase, cwd: entry.cwd }
      // Claim the reconnect window BEFORE awaiting: a concurrent send on this
      // chat must be rejected here, not leak a second connection.
      const reconnect = (async (): Promise<AcpConnection> => {
        try {
          return await openAcpConnection(spec, { mode: 'load', sessionId: entry.remoteSessionId }, signal)
        } catch {
          // The remote session is gone (expired, cleaned, or the agent lost it):
          // degrade to a fresh session and persist the replacement id.
          const fresh = await openAcpConnection(spec, { mode: 'new' }, signal)
          freshSession = true
          this.registry.upsert({ ...entry, remoteSessionId: fresh.remoteSessionId, lastActive: Date.now() })
          return fresh
        }
      })()
      this.starting.set(chatId, reconnect)
      try {
        conn = await reconnect
        this.track(chatId, conn)
      } finally {
        this.starting.delete(chatId)
      }
    }

    const chat = this.live.get(chatId) as LiveChat
    chat.busy = true
    this.clearIdle(chatId)
    const turnPromise = conn.prompt([{ type: 'text', text: message }], signal ?? new AbortController().signal)
    chat.busyPromise = turnPromise
    try {
      const turn = await turnPromise
      const now = Date.now()
      const current = this.registry.get(chatId) ?? entry
      this.registry.upsert({ ...current, lastActive: now })
      // A cancelled turn leaves the connection's stream state indeterminate: ACP
      // updates carry no turn identity, so a late chunk from the cancelled turn
      // would pollute the next turn on the SAME connection. The official one-shot
      // answers cancellation with process teardown; the pool does the same and
      // lets the next send rebuild context through session/load.
      if (turn.stopReason === 'aborted') {
        this.registry.upsert({ ...current, lastActive: now })
        await this.close(chatId)
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
      if (!this.disposed) this.armIdle(chatId)
    }
  }

  /** Release the process AND delete the durable record (cannot reconnect afterwards). */
  async remove(chatId: string): Promise<void> {
    await this.close(chatId)
    this.registry.remove(chatId)
  }

  /** Release the chat's process; the registry entry survives for reconnect. */
  async close(chatId: string): Promise<void> {
    const chat = this.live.get(chatId)
    if (chat === undefined) return
    this.live.delete(chatId)
    this.clearIdleTimer(chat)
    await chat.conn.dispose()
  }

  /** Stop admission, let in-flight turns settle, then release every live process. Registry survives. */
  async disposeAll(): Promise<void> {
    this.disposed = true
    const busy = [...this.live.values()]
      .map(c => c.busyPromise)
      .filter((p): p is Promise<unknown> => p !== undefined)
    await Promise.allSettled(busy)
    await Promise.allSettled([...this.live.keys()].map(id => this.close(id)))
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('acp-resume: pool already disposed')
  }

  private track(chatId: string, conn: AcpConnection): void {
    this.live.set(chatId, { conn, idleTimer: undefined, busy: false, busyPromise: undefined })
    this.armIdle(chatId)
  }

  private armIdle(chatId: string): void {
    const chat = this.live.get(chatId)
    if (chat === undefined || chat.busy) return
    this.clearIdleTimer(chat)
    chat.idleTimer = setTimeout(() => {
      void this.close(chatId)
    }, this.opts.idleTimeoutMs)
    chat.idleTimer.unref()
  }

  private clearIdle(chatId: string): void {
    const chat = this.live.get(chatId)
    if (chat !== undefined) this.clearIdleTimer(chat)
  }

  private clearIdleTimer(chat: LiveChat): void {
    if (chat.idleTimer !== undefined) {
      clearTimeout(chat.idleTimer)
      chat.idleTimer = undefined
    }
  }
}
