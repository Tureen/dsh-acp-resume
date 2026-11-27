/**
 * Model-facing persistent-chat tools over the {@link AcpSessionPool}: start a
 * durable conversation, send follow-up messages (reconnecting or degrading to
 * a fresh session when the remote one is gone), list durable chats, and
 * release a chat's process while keeping its record, and steer a running
 * turn with a queued extra instruction (`steer`, over the private
 * `_session/steer` request; an agent without it yields a clear tool error, and
 * the model-facing copy names no protocol method or engine). Tool copy speaks to the
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
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AcpSteerUnsupportedError } from './connection.js'
import { QUOTA_TOOL_GUIDANCE } from './failure-class.js'
import { freshSessionNotice, type AcpSessionPool, type PoolSendHooks, type PoolSendResult, type PooledChatInfo, type RoleCallContext } from './pool.js'
import type { PermissionRequestResolver } from './permission-request.js'
import { bindParams, runWorkflow, type WorkflowObserver, type WorkflowResult } from './workflow-engine.js'
import { WorkflowRecorder, type RunStopReason } from './workflow-record.js'
import { describeTeamConfig, readTeamConfig } from './team-config.js'
import type { UsageService } from './usage.js'
import { describeBackendSnapshot, type BackendStatusService } from './backend-readiness.js'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'acp-chat': 'acp-chat'
  }
}

/** Read-only status for the model: never probes or creates a session. */
export function backendStatusTool(service: BackendStatusService, toolPrefix = 'acp_chat_') {
  return defineTool({
    name: `${toolPrefix.replace(/chat_$/, '')}backend_status`,
    description: 'Read the automatic ACP backend check: supported versions, ready backends, the new-chat default, and any needed action. This read does not launch a CLI. If detection is running, say so. For changes or recovery, direct the user to Right sidebar → ACP chats → Recheck backends next to Backend status (右侧栏 → ACP 会话 → 后端状态旁的「重新检测后端」). This does not delete chats, log users out, or change settings.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute() { return { text: describeBackendSnapshot(service.snapshot()) } },
  })
}

/** The registry face the job-backed send needs: `ctx.jobs` in a host. */
export type ChatJobsFace = Pick<JobRegistry, 'start'>

type ToolDefinitionOf = ReturnType<typeof defineTool>

