/**
 * Model-facing persistent-chat tools over the {@link AcpSessionPool}: start a
 * durable conversation, send follow-up messages (reconnecting or degrading to
 * a fresh session when the remote one is gone), list durable chats, and
 * release a chat's process while keeping its record, and steer a running
 * turn with a queued extra instruction (`steer`, over the private
 * `_session/steer` request; an agent without it yields a clear tool error). Tool copy speaks to the
 * model, not to the UI. The send tool comes in two variants (D17): with a job
 * registry (`ctx.jobs`) it registers the turn as a background job and returns
 * the job id at once, streaming the answer into the job's output and settling
 * the job `completed` / `failed` / `killed`; without one it awaits the answer
 * inline, and a turn that did not end `completed` is thrown as a tool error
 * (official convention: non-completed ⇒ isError). Either way a degraded fresh
 * session is a success flagged by a leading note line.
 *
 * @module dsh-acp-resume/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JobHandle, JobOutcome, JobRegistry } from '@deepseek-ai/dsh-jobs'
import { AcpSteerUnsupportedError } from './connection.js'
import type { AcpSessionPool, PoolSendResult } from './pool.js'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'acp-chat': 'acp-chat'
  }
}

/** The registry face the job-backed send needs: `ctx.jobs` in a host. */
export type ChatJobsFace = Pick<JobRegistry, 'start'>

type ToolDefinitionOf = ReturnType<typeof defineTool>

/** Leading line on a degraded send; embeds the fixed D6 phrase. */
const FRESH_NOTE = '[remote session lost, started fresh — prior context is gone; restate what matters and re-ask]'

const EMPTY_OUTPUT = '(agent returned no text)'

/** Longest diagnostic excerpt carried into a thrown send error. */
const DIAGNOSTIC_EXCERPT_MAX = 300

/** Minimal registry face the tools need; the host provides the real service. */
export interface ToolsRegistryFace {
  register(definition: ToolDefinitionOf): () => void
}

/** Longest message excerpt carried in a job label. */
const LABEL_EXCERPT_MAX = 60

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

/** One-line account of a non-completed turn: the tool error's headline and the job's terminal detail. */
function turnFailureHeadline(result: PoolSendResult): string {
  switch (result.stopReason) {
    case 'aborted':
      return 'the agent stopped before finishing; the chat may hold a partial turn — check its state before resending'
    case 'error':
      return `the agent failed before it finished${diagnosticExcerpt(result.diagnostic)}`
    case 'max-tokens':
      return 'the agent ran out of room before it finished its answer'
    case 'refusal':
      return 'the agent declined to answer'
    default:
      return `the agent ended its turn without finishing (stop reason: ${result.stopReason})${diagnosticExcerpt(result.diagnostic)}`
  }
}

/** Error for a non-completed send: headline, then any partial output the agent produced. */
function failedTurnError(result: PoolSendResult): Error {
  const fresh = result.freshSession ? `\n${FRESH_NOTE}` : ''
  const partial = result.output.trim() === '' ? '' : `\npartial output received:\n${result.output}`
  return new Error(`${turnFailureHeadline(result)}${fresh}${partial}`)
}

/** `<label or chatId>: <first message line, capped>`: the job's one-line label. */
function jobLabel(pool: AcpSessionPool, chatId: string, message: string): string {
  const chat = pool.listChats().find(c => c.chatId === chatId)
  const name = chat?.label ?? chatId
  const firstLine = message.trim().split('\n', 1)[0]?.trim() ?? ''
  const chars = Array.from(firstLine)
  const excerpt = chars.length > LABEL_EXCERPT_MAX ? `${chars.slice(0, LABEL_EXCERPT_MAX).join('')}…` : firstLine
  return excerpt === '' ? name : `${name}: ${excerpt}`
}

/**
 * Run one pooled turn as a job's work. The answer streams into the job's
 * output (the fresh-session note first, when the remote session was lost);
 * the outcome maps the stop reason: `completed` → completed, `aborted` →
 * killed, anything else → failed, with the failure headline as detail. A
 * send that rejects (reconnect failure, single-flight race) fails the job, or
 * ends it killed when the job's own cancellation caused it. Never rejects.
 */
