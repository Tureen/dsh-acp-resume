/**
 * Host half of the persistent-chat side panel (D15, PANEL-DESIGN §3.6.1). A
 * Cordis service under key `acpResume` exposes five Remote methods over the
 * official Typert Gateway's source-mode discovery, so no generated artifact is
 * needed: `acpResume/list`, `acpResume/close`, and `acpResume/purge` (wire
 * name `purge`, not `remove`, which collides with the Client namespace
 * service; §3.6.0 #2), plus the detail page's reads (D18): `acpResume/turns`
 * (one chat's registry row and its newest turn-log entries as previews) and
 * `acpResume/turn` (one entry in full). The methods map one-to-one onto the
 * pool and own no state. Source-mode parameters accept a missing field as `undefined`, so
 * every method validates its own arguments.
 * @module dsh-acp-resume/panel
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { AcpSessionPool, PooledChatInfo } from './pool.js'
import type { LogEntry } from './turn-log.js'

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

/** Characters of a message or answer carried in a preview. */
export const PREVIEW_CHARS = 120
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
  readonly stopReason: string
  readonly freshSession: boolean
  readonly diagnostic?: string
}

/** A reconnect event as the detail list shows it. */
export interface EventSummary {
  readonly seq: number
  readonly kind: 'event'
  readonly event: 'session-lost' | 'reconnect-failed'
  readonly at: number
  readonly message?: string
  readonly error?: string
}

/** What `acpResume/turns` returns. */
export interface ChatTurns {
  /** The chat's registry row (liveness, label, counts), so the page needs no second call. */
  readonly chat: PooledChatInfo
  /** The newest `limit` entries, oldest first. */
  readonly entries: readonly (TurnSummary | EventSummary)[]
  /** Entries the log retains for this chat (≥ `entries.length`). */
  readonly total: number
}

function preview(text: string): { text: string; more: boolean } {
  const trimmed = text.trim()
  const chars = Array.from(trimmed)
  return chars.length > PREVIEW_CHARS
    ? { text: chars.slice(0, PREVIEW_CHARS).join(''), more: true }
    : { text: trimmed, more: false }
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
    stopReason: entry.stopReason, freshSession: entry.freshSession,
    ...(entry.diagnostic === undefined ? {} : { diagnostic: entry.diagnostic }),
  }
}

/** Panel Remote surface over one session pool. */
export class AcpResumePanelService extends TypertRemoteService {
  /**
   * Register under {@link PANEL_SERVICE_KEY}; the registration follows `ctx`'s fiber.
   * @param ctx - owning Cordis context.
   * @param pool - the plugin's session pool, the single source of truth.
   */
  constructor(ctx: Context, private readonly pool: AcpSessionPool) {
    super(ctx, PANEL_SERVICE_KEY)
  }

  /** Every durable chat, live or released, as the pool reports it. */
  @Remote
  list(): readonly PooledChatInfo[] {
    return this.pool.listChats()
  }

  /** Release the chat's process; its record stays and the next send reconnects. */
  @Remote
  async close(chatId: string): Promise<null> {
    await this.pool.close(this.knownChat(chatId))
    return null
  }

  /** Release the chat's process and delete its record; it cannot reconnect afterwards. */
  @Remote
  async purge(chatId: string): Promise<null> {
    await this.pool.remove(this.knownChat(chatId))
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
    return {
      chat: this.pool.chatInfo(id) as PooledChatInfo,
      entries: all.slice(-count).map(summarize),
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