/** Leading line on a degraded send; maps the D6 recovery reason to its fixed notice. */
function resultFreshSessionNotice(result: PoolSendResult): string {
  return freshSessionNotice(result.freshSessionReason ?? 'load-rejected')
}

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
function formatElapsed(then: number, now: number): string {
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

type ListedChat = Pick<PooledChatInfo, 'chatId' | 'remoteSessionId' | 'cwd' | 'label' | 'backend' | 'active' | 'lastActive' | 'inFlight'>

/** `running (<since prompt start>)` while a turn is in flight, `idle (<since last turn>)` with a live process, else `released`. */
function chatState(chat: ListedChat, now: number): string {
  if (chat.inFlight !== undefined) return `running (${formatElapsed(chat.inFlight.startedAt, now)})`
  if (chat.active) return `idle (${formatElapsed(chat.lastActive, now)})`
  return `released (last active ${formatElapsed(chat.lastActive, now)} ago; reconnects on next send)`
}

/** One list row, led by `role <name> | ` for a chat in the session's roster (D27). The owner is omitted: the list is already filtered to the calling session (D20). */
function describeChat(chat: ListedChat, now: number, role?: string): string {
  const label = chat.label === undefined ? '' : ` | label ${JSON.stringify(chat.label)}`
  return `${role === undefined ? '' : `role ${role} | `}${chat.chatId}${label} | backend ${chat.backend} | ${chatState(chat, now)} | remote ${chat.remoteSessionId} | last active ${new Date(chat.lastActive).toISOString()} | cwd ${chat.cwd}`
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
    case 'error': {
      const base = `the agent failed before it finished${diagnosticExcerpt(result.diagnostic)}`
      return result.failureKind === 'quota' ? `${QUOTA_TOOL_GUIDANCE}; ${base}` : base
    }
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
  const fresh = result.freshSession ? `\n${resultFreshSessionNotice(result)}` : ''
  const partial = result.output.trim() === '' ? '' : `\npartial output received:\n${result.output}`
  return new Error(`${turnFailureHeadline(result)}${fresh}${partial}`)
}

/** `<name>: <first message line, capped>`: the job's one-line label. */
function jobLabel(name: string, message: string): string {
  const firstLine = message.trim().split('\n', 1)[0]?.trim() ?? ''
  const chars = Array.from(firstLine)
  const excerpt = chars.length > LABEL_EXCERPT_MAX ? `${chars.slice(0, LABEL_EXCERPT_MAX).join('')}…` : firstLine
  return excerpt === '' ? name : `${name}: ${excerpt}`
}

/** A chat's label, else its id: the job label's name for a chatId send. */
function chatName(pool: AcpSessionPool, chatId: string): string {
  return pool.chatInfo(chatId)?.label ?? chatId
}

/**
 * Run one pooled turn as a job's work. The answer streams into the job's
 * output (the matching fresh-session note first, when the saved session was replaced);
 * the outcome maps the stop reason: `completed` → completed, `aborted` →
 * killed, anything else → failed, with the failure headline as detail. A
 * send that rejects (reconnect failure, single-flight race, failed role
 * provisioning) fails the job, or ends it killed when the job's own
 * cancellation caused it. Never rejects.
 */
async function runTurnAsJob(
  send: (hooks: PoolSendHooks) => Promise<PoolSendResult>,
  signal: AbortSignal,
  job: JobHandle,
  permissionResolver: PermissionRequestResolver | undefined,
): Promise<JobOutcome> {
  try {
    const result = await send({
      onBackendFallback: (notice) => { job.append(`[${notice}]\n`) },
      onFreshSession: (reason) => { job.append(`${freshSessionNotice(reason)}\n`) },
      onText: (text) => { job.append(text) },
      ...(permissionResolver === undefined ? {} : { permissionResolver }),
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

/**
 * How the tools reach D27 workspace roles. Present only when Config
 * `workflow` is on; absent, the tool definitions are exactly the pre-D27 ones.
 */
export interface RoleSupport {
  /** The calling session's working directory, where the `.agents/acp-team.yml` search starts. */
  readonly workspaceDirFor: (agent: Agent) => string
  /** Non-fatal conditions, e.g. a workflow progress record that could not be written. */
  readonly onWarn?: (message: string) => void
  /**
   * Workflow templates are on (D33 `workflow`): `acp_workflow` exists and
   * `<prefix>list` names the templates. The plugin always sets it; absent
   * (direct callers such as tests) means on.
   */
  readonly templates?: boolean
}

/** A tool call's target: a chat by id, or a role in the calling session's roster. */
type Target = { readonly kind: 'chat'; readonly chatId: string } | { readonly kind: 'role'; readonly role: string; readonly context: RoleCallContext }

/** Resolve `chatId` / `role` (exactly one) into a target; role needs a calling session. */
function targetOf(args: { readonly chatId?: string | undefined; readonly role?: string | undefined }, agent: Agent | undefined, roles: RoleSupport | undefined): Target {
  const chatId = args.chatId === undefined || args.chatId === '' ? undefined : args.chatId
  const role = args.role === undefined || args.role === '' ? undefined : args.role
  if (chatId !== undefined && role !== undefined) throw new Error('pass either chatId or role, not both')
  if (role !== undefined) {
    if (roles === undefined) throw new Error('role is not available: the roles feature is off (Config roles: false); pass chatId instead')
    if (agent === undefined) throw new Error('role needs a calling DSH session (rosters are per session); pass chatId instead')
    return { kind: 'role', role, context: { ownerSessionId: agent.id, workspaceDir: roles.workspaceDirFor(agent) } }
  }
  if (chatId === undefined) throw new Error(roles === undefined ? 'chatId is required' : 'pass chatId or role')
  return { kind: 'chat', chatId }
}

/** The team list tool's name for a chat tool prefix (`acp_team_list` by default). */
export function teamListName(toolPrefix: string): string {
  return `${toolPrefix.replace(/chat_$/, '')}team_list`
}

/** Appended to every `role` parameter description: roles exist only with a workspace team file (D33). */
function roleScope(toolPrefix: string): string {
  return ` Only when the workspace defines roles (see ${teamListName(toolPrefix)}).`
}

function roleParameter(toolPrefix: string) {
  return {
    type: 'string',
    description: 'A role defined in the workspace .agents/acp-team.yml, instead of chatId. The first reference in this session '
      + 'creates the role\'s chat from its blueprint (and sends its seeding message); later references reuse that chat.' + roleScope(toolPrefix),
  } as const
}

/** Send parameters; with roles, `chatId` becomes optional and `role` is added (exactly one of them per call). */
function sendParameters(toolPrefix: string, roles: RoleSupport | undefined) {
  const message = {
    type: 'string',
    required: true,
    description: 'The message to send. Include any context the chat needs; it remembers its own prior turns.',
  } as const
  if (roles === undefined) {
    return { chatId: { type: 'string', required: true, description: `The chatId returned by ${toolPrefix}start.` }, message } as const
  }
  return {
    chatId: { type: 'string', description: `The chatId returned by ${toolPrefix}start; omit when passing role.` },
    role: roleParameter(toolPrefix),
    message,
  } as const
}

/**
 * The parameter shape the send body is typed against. The role-less schema is
 * narrower at runtime (no `role`, `chatId` required), which the body handles.
 */
type SendParameters = {
  readonly chatId: { readonly type: 'string'; readonly description: string }
  readonly role: { readonly type: 'string'; readonly description: string }
  readonly message: { readonly type: 'string'; readonly required: true; readonly description: string }
}

/** Steer parameters; with roles, `chatId` becomes optional and `role` is added (exactly one of them per call). */
function steerParameters(toolPrefix: string, roles: RoleSupport | undefined): SteerParameters {
  const message = { type: 'string', required: true, description: 'The instruction to add to the running turn.' } as const
  if (roles === undefined) {
    return { chatId: { type: 'string', required: true, description: `The chatId of a chat with a turn in flight (from ${toolPrefix}start).` }, message } as unknown as SteerParameters
  }
  return {
    chatId: { type: 'string', description: `The chatId of a chat with a turn in flight (from ${toolPrefix}start); omit when passing role.` },
    role: { type: 'string', description: 'A workspace role of this session whose turn is in flight, instead of chatId.' + roleScope(toolPrefix) },
    message,
  }
}

/** The steer body's parameter shape; the role-less schema is narrower at runtime. */
type SteerParameters = {
  readonly chatId: { readonly type: 'string'; readonly description: string }
  readonly role: { readonly type: 'string'; readonly description: string }
  readonly message: { readonly type: 'string'; readonly required: true; readonly description: string }
}

/** Close parameters; with roles, `chatId` becomes optional and `role` is added (exactly one of them per call). */
function closeParameters(toolPrefix: string, roles: RoleSupport | undefined): CloseParameters {
  const purge = { type: 'boolean', description: 'Also delete the local chat record (default false: keep it for reconnect).' } as const
  if (roles === undefined) return { chatId: { type: 'string', required: true, description: 'The chatId to release.' }, purge } as unknown as CloseParameters
  return {
    chatId: { type: 'string', description: 'The chatId to release; omit when passing role.' },
    role: { type: 'string', description: 'A workspace role of this session to release and unbind, instead of chatId.' + roleScope(toolPrefix) },
    purge,
  }
}

/** The close body's parameter shape; the role-less schema is narrower at runtime. */
type CloseParameters = {
  readonly chatId: { readonly type: 'string'; readonly description: string }
  readonly role: { readonly type: 'string'; readonly description: string }
  readonly purge: { readonly type: 'boolean'; readonly description: string }
}

const ROLE_SEND_NOTE = ' Address a workspace role with role instead of chatId: the first reference sets up its chat, later ones reuse it.'

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
 * in-flight turn, foreign agent record; for a role, an undefined role or one
 * being set up) throws as a tool error, otherwise the turn is registered as an
 * `acp-chat` job owned by the calling agent's session and the call returns its
 * id at once; a registry refusal (owner job limit, no job controller) is thrown
 * as the tool error. `job_kill` (or owner teardown) aborts the turn: local
 * `aborted` settlement, best-effort `session/cancel`, connection released (D6).
 * Without `jobs` it awaits the answer inline. With `roles` (D27) the call may
 * name a role instead of a chatId; an uninstantiated role is provisioned first.
 * @param pool - the pool the tool drives.
 * @param toolPrefix - name prefix shared by the five tools.
 * @param jobs - the job registry, when the host composes one.
 * @param permissionResolverFor - binds one model call's user-confirmation bridge when `permission: ask` is configured.
 * @param roles - workspace role access; absent keeps the pre-D27 definition.
 */
export function chatSendTool(
  pool: AcpSessionPool,
  toolPrefix: string,
  jobs?: ChatJobsFace,
  permissionResolverFor?: (agent: Agent | undefined) => PermissionRequestResolver | undefined,
  roles?: RoleSupport,
  allowChatJobWait = false,
): ToolDefinitionOf {
  const name = `${toolPrefix}send`
  const parameters = sendParameters(toolPrefix, roles) as unknown as SendParameters
  const roleNote = roles === undefined ? '' : ROLE_SEND_NOTE
  const preflight = (target: Target): void => {
    if (target.kind === 'role') pool.assertRoleSendable(target.role, target.context)
    else if (!pool.knows(target.chatId)) throw unknownChatError(toolPrefix, target.chatId)
  }
  const sendTo = (target: Target, message: string, signal: AbortSignal, hooks: PoolSendHooks): Promise<PoolSendResult> =>
    target.kind === 'role' ? pool.sendByRole(target.role, message, target.context, signal, hooks) : pool.send(target.chatId, message, signal, hooks)
  if (jobs === undefined) {
    return defineTool({
      name,
      description: `Send one message to a persistent chat started with ${toolPrefix}start and await its final answer. `
        + 'The chat keeps full conversation context. One prompt may be in flight per chat; wait for each answer. '
        + 'Different chats may run in parallel; never send twice to the same chat in one turn. '
        + 'If the saved remote session had to be replaced, the answer comes from a fresh session and its first line says so. '
        + `If the agent did not finish its turn, the tool fails and includes any partial output.${roleNote}`,
      parameters,
      output: SEND_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const target = targetOf(args, exec.agent, roles)
        preflight(target)
        const permissionResolver = permissionResolverFor?.(exec.agent)
        const result = await sendTo(target, args.message, exec.signal, {
          ...(permissionResolver === undefined ? {} : { permissionResolver }),
        })
        if (result.stopReason !== 'completed') throw failedTurnError(result)
        const body = result.output.trim() === '' ? EMPTY_OUTPUT : result.output
        const fallback = 'fallbackNotice' in result && typeof result.fallbackNotice === 'string' ? `[${result.fallbackNotice}]\n` : ''
        return { text: `${fallback}${result.freshSession ? `${resultFreshSessionNotice(result)}\n${body}` : body}` }
      },
    })
  }
  return defineTool({
    name,
    description: `Send one message to a persistent chat started with ${toolPrefix}start. Returns at once with a background job id; `
      + 'the agent\'s answer streams into that job. When the turn finishes you are woken in-session; then read the answer with job_output without wait. '
      + `${INBOX_WAIT_GUIDANCE} Ending your turn while the job runs is correct and counts as collecting it. `
      + (allowChatJobWait ? '' : 'job_output with wait on a running turn is refused, and reading again before the notification only returns no new output. ')
      + 'A send to a chat whose previous job is still running is rejected; send again after that job\'s completion notice. '
      + 'Stop it with job_kill. The chat keeps full conversation context; different chats may run in parallel. '
      + 'If the remote session was lost, the answer comes from a fresh session and its first line says so. '
      + 'If the agent did not finish its turn, the job ends failed (or killed, when cancelled) with the reason in its status, '
      + `and any partial answer stays readable with job_output.${roleNote}`,
    parameters,
    output: SEND_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const { message } = args
      const target = targetOf(args, exec.agent, roles)
      const permissionResolver = permissionResolverFor?.(exec.agent)
      preflight(target)
      if (target.kind === 'chat') pool.assertSendable(target.chatId)
      // The job owns the turn's cancellation from here on: the tool call ends
      // when the id is returned, so its own signal must not reach the turn.
      const controller = new AbortController()
      const jobId = jobs.start({
        kind: 'acp-chat',
        label: jobLabel(target.kind === 'role' ? target.role : chatName(pool, target.chatId), message),
        toolCall: { callId: exec.callId, rootCallId: exec.rootCallId },
        ...(exec.agent === undefined ? {} : { owner: exec.agent.id }),
        // The starter runs synchronously inside start(), and pool.send (or
        // sendByRole: its routing or provisioning claim) takes the chat before
        // its first await, so the preflight above and the claim leave no gap
        // for a parallel send on the same chat or role.
        run: job => ({
          done: runTurnAsJob(hooks => sendTo(target, message, controller.signal, hooks), controller.signal, job, permissionResolver),
          cancel: (reason) => { controller.abort(new Error(reason ?? 'acp-resume: chat job killed')) },
        }),
      })
      const what = target.kind === 'role' ? `role ${target.role}` : `chat ${target.chatId}`
      // The tool description carries the rest (ending the turn collects it, job_kill stops it); repeat only what this call decides.
      return {
        text: `message sent to ${what}; the answer runs as background job ${jobId}. `
          + `You are woken in-session when it finishes. Do not send to this ${target.kind} again until then. ${BACKGROUND_RECEIPT_GUIDANCE}`,
        jobId,
      }
    },
  })
}

/**
 * The start, list, close, and steer tools (send is built by {@link chatSendTool}).
 * @param pool - the pool the tools drive.
 * @param toolPrefix - name prefix shared by the five tools.
 * @param backends - configured backends; more than one adds start's `backend` parameter (D24).
 * @param roles - workspace role access (D27): close takes `role`, list shows role columns; absent keeps the pre-D27 definitions.
 */
export interface BackendChoice { readonly name: string; readonly description: string }

export function chatStaticTools(pool: AcpSessionPool, toolPrefix: string, backends: readonly BackendChoice[] = [], roles?: RoleSupport, exposeBackend = false, defaultBackend?: string, automaticPriority = false): ToolDefinitionOf[] {
  const unknownChat = (chatId: string): Error => unknownChatError(toolPrefix, chatId)

  const backendDescription = ` Candidate backends; check the backend status tool for which are ready:\n${backends.map(backend => `${backend.name}: ${backend.description}`).join('\n')}`
  // Keep the legacy single-backend definition literal: D24 promises byte-for-byte
  // compatibility for models that cached the 0.1.20 tool schema.
  const start = backends.length <= 1 && !exposeBackend
    ? defineTool({
      name: `${toolPrefix}start`,
      description: 'Start a persistent chat session with the external ACP agent (for example kiro-cli). '
        + `Returns a chatId you pass to ${toolPrefix}send. The conversation context usually survives between messages, `
        + `process release, and host restarts; if the agent lost the session, the next ${toolPrefix}send says so.`,
      parameters: {
        cwd: { type: 'string', required: true, description: 'Absolute working directory for the chat session (the agent works here).' },
        label: { type: 'string', description: `Optional short name for the chat (at most ${LABEL_MAX} characters), shown by ${toolPrefix}list so you can tell chats apart later.` },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { chatId: { type: 'string', required: true }, remoteSessionId: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: `chat started: ${value.chatId}; send messages with ${toolPrefix}send` }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const label = args.label?.trim() ?? ''
        if (label.length > LABEL_MAX) throw new Error(`label is ${label.length} characters; keep it at most ${LABEL_MAX}`)
        const ownerSessionId = exec.agent?.id
        const chat = await pool.start(args.cwd, exec.signal, {
          ...(label === '' ? {} : { label }),
          ...(ownerSessionId === undefined ? {} : { ownerSessionId }),
        })
        return { chatId: chat.chatId, remoteSessionId: chat.remoteSessionId }
      },
    })
    : defineTool({
      name: `${toolPrefix}start`,
      description: 'Start a persistent chat session with the configured external ACP agent. '
        + `Returns a chatId you pass to ${toolPrefix}send. The conversation context usually survives between messages, `
        + `process release, and host restarts; if the agent lost the session, the next ${toolPrefix}send says so.${backendDescription}`,
      parameters: {
        cwd: { type: 'string', required: true, description: 'Absolute working directory for the chat session (the agent works here).' },
        label: { type: 'string', description: `Optional short name for the chat (at most ${LABEL_MAX} characters), shown by ${toolPrefix}list so you can tell chats apart later.` },
        backend: { type: 'string', ...(exposeBackend && defaultBackend === undefined ? { required: true as const } : {}), description: exposeBackend && defaultBackend === undefined
          ? `Select a ready backend explicitly: ${backends.map(backend => backend.name).join(', ')}`
          : automaticPriority
            ? `Optional backend name. Omit to use configured Kiro; only if its executable is missing does the plugin try ready Codex, then Antigravity. Candidate names: ${backends.map(backend => backend.name).join(', ')}`
            : `Optional backend name; omit for ${defaultBackend ?? 'default'}. Candidate names: ${backends.map(backend => backend.name).join(', ')}` },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { chatId: { type: 'string', required: true }, remoteSessionId: { type: 'string', required: true }, backend: { type: 'string', required: true }, cwd: { type: 'string', required: true }, fallbackNotice: { type: 'string' } } },
        // A fallback (D31: the default's executable was not found) is named at the end, so neither the model nor the user mistakes it for kiro.
        render: (_args, value) => [{ type: 'text', text: `chat started: ${value.chatId} (backend: ${value.backend}, cwd: ${value.cwd}); send messages with ${toolPrefix}send${value.fallbackNotice === undefined ? '' : `. ${value.fallbackNotice}`}` }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const label = args.label?.trim() ?? ''
        if (label.length > LABEL_MAX) throw new Error(`label is ${label.length} characters; keep it at most ${LABEL_MAX}`)
        const ownerSessionId = exec.agent?.id
        if (args.backend !== undefined && !backends.some(backend => backend.name === args.backend)) {
          throw new Error(`unknown backend ${args.backend}; available backends: ${backends.map(backend => backend.name).join(', ')}`)
        }
        const chat = await pool.start(args.cwd, exec.signal, {
          ...(label === '' ? {} : { label }),
          ...(args.backend === undefined ? {} : { backend: args.backend }),
          ...(ownerSessionId === undefined ? {} : { ownerSessionId }),
        })
        return { chatId: chat.chatId, remoteSessionId: chat.remoteSessionId, backend: chat.backend, cwd: chat.cwd, ...(chat.fallbackNotice === undefined ? {} : { fallbackNotice: chat.fallbackNotice }) }
      },
    })

  const list = defineTool({
    name: `${toolPrefix}list`,
    description: `List persistent ACP chats created by the current DSH session: ${roles === undefined ? '' : 'role (for chats set up for a workspace role), '}chatId, label (if any), backend, state `
      + '(running with elapsed time, idle with a live process, or released), remote session id, last activity, '
      + `and working directory. Released chats reconnect on their next ${toolPrefix}send.`
      + (roles === undefined ? '' : ` A last line names the workspace roles${roles.templates === false ? '' : ' and templates (with their params)'} defined in .agents/acp-team.yml, or the reason that file is invalid.`),
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
      const ownerSessionId = exec.agent?.id
      // Headless calls have no DSH session identity, so filtering would make a
      // misleading empty list. Normal model calls always use strict ownership.
      const chats = ownerSessionId === undefined
        ? pool.listChats()
        : pool.listChats().filter(chat => chat.ownerSessionId === ownerSessionId)
      const now = Date.now()
      const rows = chats.length === 0
        ? 'no persistent chats'
        : chats.map(chat => describeChat(chat, now, roles === undefined ? undefined : pool.roleOf(chat.chatId, ownerSessionId))).join('\n')
      // D27: name what the workspace offers, so the model need not guess role and template names.
      const workspace = roles === undefined || exec.agent === undefined ? undefined : describeTeamConfig(readTeamConfig(roles.workspaceDirFor(exec.agent)), roles.templates !== false)
      return { text: workspace === undefined ? rows : `${rows}\n${workspace}` }
    },
  })

  const close = defineTool({
    name: `${toolPrefix}close`,
    description: 'Release a persistent chat\'s agent process. Not needed between messages; idle chats are released automatically. '
      + 'If the chat has a turn in flight, it is cancelled first and allowed to settle before the process is released. '
      + `By default the chat record is KEPT: a later ${toolPrefix}send reconnects it with context restored. `
      + 'Set purge to also delete the local record when the conversation is over '
      + '(the remote session record, if any, lives in the external agent\'s own store — e.g. kiro-cli chat --list-sessions / --delete-session).'
      + (roles === undefined ? '' : ' Passing role instead of chatId also unbinds the role in this session, so its next reference sets up a new chat '
        + 'from the current workspace blueprint (use it after the blueprint changed).'),
    parameters: closeParameters(toolPrefix, roles),
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
      const target = targetOf(args, exec.agent, roles)
      if (target.kind === 'role') {
        const chatId = await pool.releaseRole(target.role, target.context.ownerSessionId, args.purge === true)
        return {
          text: `role ${target.role} released (chat ${chatId}${args.purge === true ? ', record deleted' : ''}) and unbound; `
            + `its next reference sets up a new chat from the workspace blueprint`,
        }
      }
      const chatId = target.chatId
      if (!pool.knows(chatId)) throw unknownChat(chatId)
      if (args.purge === true) {
        await pool.remove(chatId)
        return { text: `chat ${chatId} released and its record deleted` }
      }
      await pool.close(chatId)
      return { text: `chat ${chatId} released; its record is kept and a later ${toolPrefix}send reconnects it` }
    },
  })

  const steer = defineTool({
    name: `${toolPrefix}steer`,
    description: 'Queue an extra instruction into a chat\'s RUNNING turn without waiting for it. '
      + 'The agent takes the queued message in at its next tool or message boundary; it does not interrupt the current step. '
      + `To stop the turn immediately use job_kill (when the send ran as a job) or ${toolPrefix}close instead. `
      + `Only works while a turn is in flight (after ${toolPrefix}send, before it finishes); otherwise use ${toolPrefix}send. `
      + 'Requires a backend that supports mid-turn steering (only some backends do); '
      + 'if this backend does not, the tool fails with "does not support mid-turn steering" — do not probe to find out; let the turn finish (you will be notified) or stop it and send again.'
      + (roles === undefined ? '' : ' Pass role instead of chatId to steer the running turn of a workspace role in this session.'),
    parameters: steerParameters(toolPrefix, roles),
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
      const target = targetOf(args, exec.agent, roles)
      // A role steers its roster chat; a role without one has no turn to steer.
      const chatId = target.kind === 'chat' ? target.chatId : pool.resolveRole(target.role, target.context.ownerSessionId)
      if (chatId === undefined) throw new Error(`role ${target.kind === 'role' ? target.role : ''} has no chat in this session, so it has no turn to steer; use ${toolPrefix}send`)
      if (!pool.knows(chatId)) throw unknownChat(chatId)
      let result
      try {
        result = await pool.steer(chatId, args.message)
      } catch (error: unknown) {
        if (error instanceof AcpSteerUnsupportedError) {
          throw new Error(
            'this backend does not support mid-turn steering; '
            + `let the turn finish (you will be notified), or stop it with job_kill / ${toolPrefix}close and send again`,
            { cause: error },
          )
        }
        throw error
      }
      const id = result.messageId === undefined ? '' : ` (messageId ${result.messageId})`
      const text = result.queued
        ? `steering message queued for chat ${chatId}${id}; it takes effect at the next tool or message boundary of the running turn`
        : `the agent did not queue the steering message for chat ${chatId}${id}`
      return { text, queued: result.queued, ...(result.messageId === undefined ? {} : { messageId: result.messageId }) }
    },
  })

  return [start, list, close, steer]
}