async function runTurnAsJob(pool: AcpSessionPool, chatId: string, message: string, signal: AbortSignal, job: JobHandle): Promise<JobOutcome> {
  try {
    const result = await pool.send(chatId, message, signal, {
      onFreshSession: () => { job.append(`${FRESH_NOTE}\n`) },
      onText: (text) => { job.append(text) },
    })
    if (result.stopReason === 'completed') {
      if (result.output.trim() === '') job.append(EMPTY_OUTPUT)
      return { status: 'completed' }
    }
    return { status: result.stopReason === 'aborted' ? 'killed' : 'failed', detail: turnFailureHeadline(result) }
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return { status: signal.aborted ? 'killed' : 'failed', detail }
  }
}

function unknownChatError(toolPrefix: string, chatId: string): Error {
  return new Error(`unknown chat ${chatId}; call ${toolPrefix}list to see known chats`)
}

const SEND_PARAMETERS = (toolPrefix: string) => ({
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
}) as const

const SEND_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', required: true },
      jobId: { type: 'string' },
    },
  },
  render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: value.text }],
} as const

/**
 * The send tool. With `jobs` it is job-backed: preflight (unknown chat,
 * in-flight turn, foreign agent record) throws as a tool error, otherwise the
 * turn is registered as an `acp-chat` job owned by the calling agent's
 * session and the call returns its id at once; a registry refusal (owner job
 * limit, no job controller) is thrown as the tool error. `job_kill` (or owner
 * teardown) aborts the turn: local `aborted` settlement, best-effort
 * `session/cancel`, connection released (D6). Without `jobs` it awaits the
 * answer inline.
 * @param pool - the pool the tool drives.
 * @param toolPrefix - name prefix shared by the five tools.
 * @param jobs - the job registry, when the host composes one.
 */
export function chatSendTool(pool: AcpSessionPool, toolPrefix: string, jobs?: ChatJobsFace): ToolDefinitionOf {
  const name = `${toolPrefix}send`
  if (jobs === undefined) {
    return defineTool({
      name,
      description: `Send one message to a persistent chat started with ${toolPrefix}start and await its final answer. `
        + 'The chat keeps full conversation context. One prompt may be in flight per chat; wait for each answer. '
        + 'Different chats may run in parallel; never send twice to the same chat in one turn. '
        + 'If the remote session was lost, the answer comes from a fresh session and its first line says so. '
        + 'If the agent did not finish its turn, the tool fails and includes any partial output.',
      parameters: SEND_PARAMETERS(toolPrefix),
      output: SEND_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        if (!pool.knows(args.chatId)) throw unknownChatError(toolPrefix, args.chatId)
        const result = await pool.send(args.chatId, args.message, exec.signal)
        if (result.stopReason !== 'completed') throw failedTurnError(result)
        const body = result.output.trim() === '' ? EMPTY_OUTPUT : result.output
        return { text: result.freshSession ? `${FRESH_NOTE}\n${body}` : body }
      },
    })
  }
  return defineTool({
    name,
    description: `Send one message to a persistent chat started with ${toolPrefix}start. Returns at once with a background job id; `
      + 'the agent\'s answer streams into that job while you keep working. You are notified in-session when the job finishes: '
      + 'do not wait on it (job_output with wait is refused while the turn runs): when it finishes you are woken, then read the answer with job_output without wait. Stop it with job_kill. '
      + 'The chat keeps full conversation context. One prompt may be in flight per chat: a send to a chat whose previous job '
      + 'is still running is rejected; send again after that job\'s completion notice. Different chats may run in parallel. '
      + 'If the remote session was lost, the answer comes from a fresh session and its first line says so. '
      + 'If the agent did not finish its turn, the job ends failed (or killed, when cancelled) with the reason in its status, '
      + 'and any partial answer stays readable with job_output.',
    parameters: SEND_PARAMETERS(toolPrefix),
    output: SEND_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const { chatId, message } = args
      if (!pool.knows(chatId)) throw unknownChatError(toolPrefix, chatId)
      pool.assertSendable(chatId)
      // The job owns the turn's cancellation from here on: the tool call ends
      // when the id is returned, so its own signal must not reach the turn.
      const controller = new AbortController()
      const jobId = jobs.start({
        kind: 'acp-chat',
        label: jobLabel(pool, chatId, message),
        toolCall: { callId: exec.callId, rootCallId: exec.rootCallId },
        ...(exec.agent === undefined ? {} : { owner: exec.agent.id }),
        // The starter runs synchronously inside start(), and pool.send claims
        // the chat before its first await, so the preflight above and the
        // claim leave no gap for a parallel send on the same chat.
        run: job => ({
          done: runTurnAsJob(pool, chatId, message, controller.signal, job),
          cancel: (reason) => { controller.abort(new Error(reason ?? 'acp-resume: chat job killed')) },
        }),
      })
      return {
        text: `message sent to chat ${chatId}; the answer runs as background job ${jobId}. `
          + `Do not wait on it: you are woken when it finishes; then read the answer with job_output without wait. Stop it with job_kill. `
          + `Do not send to this chat again until the job finishes.`,
        jobId,
      }
    },
  })
}

