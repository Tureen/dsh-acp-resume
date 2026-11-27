/**
 * Host half of the persistent-chat side panel (D15, PANEL-DESIGN §3.6.1). A
 * Cordis service under key `acpResume` exposes Remote methods over the
 * official Typert Gateway's source-mode discovery, so no generated artifact is
 * needed: `acpResume/list`, `acpResume/close`, and `acpResume/purge` (wire
 * name `purge`, not `remove`, which collides with the Client namespace
 * service; §3.6.0 #2), plus the detail page's reads (D18): `acpResume/turns`
 * (one chat's registry row and its newest turn-log entries as previews) and
 * `acpResume/turn` (one entry in full), `acpResume/usage` (D28: every
 * backend's quota through the shared cache), and `acpResume/workflows` (D29:
 * one session's running and recent workflow runs). Backend readiness has a
 * side-effect-free `acpResume/backends` snapshot and an explicit bounded
 * `acpResume/checkBackends` action. The panel owns no state. Source-mode
 * parameters accept a missing field as `undefined`, so
 * every method validates its own arguments.
 * @module dsh-acp-resume/panel
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { BackendStatusService, BackendStatusSnapshot } from './backend-status.js'
import type { LiveFrame } from './live-buffer.js'
import type { ChatOptions } from './chat-options.js'
import type { AcpSessionPool, PooledChatInfo, SessionWorkflows } from './pool.js'
import type { PanelFeatures } from './panel-features.js'
import type { LogEntry } from './turn-log.js'
import type { BackendUsage, UsageService } from './usage.js'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The chatId names no chat in the registry (already purged, or never existed). */
    'acp-resume/unknown-chat': { readonly chatId: string }
    /** The chat exists but its turn log holds no entry with this seq (never written, or trimmed away). */
    'acp-resume/unknown-turn': { readonly chatId: string; readonly seq: number }
  }
}

/** Cordis service key and wire namespace of the panel Remote methods. */
export const PANEL_SERVICE_KEY = 'acpResume'

/** Characters of a message or answer carried in a preview (D47: raised from 120 to 320). */
export const PREVIEW_CHARS = 320
/** Entries `turns` returns when `limit` is omitted. */
export const DEFAULT_TURNS_LIMIT = 50
/** Largest `limit` `turns` accepts. */
export const MAX_TURNS_LIMIT = 200

/** One turn as the detail list shows it: previews, with flags telling whether the full text is longer. */
export interface TurnSummary {
  readonly seq: number
  readonly kind: 'turn'
  readonly startedAt: number
  readonly at: number
  readonly message: string
  readonly output: string
  /** The full message is longer than the preview. */
  readonly messageMore: boolean
  readonly outputMore: boolean
  /** Non-empty line count of the full answer text in the turn log (D47, optional for older hosts). */
  readonly outputLines?: number
  readonly stopReason: string
  readonly freshSession: boolean
  readonly diagnostic?: string
}

/** A reconnect event as the detail list shows it. */
export interface EventSummary {
  readonly seq: number
  readonly kind: 'event'
  readonly event: 'session-lost' | 'session-reset-after-errors' | 'reconnect-failed'
  readonly at: number
  readonly message?: string
  readonly error?: string
}

export interface RunningSummary {
  readonly kind: 'running'
  /** Full user message, held only in memory; the client owns presentation truncation. */
  readonly message: string
  readonly startedAt: number
}

/** What `acpResume/turns` returns. */
export interface ChatTurns {
  /** The chat's registry row (liveness, label, counts), so the page needs no second call. */
  readonly chat: PooledChatInfo
  /** Newest retained log entries, oldest first, with a volatile running entry first when present. */
  readonly entries: readonly (RunningSummary | TurnSummary | EventSummary)[]
  /** Retained log entries only; the synthetic running item is not counted. */
  readonly total: number
}

function preview(text: string): { text: string; more: boolean } {
  const trimmed = text.trim()
  const chars = Array.from(trimmed)
  return chars.length > PREVIEW_CHARS
    ? { text: chars.slice(0, PREVIEW_CHARS).join(''), more: true }
    : { text: trimmed, more: false }
}

function countNonEmptyLines(text: string): number {
  return text.split('\n').filter(line => line.trim() !== '').length
}