/** Options after dispatching a background job (D17/D22). */
const INBOX_WAIT_GUIDANCE = 'If available, wait_agent can wait in this turn for the completion notice or new user input.'
const BACKGROUND_RECEIPT_GUIDANCE = `Send any other independent tasks. ${INBOX_WAIT_GUIDANCE} After the notice, read the result with job_output without wait.`

/** Name of the workflow tool (D27); fixed, not under the chat tools' prefix. */
export const WORKFLOW_TOOL = 'acp_workflow'

/** Workflow status → the official run stop reason. */
const RUN_STOP_REASON: Readonly<Record<WorkflowResult['status'], RunStopReason>> = { completed: 'completed', failed: 'error', aborted: 'cancelled' }

/**
 * A run's observer, combining three independent sinks: the pool's D29 tracker
 * (panel; it mints the run id), the official progress records in the calling
 * session for a model-direct call (no `parent`, as the official workflow
 * tool), and the job's progress line per step. `finish` closes the tracker and
 * the records with the run's result.
 */
function workflowObserver(
  pool: AcpSessionPool,
  name: string,
  exec: { readonly parent?: unknown; readonly agent?: Agent },
  ownerSessionId: string,
  onWarn: ((message: string) => void) | undefined,
  job?: { readonly id: string; updateProgress(line: string): void },
): { observer: WorkflowObserver; finish: (result: WorkflowResult) => void } {
  const tracker = pool.trackWorkflow(ownerSessionId, name, job?.id)
  const recorder = exec.parent === undefined && exec.agent !== undefined ? new WorkflowRecorder(exec.agent.session, onWarn, tracker.runId) : undefined
  recorder?.start(name)
  // The tracker's member seq is the engine's handle; the recorder keeps its own, mapped here.
  const recorderSeq = new Map<number, number>()
  const tracked = tracker.observer
  return {
    observer: {
      stepStart: (id) => {
        tracked.stepStart?.(id)
        job?.updateProgress(id)
      },
      memberStart: (role, stepId) => {
        const seq = tracked.memberStart?.(role, stepId) ?? 0
        if (recorder !== undefined) recorderSeq.set(seq, recorder.memberStart(role, stepId))
        return seq
      },
      memberEnd: (seq, outcome, chatId) => {
        tracked.memberEnd?.(seq, outcome, chatId)
        const mapped = recorderSeq.get(seq)
        if (mapped !== undefined) recorder?.memberEnd(mapped, outcome)
      },
    },
    finish: (result) => {
      tracker.finish(result)
      recorder?.finish(RUN_STOP_REASON[result.status])
    },
  }
}