/**
 * The start, list, close, and steer tools (send is built by {@link chatSendTool}).
 * @param pool - the pool the tools drive.
 * @param toolPrefix - name prefix shared by the five tools.
 */
export function chatStaticTools(pool: AcpSessionPool, toolPrefix: string): ToolDefinitionOf[] {
  const unknownChat = (chatId: string): Error => unknownChatError(toolPrefix, chatId)

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
      // Attribution only (D20): the calling DSH session, so the panel can filter
      // "this session" vs "other sessions". Agent.id IS the session id (same
      // source as the D17 job owner). It gates nothing — tools stay global.
      const ownerSessionId = exec.agent?.id
      const chat = await pool.start(args.cwd, exec.signal, {
        ...(label === '' ? {} : { label }),
        ...(ownerSessionId === undefined ? {} : { ownerSessionId }),
      })
      return { chatId: chat.chatId, remoteSessionId: chat.remoteSessionId }
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

  const steer = defineTool({
    name: `${toolPrefix}steer`,
    description: 'Queue an extra instruction into a chat\'s RUNNING turn without waiting for it. '
      + 'The agent takes the queued message in at its next tool or message boundary; it does not interrupt the current step. '
      + `To stop the turn immediately use job_kill (when the send ran as a job) or ${toolPrefix}close instead. `
      + `Only works while a turn is in flight (after ${toolPrefix}send, before it finishes); otherwise use ${toolPrefix}send. `
      + 'Needs an agent that supports the private _session/steer extension (kiro-cli does on engines v2/v3); '
      + 'if the agent lacks it, the tool fails and says so.',
    parameters: {
      chatId: {
        type: 'string',
        required: true,
        description: `The chatId of a chat with a turn in flight (from ${toolPrefix}start).`,
      },
      message: {
        type: 'string',
        required: true,
        description: 'The instruction to add to the running turn.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          queued: { type: 'boolean', required: true },
          messageId: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    // Steering claims no turn and only appends to the agent's queue, so it may run beside other calls.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!pool.knows(args.chatId)) throw unknownChat(args.chatId)
      let result
      try {
        result = await pool.steer(args.chatId, args.message)
      } catch (error: unknown) {
        if (error instanceof AcpSteerUnsupportedError) {
          throw new Error(
            'the current agent does not support steering (it rejected _session/steer as an unknown method); '
            + `let the turn finish (you will be notified), or stop it with job_kill / ${toolPrefix}close and send again`,
            { cause: error },
          )
        }
        throw error
      }
      const id = result.messageId === undefined ? '' : ` (messageId ${result.messageId})`
      const text = result.queued
        ? `steering message queued for chat ${args.chatId}${id}; it takes effect at the next tool or message boundary of the running turn`
        : `the agent did not queue the steering message for chat ${args.chatId}${id}`
      return { text, queued: result.queued, ...(result.messageId === undefined ? {} : { messageId: result.messageId }) }
    },
  })

  return [start, list, close, steer]
}

/**
 * Register the five chat tools under `toolPrefix` (`acp_chat_` by default:
 * acp_chat_start / acp_chat_send / acp_chat_list / acp_chat_close / acp_chat_steer).
 * @param ctx - host context; owns the registrations' lifetime via `ctx.effect`.
 * @param tools - the tools registry the five definitions are registered into.
 * @param pool - the pool the tools drive.
 * @param toolPrefix - name prefix for all five tools.
 * @param jobs - the job registry; when given, send is the job-backed variant.
 */
export function registerChatTools(ctx: Context, tools: ToolsRegistryFace, pool: AcpSessionPool, toolPrefix: string, jobs?: ChatJobsFace): void {
  const [start, list, close, steer] = chatStaticTools(pool, toolPrefix)
  for (const definition of [start, chatSendTool(pool, toolPrefix, jobs), list, close, steer]) {
    ctx.effect(() => tools.register(definition))
  }
}
