/**
 * Host half of the persistent-chat side panel (D15, PANEL-DESIGN §3.6.1). A
 * Cordis service under key `acpResume` exposes three Remote methods over the
 * official Typert Gateway's source-mode discovery, so no generated artifact is
 * needed: `acpResume/list`, `acpResume/close`, and `acpResume/purge` (wire
 * name `purge`, not `remove`, which collides with the Client namespace
 * service; §3.6.0 #2). The methods map one-to-one onto the pool and own no
 * state. Source-mode parameters accept a missing field as `undefined`, so
 * every method validates its own arguments.
 * @module dsh-acp-resume/panel
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { AcpSessionPool, PooledChatInfo } from './pool.js'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The chatId names no chat in the registry (already purged, or never existed). */
    'acp-resume/unknown-chat': { readonly chatId: string }
  }
}

/** Cordis service key and wire namespace of the panel Remote methods. */
export const PANEL_SERVICE_KEY = 'acpResume'

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