/** The run's JSON output, followed by nothing else, so a model can parse it. */
function workflowText(result: WorkflowResult): string {
  return JSON.stringify(result, undefined, 2)
}

/**
 * The `acp_workflow` tool (D27): run a workspace template over the session's
 * roles. Preflight (calling session, template defined, params complete)
 * throws as a tool error. With `jobs` the run is an `acp-chat` job (D17: the
 * id returns at once, the completion notice wakes the model, the D22 gate
 * refuses blocking waits) whose output is the run's JSON; `job_kill` cancels
 * every in-flight role turn (D6 cancel path). Without `jobs` the call awaits
 * the run, and a run that did not complete is thrown with its JSON. A
 * model-direct call also writes the official `tool-workflow/*` progress
 * records into the calling session (D27, 2026-11-20); the job variant also
 * reports the current step as the job's progress line.
 * @param pool - the pool the roles run on.
 * @param roles - workspace role access; the tool exists only with roles.
 * @param jobs - the job registry, when the host composes one.
 * @param permissionResolverFor - binds one call's user-confirmation bridge for `permission: ask` backends.
 */
export function chatWorkflowTool(
  pool: AcpSessionPool,
  roles: RoleSupport,
  jobs?: ChatJobsFace,
  permissionResolverFor?: (agent: Agent | undefined) => PermissionRequestResolver | undefined,
): ToolDefinitionOf {
  const prepare = (args: { readonly template: string; readonly params?: unknown }, agent: Agent | undefined) => {
    if (agent === undefined) throw new Error('acp_workflow needs a calling DSH session (rosters are per session)')
    const context: RoleCallContext = { ownerSessionId: agent.id, workspaceDir: roles.workspaceDirFor(agent) }
    const template = pool.templateFor(args.template, context)
    return { context, template, params: bindParams(template, args.params) }
  }
  return defineTool({
    name: WORKFLOW_TOOL,
    description: 'Run a workflow template defined in the workspace .agents/acp-team.yml over this session\'s roles. '
      + 'Steps run in order: a parallel step sends its prompt to each listed role at once (a role\'s chat is set up on first use), '
      + 'later steps see earlier results, and a merge step either returns everything to you or has one role merge it. '
      + 'Pass the template\'s params; every declared param is required. '
      + 'A role that failed shows as {error} inside its step; the run only fails when every role in a step failed. '
      + 'Roles keep their chats (and memory) after the run; follow up with acp_chat_send role=…, or acp_chat_close role=… to reset. '
      + 'Progress is shown to the user as a workflow card when you call it directly. '
      + (jobs === undefined
        ? 'The call waits for the run and returns its JSON result; a run that did not complete fails with its partial JSON.'
        : 'Returns at once with a background job id; the result comes with job_output: you are woken in-session when it finishes, then read the JSON result with job_output without wait. '
          + `${INBOX_WAIT_GUIDANCE} Ending your turn while it runs is also correct. Stop it with job_kill.`),
    parameters: {
      template: { type: 'string', required: true, description: 'Template name from the workspace team file.' },
      params: { type: 'object', additionalProperties: true, description: 'Template params as name → value (strings, numbers, or booleans).' },
    },
    output: SEND_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const { context, template, params } = prepare(args, exec.agent)
      const permissionResolver = permissionResolverFor?.(exec.agent)
      if (jobs === undefined) {
        const { observer, finish } = workflowObserver(pool, template.name, exec, context.ownerSessionId, roles.onWarn)
        const result = await runWorkflow(pool, template, params, context, exec.signal, observer, permissionResolver)
        finish(result)
        if (result.status !== 'completed') throw new Error(`workflow ${template.name} ${result.status}: ${result.error ?? ''}\n${workflowText(result)}`)
        return { text: workflowText(result) }
      }
      const controller = new AbortController()
      const jobId = jobs.start({
        kind: 'acp-chat',
        label: jobLabel(`workflow ${template.name}`, ''),
        toolCall: { callId: exec.callId, rootCallId: exec.rootCallId },
        ...(exec.agent === undefined ? {} : { owner: exec.agent.id }),
        run: (job) => {
          const { observer, finish } = workflowObserver(pool, template.name, exec, context.ownerSessionId, roles.onWarn, job)
          return {
            done: runWorkflow(pool, template, params, context, controller.signal, observer, permissionResolver).then((result): JobOutcome => {
              finish(result)
              job.append(workflowText(result))
              if (result.status === 'completed') return { status: 'completed' }
              return { status: result.status === 'aborted' ? 'killed' : 'failed', detail: result.error ?? result.status }
            }),
            cancel: (reason) => { controller.abort(new Error(reason ?? 'acp-resume: workflow job killed')) },
          }
        },
      })
      return {
        text: `workflow ${template.name} started as background job ${jobId}. You are woken in-session when it finishes. ${BACKGROUND_RECEIPT_GUIDANCE}`,
        jobId,
      }
    },
  })
}

