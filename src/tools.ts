/**
 * Model-facing persistent-chat tools over the {@link AcpSessionPool}: start a
 * durable conversation, send follow-up messages (reconnecting or degrading to
 * a fresh session when the remote one is gone), list durable chats, and
 * release a chat's process while keeping its record. Tool copy speaks to the
 * model, not to the UI. A send whose turn did not end `completed` is thrown as
 * a tool error (official convention: non-completed ⇒ isError); a degraded
 * fresh session is a success and is flagged by a leading note line.
 *
 * @module dsh-acp-resume/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AcpSessionPool, PoolSendResult } from './pool.js'

/** Leading line on a degraded send; embeds the fixed D6 phrase. */
const FRESH_NOTE = '[remote session lost, started fresh — prior context is gone; restate what matters and re-ask]'

const EMPTY_OUTPUT = '(agent returned no text)'

/** Longest diagnostic excerpt carried into a thrown send error. */
const DIAGNOSTIC_EXCERPT_MAX = 300

/** Minimal registry face the tools need; the host provides the real service. */
export interface ToolsRegistryFace {
  register(definition: ReturnType<typeof defineTool>): () => void
}

/** `12s` / `12m` / `3h` / `2d` since `then`; clock skew reads as `0s`. */
function formatIdle(then: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - then) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** Longest label accepted by the start tool. */
const LABEL_MAX = 80

function describeChat(chat: { chatId: string; remoteSessionId: string; cwd: string; label?: string; active: boolean; lastActive: number }, now: number): string {
  const label = chat.label === undefined ? '' : ` | label ${JSON.stringify(chat.label)}`
  return `${chat.chatId}${label} | remote ${chat.remoteSessionId} | ${chat.active ? 'live process' : 'released (reconnects on next send)'} | idle ${formatIdle(chat.lastActive, now)} (${new Date(chat.lastActive).toISOString()}) | cwd ${chat.cwd}`
}

/** First line of the diagnostic, capped; empty when there is none. */
function diagnosticExcerpt(diagnostic: string | undefined): string {
  const firstLine = diagnostic?.trim().split('\n', 1)[0]?.trim() ?? ''
  if (firstLine === '') return ''
  const capped = firstLine.length > DIAGNOSTIC_EXCERPT_MAX ? `${firstLine.slice(0, DIAGNOSTIC_EXCERPT_MAX)}…` : firstLine
  return `: ${capped}`
}

/** Error for a non-completed send: headline, then any partial output the agent produced. */
function failedTurnError(result: PoolSendResult): Error {
  const fresh = result.freshSession ? `\n${FRESH_NOTE}` : ''
  const partial = result.output.trim() === '' ? '' : `\npartial output received:\n${result.output}`
  switch (result.stopReason) {
    case 'aborted':
      return new Error(`the agent stopped before finishing; the chat may hold a partial turn — check its state before resending${fresh}${partial}`)
    case 'error':
      return new Error(`the agent failed before it finished${diagnosticExcerpt(result.diagnostic)}${fresh}${partial}`)
    case 'max-tokens':
      return new Error(`the agent ran out of room before it finished its answer${fresh}${partial}`)
    case 'refusal':
      return new Error(`the agent declined to answer${fresh}${partial}`)
    default:
      return new Error(`the agent ended its turn without finishing (stop reason: ${result.stopReason})${diagnosticExcerpt(result.diagnostic)}${fresh}${partial}`)
  }
}

/**
 * Register the four chat tools under `toolPrefix` (`acp_chat_` by default:
 * acp_chat_start / acp_chat_send / acp_chat_list / acp_chat_close).
 * @param ctx - host context; owns the registrations' lifetime via `ctx.effect`.
 * @param tools - the tools registry the four definitions are registered into.
 * @param pool - the pool the tools drive.
 * @param toolPrefix - name prefix for all four tools.
 */