function summarize(entry: LogEntry): TurnSummary | EventSummary {
  if (entry.kind === 'event') {
    return {
      seq: entry.seq, kind: 'event', event: entry.event, at: entry.at,
      ...(entry.message === undefined ? {} : { message: preview(entry.message).text }),
      ...(entry.error === undefined ? {} : { error: entry.error }),
    }
  }
  const message = preview(entry.message)
  const output = preview(entry.output)
  return {
    seq: entry.seq, kind: 'turn', startedAt: entry.startedAt, at: entry.at,
    message: message.text, output: output.text,
    messageMore: message.more || entry.messageTruncated === true,
    outputMore: output.more || entry.outputTruncated === true,
    outputLines: countNonEmptyLines(entry.output),
    stopReason: entry.stopReason, freshSession: entry.freshSession,
    ...(entry.diagnostic === undefined ? {} : { diagnostic: entry.diagnostic }),
  }
}

/** Configuration-only Remote available for the entire host plugin lifetime (D35). */
export class AcpResumeInfoService extends TypertRemoteService {
  constructor(ctx: Context, private readonly panelFeatures: PanelFeatures) {
    super(ctx, 'acpResumeInfo')
  }

  /** Read effective feature switches without allocating a pool or probing a backend. */
  @Remote
  features(): PanelFeatures {
    return { ...this.panelFeatures }
  }
}

/** Panel Remote surface over one session pool. */
export class AcpResumePanelService extends TypertRemoteService {
  /**
   * Register under {@link PANEL_SERVICE_KEY}; the registration follows `ctx`'s fiber.
   * @param ctx - owning Cordis context.
   * @param pool - the plugin's session pool, the single source of truth.
   * @param usageService - optional quota data owner.
   * @param backendStatus - optional readiness data owner and bounded checker.
   */
  constructor(
    ctx: Context,
    private readonly pool: AcpSessionPool,
    private readonly usageService?: UsageService,
    private readonly backendStatus?: BackendStatusService,
  ) {
    super(ctx, PANEL_SERVICE_KEY)
  }

  /** Read the current readiness snapshot without starting discovery or any process. */
  @Remote
  backends(): BackendStatusSnapshot {
    return this.withLiveReports(this.backendStatus?.snapshot() ?? { backends: [], checking: false, dispatchEnabled: false })
  }

  /** An explicit user action; the readiness service owns the probe limits and cleanup. */
  @Remote
  async checkBackends(): Promise<BackendStatusSnapshot> {
    return this.backendStatus ? this.withLiveReports(await this.backendStatus.check()) : this.backends()
  }

  private withLiveReports(snapshot: BackendStatusSnapshot): BackendStatusSnapshot {
    const live = this.pool.liveBackendReports()
    if (!live.size) return snapshot
    return { ...snapshot, backends: snapshot.backends.map(row => {
      const report = live.get(row.id)
      return report ? { ...row, report } : row
    }) }
  }

  /**
   * One session's workflows (D29): running in this pool instance, and the newest finished ones.
   * @param ownerSessionId - the DSH session the panel shows.
   */
  @Remote
  workflows(ownerSessionId: string): SessionWorkflows {
    if (typeof ownerSessionId !== 'string' || ownerSessionId === '') {
      throw new RemoteError('gateway/bad-request', 'acp-resume: ownerSessionId must be a non-empty string', {})
    }
    return this.pool.listWorkflows(ownerSessionId)
  }

  /**
   * Every backend's quota (D28), through the shared usage cache.
   * @param refresh - skip the cache; omitted means use it.
   */
  @Remote
  async usage(refresh: boolean): Promise<readonly BackendUsage[]> {
    if (refresh !== undefined && typeof refresh !== 'boolean') {
      throw new RemoteError('gateway/bad-request', 'acp-resume: refresh must be a boolean', {})
    }
    if (this.usageService === undefined) return []
    return this.usageService.read(refresh === true ? { refresh: true } : {})
  }

  /** Every durable chat, live or released, as the pool reports it. */
  @Remote
  list(): readonly PooledChatInfo[] {
    return this.pool.listChats()
  }

  /** Release the chat's process; its record stays and the next send reconnects. */
  @Remote
  async close(chatId: string, sessionId?: string): Promise<null> {
    await this.pool.close(this.ownedChat(chatId, sessionId))
    return null
  }

  /** Release the chat's process and delete its record; it cannot reconnect afterwards. */
  @Remote
  async purge(chatId: string, sessionId?: string): Promise<null> {
    await this.pool.remove(this.ownedChat(chatId, sessionId))
    return null
  }

