/**
 * Model-facing persistent-chat tools over the {@link AcpSessionPool}: start a
 * durable conversation, send follow-up messages (reconnecting or degrading to
 * a fresh session when the remote one is gone), list durable chats, and
 * release a chat's process while keeping its record. Tool copy speaks to the
 * model, not to the UI.
 *
 * @module dsh-acp-resume/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AcpSessionPool } from './pool.js'

const FRESH_NOTE = '\n(remote session lost; started a fresh one — prior context is gone, restate what matters)'

function describeChat(chat: { chatId: string; remoteSessionId: string; cwd: string; active: boolean; lastActive: number }): string {
  return `${chat.chatId} | remote ${chat.remoteSessionId} | ${chat.active ? 'live process' : 'released (reconnects on next send)'} | last active ${new Date(chat.lastActive).toISOString()} | cwd ${chat.cwd}`
}

/**
 * Register the four chat tools under `toolPrefix` (`acp_chat_` by default:
 * acp_chat_start / acp_chat_send / acp_chat_list / acp_chat_close).
 * @param ctx - host context carrying the tools registry.
 * @param pool - the pool the tools drive.
 * @param toolPrefix - name prefix for all four tools.
 */
/** Minimal registry face the tools need; the host provides the real service. */
export interface ToolsRegistryFace {
  register(definition: ReturnType<typeof defineTool>): () => void
}

export function registerChatTools(ctx: Context, tools: ToolsRegistryFace, pool: AcpSessionPool, toolPrefix: string): void {
  const start = defineTool({
    name: `${toolPrefix}start`,
    description: 'Start a persistent chat session with the external ACP agent (for example kiro-cli). '
      + 'Returns a chatId you reuse in later sends. The conversation context survives between messages, '
      + 'process release, and host restarts: the remote session is reconnected automatically.',
    parameters: {
      cwd: {
        type: 'string',
        required: true,
        description: 'Absolute working directory for the chat session (the agent works here).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chatId: { type: 'string', required: true },
          remoteSessionId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `chat started: ${value.chatId}` }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const chat = await pool.start(args.cwd, exec.signal)
      return { chatId: chat.chatId, remoteSessionId: chat.remoteSessionId }
    },
  })

  const send = defineTool({
    name: `${toolPrefix}send`,
    description: 'Send one message to a persistent chat started with the start tool and await its final answer. '
      + 'The chat keeps full conversation context. One prompt may be in flight per chat; wait for each answer. '
      + 'If the remote session was lost, the tool answers from a fresh session and says so in the text.',
    parameters: {
      chatId: {
        type: 'string',
        required: true,
        description: 'The chatId returned by the start tool.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The message to send. Include any context the chat needs; it remembers its own prior turns.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const result = await pool.send(args.chatId, args.message, exec.signal)
      const text = result.output
        + (result.freshSession ? FRESH_NOTE : '')
        + (result.stopReason === 'completed' ? '' : `\n(stop reason: ${result.stopReason})`)
        + (result.diagnostic === undefined ? '' : `\n${result.diagnostic}`)
      return { text }
    },
  })

  const list = defineTool({
    name: `${toolPrefix}list`,
    description: 'List the persistent ACP chats known to this harness: chatId, remote session id, liveness, '
      + 'last active time, and working directory. Released chats reconnect on their next send.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      exec.signal.throwIfAborted()
      const chats = pool.listChats()
      const text = chats.length === 0
        ? 'no persistent chats'
        : chats.map(describeChat).join('\n')
      return { text }
    },
  })

  const close = defineTool({
    name: `${toolPrefix}close`,
    description: 'Release a persistent chat\'s agent process. The chat record is KEPT: a later send reconnects it '
      + '(context restored). Use this to free resources when a conversation is paused. '
      + 'To also delete the remote session record, use the agent\'s own CLI (for kiro: kiro-cli chat --list-sessions / --delete-session).',
    parameters: {
      chatId: {
        type: 'string',
        required: true,
        description: 'The chatId to release.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!pool.knows(args.chatId)) {
        return { text: `unknown chat ${args.chatId}` }
      }
      await pool.close(args.chatId)
      return { text: `chat ${args.chatId} released; its record is kept and a later send reconnects it` }
    },
  })

  for (const definition of [start, send, list, close]) {
    ctx.effect(() => tools.register(definition))
  }
}