export function registerChatTools(ctx: Context, tools: ToolsRegistryFace, pool: AcpSessionPool, toolPrefix: string): void {
  const unknownChat = (chatId: string): Error =>
    new Error(`unknown chat ${chatId}; call ${toolPrefix}list to see known chats`)

  const start = defineTool({
    name: `${toolPrefix}start`,
    description: 'Start a persistent chat session with the external ACP agent (for example kiro-cli). '
      + `Returns a chatId you pass to ${toolPrefix}send. The conversation context usually survives between messages, `
      + `process release, and host restarts; if the agent lost the session, the next ${toolPrefix}send says so.`,
    parameters: {
      cwd: {
        type: 'string',
        required: true,
        description: 'Absolute working directory for the chat session (the agent works here).',
      },
      label: {
        type: 'string',
        description: `Optional short name for the chat (at most ${LABEL_MAX} characters), shown by ${toolPrefix}list so you can tell chats apart later.`,
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
      render: (_args, value) => [{ type: 'text', text: `chat started: ${value.chatId}; send messages with ${toolPrefix}send` }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const label = args.label?.trim() ?? ''
      if (label.length > LABEL_MAX) throw new Error(`label is ${label.length} characters; keep it at most ${LABEL_MAX}`)
      const chat = await pool.start(args.cwd, exec.signal, label === '' ? {} : { label })
      return { chatId: chat.chatId, remoteSessionId: chat.remoteSessionId }
    },
  })

  const send = defineTool({
    name: `${toolPrefix}send`,
    description: `Send one message to a persistent chat started with ${toolPrefix}start and await its final answer. `
      + 'The chat keeps full conversation context. One prompt may be in flight per chat; wait for each answer. '
      + 'Different chats may run in parallel; never send twice to the same chat in one turn. '
      + 'If the remote session was lost, the answer comes from a fresh session and its first line says so. '
      + 'If the agent did not finish its turn, the tool fails and includes any partial output.',
    parameters: {
      chatId: {
        type: 'string',
        required: true,
        description: `The chatId returned by ${toolPrefix}start.`,
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
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!pool.knows(args.chatId)) throw unknownChat(args.chatId)
      const result = await pool.send(args.chatId, args.message, exec.signal)
      if (result.stopReason !== 'completed') throw failedTurnError(result)
      const body = result.output.trim() === '' ? EMPTY_OUTPUT : result.output
      return { text: result.freshSession ? `${FRESH_NOTE}\n${body}` : body }
    },
  })

  const list = defineTool({
    name: `${toolPrefix}list`,
    description: 'List the persistent ACP chats known to this harness: chatId, label (if any), remote session id, liveness, '
      + `idle time, and working directory. Released chats reconnect on their next ${toolPrefix}send.`,
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
      const now = Date.now()
      const text = chats.length === 0
        ? 'no persistent chats'
        : chats.map(chat => describeChat(chat, now)).join('\n')
      return { text }
    },
  })

  const close = defineTool({
    name: `${toolPrefix}close`,
    description: 'Release a persistent chat\'s agent process. Not needed between messages; idle chats are released automatically. '
      + 'If the chat has a turn in flight, it is cancelled first and allowed to settle before the process is released. '
      + `By default the chat record is KEPT: a later ${toolPrefix}send reconnects it with context restored. `
      + 'Set purge to also delete the local record when the conversation is over '
      + '(the remote session record, if any, lives in the external agent\'s own store — e.g. kiro-cli chat --list-sessions / --delete-session).',
    parameters: {
      chatId: {
        type: 'string',
        required: true,
        description: 'The chatId to release.',
      },
      purge: {
        type: 'boolean',
        description: 'Also delete the local chat record (default false: keep it for reconnect).',
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
      exec.signal.throwIfAborted()
      if (!pool.knows(args.chatId)) throw unknownChat(args.chatId)
      if (args.purge === true) {
        await pool.remove(args.chatId)
        return { text: `chat ${args.chatId} released and its record deleted` }
      }
      await pool.close(args.chatId)
      return { text: `chat ${args.chatId} released; its record is kept and a later ${toolPrefix}send reconnects it` }
    },
  })

  for (const definition of [start, send, list, close]) {
    ctx.effect(() => tools.register(definition))
  }
}