/**
 * The team list tool (D32): every role of the caller's workspace team file in
 * written order, with its summary and its live state in the calling session's
 * roster — `not provisioned`, `idle`, or `running (<elapsed>)`, read from the
 * pool at call time (never cached). Without a calling session the roster is
 * unknown (rosters are per session), so every state is `unknown`. The name
 * follows the tool prefix as `acp_backend_status` does (`acp_team_list` by default).
 * @param pool - roster and in-flight state.
 * @param roles - workspace access; the tool exists only with the roles feature on (Config roles, D33).
 * @param toolPrefix - the chat tools' prefix.
 */
export function teamListTool(pool: AcpSessionPool, roles: RoleSupport, toolPrefix = 'acp_chat_'): ToolDefinitionOf {
  return defineTool({
    name: teamListName(toolPrefix),
    description: 'List the workspace ACP team from .agents/acp-team.yml, read-only: one line per role with its summary and whether it can take work now '
      + '(not provisioned: its chat is set up on first use; idle: send to it; running: it has a turn in flight, so steer it or wait for its completion notice). '
      + 'Use it before choosing a role. Workers do not talk to each other directly: when one needs another\'s result, put it in your dispatch message.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      exec.signal.throwIfAborted()
      const agent = exec.agent
      const answer = (text: string) => ({ text: agent === undefined ? `${text}\nroles need a calling session` : text })
      const dir = agent === undefined ? process.cwd() : roles.workspaceDirFor(agent)
      const read = readTeamConfig(dir)
      if (read.kind === 'none') return answer(`no workspace team config (.agents/acp-team.yml) found from ${dir}; pass chatId instead; roles need an .agents/acp-team.yml in the workspace`)
      if (read.kind === 'invalid') return answer(`workspace config error: ${read.path}: ${read.error}`)
      if (read.config.roles.length === 0) return answer(`no roles defined in ${read.path}; define roles there, or pass chatId instead`)
      const roster = agent === undefined ? undefined : pool.listRoster(agent.id)
      const now = Date.now()
      const state = (role: string): string => {
        if (roster === undefined) return 'unknown'
        const entry = roster.find(e => e.role === role)
        if (entry === undefined) return 'not provisioned'
        const inFlight = pool.chatInfo(entry.chatId)?.inFlight
        return inFlight === undefined ? 'idle' : `running (${formatElapsed(inFlight.startedAt, now)})`
      }
      return answer(read.config.roles.map(r => `${r.name} · ${r.summary ?? '(no summary)'} · ${state(r.name)}`).join('\n'))
    },
  })
}