  /**
   * One chat's registry row plus its newest turn-log entries as previews.
   * @param chatId - a known chat.
   * @param limit - how many newest entries to return (integer 1–{@link MAX_TURNS_LIMIT}); omitted means {@link DEFAULT_TURNS_LIMIT}.
   */
  @Remote
  turns(chatId: string, limit: number): ChatTurns {
    const id = this.knownChat(chatId)
    const count = limit === undefined ? DEFAULT_TURNS_LIMIT : limit
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > MAX_TURNS_LIMIT) {
      throw new RemoteError('gateway/bad-request', `acp-resume: limit must be an integer from 1 to ${MAX_TURNS_LIMIT}`, {})
    }
    const all = this.pool.turnEntries(id)
    const chat = this.pool.chatInfo(id) as PooledChatInfo
    return {
      chat,
      entries: [
        ...(chat.inFlight === undefined ? [] : [{ kind: 'running' as const, message: chat.inFlight.message, startedAt: chat.inFlight.startedAt }]),
        ...all.slice(-count).map(summarize),
      ],
      total: all.length,
    }
  }

  /**
   * One turn-log entry in full (message and answer untruncated up to the log's caps).
   * @param chatId - a known chat.
   * @param seq - the entry's seq from a `turns` answer.
   */
  @Remote
  turn(chatId: string, seq: number): LogEntry {
    const id = this.knownChat(chatId)
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq)) {
      throw new RemoteError('gateway/bad-request', 'acp-resume: seq must be an integer', {})
    }
    const entry = this.pool.turnEntries(id).find(candidate => candidate.seq === seq)
    if (entry === undefined) {
      throw new RemoteError('acp-resume/unknown-turn', `acp-resume: chat ${id} has no log entry ${seq}`, { chatId: id, seq })
    }
    return entry
  }

  /** Read-only like turns/turn. Keep sessionId in the SRC wire signature for existing viewers. */
  // A bare @Remote is unary under SRC reflection; watch requires the stream carrier.
  @Remote({ mode: 'stream' })
  async *watch(chatId: string, sessionId: string, signal: AbortSignal): AsyncIterable<LiveFrame> {
    const id = this.knownChat(chatId)
    if (signal.aborted) return
    const live = this.pool.subscribeLive(id)
    signal.addEventListener('abort', live.close, { once: true })
    try { yield* live.frames } finally {
      signal.removeEventListener('abort', live.close)
      live.close()
    }
  }

  /** Read the reported options available to this seat without calling the backend. */
  @Remote
  chatOptions(chatId: string, sessionId?: string): ChatOptions {
    return this.pool.chatOptions(this.ownedChat(chatId, sessionId))
  }

  /** Change the model on the existing idle connection and wait for backend confirmation. */
  @Remote
  async setChatModel(chatId: string, model: string, sessionId?: string): Promise<null> {
    const id = this.ownedChat(chatId, sessionId)
    return this.settingResult(this.pool.setChatModel(id, model))
  }

  /** Change effort within the catalog offered for the current model. */
  @Remote
  async setChatEffort(chatId: string, effort: string, sessionId?: string): Promise<null> {
    const id = this.ownedChat(chatId, sessionId)
    return this.settingResult(this.pool.setChatEffort(id, effort))
  }

  private async settingResult(operation: Promise<void>): Promise<null> {
    try { await operation; return null } catch (error) {
      throw new RemoteError('gateway/bad-request', error instanceof Error ? error.message : 'could not change the session setting', {})
    }
  }

  private ownedChat(chatId: unknown, sessionId: unknown): string {
    const id = this.knownChat(chatId)
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new RemoteError('gateway/bad-request', 'current DSH sessionId is required; upgrade the ACP Resume plugin and reopen the panel', {})
    }
    if (this.pool.chatOwner(id) !== sessionId) throw new RemoteError('gateway/bad-request', `chat ${id} belongs to another DSH session`, {})
    return id
  }

  private knownChat(chatId: unknown): string {
    if (typeof chatId !== 'string' || chatId === '') {
      throw new RemoteError('gateway/bad-request', 'acp-resume: chatId must be a non-empty string', {})
    }
    if (!this.pool.knows(chatId)) {
      throw new RemoteError('acp-resume/unknown-chat', `acp-resume: unknown chat ${chatId}`, { chatId })
    }
    return chatId
  }
}