/** Name of the backend usage tool (D28); fixed, not under the chat tools' prefix. */
export const USAGE_TOOL = 'acp_backend_usage'

/**
 * The `acp_backend_usage` tool (D28): read-only quota of the configured
 * backends. Codex backends report plan and the most-used window; ACP backends
 * report `unsupported`. Results are cached (5 minutes); `refresh` forces a new read.
 * @param usage - the plugin's usage service.
 */
export function chatUsageTool(usage: UsageService): ToolDefinitionOf {
  return defineTool({
    name: USAGE_TOOL,
    description: 'Show the quota usage of the configured ACP backends, read-only and free to call. '
      + 'Codex backends report their plan and the most-used limit window: usedPercent (may exceed 100), windowMins, and resetsAt (unix seconds). '
      + 'Other backends report status unsupported. Results are cached for 5 minutes (fetchedAt says when they were read); pass refresh to read again. '
      + 'Use it before dispatching large work to a backend, or when a backend starts failing.',
    parameters: {
      backend: { type: 'string', description: 'One backend name (as acp_chat_start takes it); omit for all backends.' },
      refresh: { type: 'boolean', description: 'Skip the cache and read now (default false).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const result = await usage.read({
        ...(args.backend === undefined || args.backend === '' ? {} : { backend: args.backend }),
        ...(args.refresh === true ? { refresh: true } : {}),
      })
      return { text: JSON.stringify(result, undefined, 2) }
    },
  })
}

/**
 * Register the five chat tools under `toolPrefix` (`acp_chat_` by default:
 * acp_chat_start / acp_chat_send / acp_chat_list / acp_chat_close / acp_chat_steer).
 * @param ctx - host context; owns the registrations' lifetime via `ctx.effect`.
 * @param tools - the tools registry the five definitions are registered into.
 * @param pool - the pool the tools drive.
 * @param toolPrefix - name prefix for all five tools.
 * @param jobs - the job registry; when given, send is the job-backed variant.
 * @param roles - workspace role access (D27): adds `role` parameters and the `acp_workflow` tool; absent keeps the pre-D27 definitions.
 * @param permissionResolverFor - binds one call's user-confirmation bridge for `permission: ask` backends.
 */
export function registerChatTools(
  ctx: Context,
  tools: ToolsRegistryFace,
  pool: AcpSessionPool,
  toolPrefix: string,
  jobs?: ChatJobsFace,
  roles?: RoleSupport,
  permissionResolverFor?: (agent: Agent | undefined) => PermissionRequestResolver | undefined,
): void {
  const [start, list, close, steer] = chatStaticTools(pool, toolPrefix, [], roles)
  const workflow = roles === undefined ? [] : [...(roles.templates === false ? [] : [chatWorkflowTool(pool, roles, jobs, permissionResolverFor)]), teamListTool(pool, roles, toolPrefix)]
  for (const definition of [start, chatSendTool(pool, toolPrefix, jobs, permissionResolverFor, roles), list, close, steer, ...workflow]) {
    ctx.effect(() => tools.register(definition))
  }
}
