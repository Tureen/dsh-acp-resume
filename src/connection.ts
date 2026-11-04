/**
 * ACP connection primitives for the persistent session pool: spawn an agent
 * process, open its remote session (`session/new`, or `session/load` reconnect
 * gated on the advertised `loadSession` capability), run prompt turns with the
 * official settlement semantics (stop-reason mapping, unattended permission
 * policy, cancellation, an optional per-turn text observer for streaming),
 * and tear down with the official ladder. Startup
 * failures reject with {@link AcpConnectionError} carrying fixed safe facts.
 * This is the pool's sister implementation of run.ts; the one-shot provider
 * keeps using run.ts verbatim (D11), so roughly 200 lines are deliberately
 * duplicated.
 *
 * @module dsh-acp-resume/connection
 */

import { randomUUID } from 'node:crypto'
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type ContentBlock as AcpContentBlock,
  type StopReason,
  type ToolKind,
} from '@agentclientprotocol/sdk'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { acpStopReason, acpContentText, disposeAcpChild, type AcpRunSpec, type PermissionPolicy } from './run.js'

export type { PermissionPolicy }

/** Startup step that failed. */
export type AcpStartupStage = 'initialize' | 'new-session' | 'load-session'

/** Failure class of a startup error. */
export type AcpFailureCategory = 'protocol' | 'transport' | 'process-exit' | 'process-start' | 'unknown'

/**
 * Structured startup failure. `message` holds only fixed safe facts; the
 * internal error, when any, is kept in `cause`.
 */
export class AcpConnectionError extends Error {
  /** Startup step that failed. */
  readonly stage: AcpStartupStage
  /** Failure class (`protocol` = the agent rejected the request). */
  readonly category: AcpFailureCategory
  /** JSON-RPC error code of an agent rejection, when one was received. */
  readonly jsonRpcCode?: number

  constructor(
    message: string,
    options: { stage: AcpStartupStage; category: AcpFailureCategory; jsonRpcCode?: number; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AcpConnectionError'
    this.stage = options.stage
    this.category = options.category
    if (options.jsonRpcCode !== undefined) this.jsonRpcCode = options.jsonRpcCode
  }
}

/**
 * The agent does not implement the private `_session/steer` extension
 * (JSON-RPC `-32601 Method not found`). Recognizable by class, not by message.
 */
export class AcpSteerUnsupportedError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('acp-resume: the agent does not implement _session/steer (method not found)', options)
    this.name = 'AcpSteerUnsupportedError'
  }
}

/** Reply to a queued steering message. */
export interface AcpSteerResult {
  /** The agent accepted the message into its queue. */
  readonly queued: boolean
  /** The agent's id for the queued message, when it returns one. */
  readonly messageId?: string
}

/** JSON-RPC "Method not found". */
const METHOD_NOT_FOUND = -32601

/** Terminal elements of one settled prompt turn. */
export interface AcpTurnResult {
  /** Assistant text blocks of this turn only. */
  readonly output: readonly ContentBlock[]
  readonly stopReason: SubagentStopReason
  /** Fixed safe diagnostic line, when the turn needs one. */
  readonly diagnostic: string | undefined
}

/** A live connection to one remote ACP session in one spawned process. */
export interface AcpConnection {
  /** Parent-minted lifecycle id (unique across the runtime). */
  readonly id: SessionId
  /** The remote session id inside the child server. */
  readonly remoteSessionId: string
  /** True once the child's fate is known (exited, or `done` rejected); false while live. */
  readonly processSettled: boolean
  /**
   * Run one prompt turn to its terminal. Never rejects on a child-level
   * failure: a cancelled turn settles `aborted`, a remote failure settles
   * `error` with the safe diagnostic, mirroring the one-shot contract.
   * @param blocks - ACP prompt content blocks (text only today).
   * @param signal - cancellation channel for this turn.
   * @param onText - optional observer of this turn's assistant text chunks, in
   *   arrival order; their concatenation equals the settled output. Chunks after
   *   settlement are not delivered; a throwing observer is contained.
   * @returns this turn's text, stop reason, and optional diagnostic.
   */
  prompt(blocks: readonly AcpContentBlock[], signal: AbortSignal, onText?: (text: string) => void): Promise<AcpTurnResult>
  /**
   * Queue a steering message into the running turn via the private
   * `_session/steer` request (neither engine advertises it; ACP has no steer).
   * Does not start or settle a turn.
   * @throws {AcpSteerUnsupportedError} the agent answered `-32601 Method not found`.
   */
  steer(message: string): Promise<AcpSteerResult>
  /** Observe the process outcome for failure classification (bounded by the spec grace). */
  observeOutcome(signal?: AbortSignal): Promise<SubprocessOutcome | undefined>
  /** Best-effort `session/cancel` notification for the remote session. */
  notifyCancel(): void
  /** Send `session/cancel`, then tear the process down with the official ladder. Idempotent. */
  dispose(): Promise<void>
}

/** How to establish the remote session when opening a connection. */
export type OpenAcpMode =
  | { readonly mode: 'new' }
  | { readonly mode: 'load'; readonly sessionId: string }

/** Fixed safe failure text derived only from structured facts (mirrors run.ts). */
function failureDiagnostic(facts: { stage: string; category: string; stopReason?: string; outcome?: SubprocessOutcome }): string {
  const fields = [
    'provider: ACP',
    `stage: ${facts.stage}`,
    `category: ${facts.category}`,
  ]
  if (facts.stopReason !== undefined) fields.push(`stop reason: ${facts.stopReason}`)
  if (facts.outcome?.exitCode !== null && facts.outcome?.exitCode !== undefined) {
    fields.push(`exit code: ${facts.outcome.exitCode}`)
  }
  if (facts.outcome?.signal !== null && facts.outcome?.signal !== undefined) {
    fields.push(`signal: ${facts.outcome.signal}`)
  }
  return `Subagent failure (${fields.join('; ')})`
}

/** Build a startup error whose message is the fixed safe facts line. */
function connectionError(
  facts: { stage: AcpStartupStage; category: AcpFailureCategory; outcome?: SubprocessOutcome; jsonRpcCode?: number },
  cause?: unknown,
): AcpConnectionError {
  return new AcpConnectionError(
    `acp-resume: ${failureDiagnostic({ stage: facts.stage, category: facts.category, ...(facts.outcome === undefined ? {} : { outcome: facts.outcome }) })}`,
    {
      stage: facts.stage,
      category: facts.category,
      ...(facts.jsonRpcCode === undefined ? {} : { jsonRpcCode: facts.jsonRpcCode }),
      ...(cause === undefined ? {} : { cause }),
    },
  )
}

/** Whether an error's message, `data`, or `details` mentions "session not found" (case-insensitive). */
function mentionsSessionNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const parts: string[] = [error.message]
  for (const key of ['data', 'details']) {
    const value: unknown = Reflect.get(error, key)
    if (value === undefined) continue
    if (typeof value === 'string') {
      parts.push(value)
      continue
    }
    try { parts.push(JSON.stringify(value)) } catch { /* unserializable detail carries no signal */ }
  }
  return parts.some(part => part.toLowerCase().includes('session not found'))
}

/** Permission decision fact (mirrors run.ts). */
interface AcpPermissionDecision {
  readonly policy: PermissionPolicy
  readonly request: ToolKind | 'unknown'
  readonly decision: 'allowed' | 'denied'
}

const ACP_TOOL_KINDS: ReadonlySet<string> = new Set([
  'read', 'edit', 'delete', 'move', 'search',
  'execute', 'think', 'fetch', 'switch_mode', 'other',
])

function permissionRequestKind(kind: ToolKind | null | undefined): ToolKind | 'unknown' {
  const candidate = kind ?? 'unknown'
  return ACP_TOOL_KINDS.has(candidate) ? candidate : 'unknown'
}

function permissionDiagnostic(permission: AcpPermissionDecision): string {
  return `ACP unattended decision (policy: ${permission.policy}; request: ${permission.request}; decision: ${permission.decision})`
}

/** Map one remote terminal reason to the optional safe failure line it needs (mirrors run.ts). */
function terminalDiagnostic(
  reason: StopReason,
  permission: AcpPermissionDecision | undefined,
): string | undefined {
  switch (reason) {
    case 'end_turn':
      return undefined
    case 'max_turn_requests':
      return `Subagent failure (provider: ACP; stage: prompt; category: remote-limit; stop reason: max_turn_requests)`
        + (permission === undefined ? '' : `\n${permissionDiagnostic(permission)}`)
    case 'max_tokens':
    case 'refusal':
    case 'cancelled':
      return permission === undefined ? undefined : permissionDiagnostic(permission)
    default:
      return failureDiagnostic({ stage: 'prompt', category: 'unknown', stopReason: 'unknown' })
        + (permission === undefined ? '' : `\n${permissionDiagnostic(permission)}`)
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Open one ACP connection: spawn the child, wire the client app, run the
 * startup transaction (`initialize` then `session/new` or `session/load`),
 * and return the live connection. Any startup failure first cleans up the
 * process, then rejects with an {@link AcpConnectionError}: an agent rejection
 * (including `load` of an unknown remote session) or a `load` against an agent
 * without the `loadSession` capability is `protocol`; a closed stream is
 * `transport` or `process-exit`; a failed spawn is `process-start`. Local
 * cancellation rejects with a plain abort error.
 * @param spec - resolved spawn spec (command/args/cwd, env, permission policy, graces).
 * @param open - establish a fresh session or reconnect a saved one.
 * @param signal - optional cancellation for the startup window.
 */
export async function openAcpConnection(spec: AcpRunSpec, open: OpenAcpMode, signal?: AbortSignal): Promise<AcpConnection> {
  if (signal?.aborted) throw new Error('subagent request was aborted before the ACP child started')
  const id = brandString<SessionId>(randomUUID())

  let child: SubprocessHandle
  try {
    child = spec.spawn({
      argv: [spec.command, ...spec.args],
      cwd: spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: spec.disposeGraceMs,
      env: spec.env,
    })
  } catch (error: unknown) {
    try { spec.onError?.(toError(error), 'error') } catch { /* sink cannot replace the failure */ }
    throw connectionError({ stage: 'initialize', category: 'process-start' }, error)
  }
  if (child.stdin === undefined || child.stdout === undefined) {
    const error = new Error('subprocess implementation dropped a piped protocol stream')
    try { spec.onError?.(error, 'error') } catch { /* sink cannot replace the failure */ }
    // The child is already running: release it through the dispose ladder before rejecting.
    // Nothing else observes `done` on this path; keep its rejection from going unhandled.
    child.done.catch(() => { /* the startup rejection below already reports this attempt */ })
    await disposeAcpChild(child, spec.disposeEofGraceMs).catch((cleanupError: unknown) => {
      // Startup classification owns the rejection; a failed cleanup is still reported.
      try { spec.onError?.(toError(cleanupError), 'error') } catch { /* sink cannot replace the failure */ }
    })
    throw connectionError({ stage: 'initialize', category: 'process-start' }, error)
  }

  let processOutcome: SubprocessOutcome | undefined
  let processFailure: Error | undefined
  const processDone = child.done.then(
    (outcome) => {
      processOutcome = outcome
      return outcome
    },
    (error: unknown) => {
      processFailure = toError(error)
      throw processFailure
    },
  )
  const processRejected: Promise<never> = processDone.then(
    () => new Promise<never>(() => {}),
    (err: unknown) => Promise.reject(toError(err)),
  )
  processRejected.catch(() => { /* observed by the startup race; never unhandled */ })

  const observeOutcome = async (observeSignal?: AbortSignal): Promise<SubprocessOutcome | undefined> => {
    if (processOutcome !== undefined) return processOutcome
    const timeout = AbortSignal.timeout(Math.ceil(spec.disposeGraceMs))
    const bound = observeSignal === undefined ? timeout : AbortSignal.any([observeSignal, timeout])
    const aborted = Promise.withResolvers<undefined>()
    const onObservationAbort = (): void => { aborted.resolve(undefined) }
    bound.addEventListener('abort', onObservationAbort, { once: true })
    if (bound.aborted) onObservationAbort()
    try {
      return await Promise.race([processDone, aborted.promise])
    } catch {
      return processOutcome
    } finally {
      bound.removeEventListener('abort', onObservationAbort)
    }
  }

  // Turn-scoped text: reset at each prompt start so a pooled connection reports
  // THIS turn's answer, not the connection's accumulated history.
  let turnText = ''
  // Turn isolation: ACP update notifications carry no turn identity, so chunks
  // arriving AFTER a settled turn (a cancelled turn's late tail) must not enter
  // the next turn's output. Only chunks observed while a turn is in flight accumulate.
  let acceptingUpdates = false
  // The in-flight turn's text observer; cleared with acceptingUpdates.
  let turnTextObserver: ((text: string) => void) | undefined
  let latestPermission: AcpPermissionDecision | undefined
  const flags = { cancelled: false }

  const clientApp = createAcpClientApp({ name: 'dsh-acp-resume' })
    .onNotification(methods.client.session.update, ({ params }) => {
      const update = params.update
      if (update.sessionUpdate === 'agent_message_chunk' && acceptingUpdates) {
        const text = acpContentText(update.content)
        turnText += text
        if (text !== '' && turnTextObserver !== undefined) {
          try { turnTextObserver(text) } catch { /* an observer cannot break the turn */ }
        }
      }
      // Other updates (thoughts, tool calls, plans) are consumed but not
      // surfaced — the connection returns only the final answer text.
      return Promise.resolve()
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      if (spec.permission === 'allow') {
        const allow = params.options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always')
        if (allow !== undefined) {
          latestPermission = { policy: 'allow', request: permissionRequestKind(params.toolCall.kind), decision: 'allowed' }
          return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow.optionId } })
        }
      }
      latestPermission = {
        policy: spec.permission,
        request: permissionRequestKind(params.toolCall.kind),
        decision: 'denied',
      }
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    })

  const connection = clientApp.connect(ndJsonStream(
    NodeWritable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    NodeReadable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ))
  const agent = connection.agent

  let remoteSessionId: string | undefined
  let startupStage: AcpStartupStage = 'initialize'
  let signalCancelSettled!: () => void
  const cancelSettled = new Promise<void>((resolve) => { signalCancelSettled = resolve })
  // Raw best-effort `session/cancel`; no flag gate, so dispose can always send it.
  const sendRemoteCancel = (): void => {
    if (remoteSessionId === undefined) return
    try {
      void agent.notify(methods.agent.session.cancel, { sessionId: remoteSessionId }).catch(() => { /* child gone / no session */ })
    } catch { /* connection already closed */ }
  }
  const requestCancel = (): void => {
    if (flags.cancelled) return
    flags.cancelled = true
    signalCancelSettled()
    sendRemoteCancel()
  }
  const onAbort = (): void => { requestCancel() }
  signal?.addEventListener('abort', onAbort, { once: true })

  let processDisposal: Promise<void> | undefined
  const dispose = (): Promise<void> => (processDisposal ??= (async () => {
    // Cooperative cancel first (official dispose order); the ladder stays authoritative.
    sendRemoteCancel()
    try {
      await disposeAcpChild(child, spec.disposeEofGraceMs)
    } catch (error: unknown) {
      try { spec.onError?.(toError(error), 'error') } catch { /* sink cannot replace the failure */ }
      throw new Error(
        `acp-resume: ${failureDiagnostic({ stage: 'teardown', category: processOutcome === undefined ? 'unknown' : 'process-exit', ...(processOutcome === undefined ? {} : { outcome: processOutcome }) })}`,
        { cause: error },
      )
    }
  })())

  try {
    await Promise.race([
      (async (): Promise<void> => {
        const init = await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        })
        if (open.mode === 'new') {
          startupStage = 'new-session'
          const session = await agent.request(methods.agent.session.new, { cwd: spec.cwd, mcpServers: [] })
          const returned: unknown = Reflect.get(session, 'sessionId')
          if (typeof returned !== 'string') {
            throw connectionError(
              { stage: 'new-session', category: 'protocol' },
              new Error('ACP child published without a session id'),
            )
          }
          remoteSessionId = returned
        } else {
          startupStage = 'load-session'
          if (init.agentCapabilities?.loadSession !== true) {
            throw connectionError(
              { stage: 'load-session', category: 'protocol' },
              new Error('ACP agent does not advertise the loadSession capability'),
            )
          }
          remoteSessionId = open.sessionId
          // Reconnect a persisted remote session. The load call repeats the
          // client-owned session inputs (cwd), matching the measured kiro-cli
          // v2 wire: { sessionId, cwd, mcpServers }.
          await agent.request(methods.agent.session.load, {
            sessionId: open.sessionId,
            cwd: spec.cwd,
            mcpServers: [],
          })
        }
        if (flags.cancelled) throw new Error('subagent cancelled before the ACP session started')
      })(),
      processRejected,
      cancelSettled.then((): never => { throw new Error('subagent cancelled before the ACP session started') }),
    ])
  } catch (error: unknown) {
    signal?.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = flags.cancelled
    // Protocol failures are classified from the reply itself; only stream or
    // process failures wait (bounded by the grace) for exit facts.
    let failure: AcpConnectionError | undefined
    if (!cancelledBeforeCleanup) {
      if (error instanceof AcpConnectionError) {
        failure = error
      } else if (error instanceof RequestError) {
        failure = connectionError({ stage: startupStage, category: 'protocol', jsonRpcCode: error.code }, error)
      } else if (mentionsSessionNotFound(error)) {
        failure = connectionError({ stage: startupStage, category: 'protocol' }, error)
      } else if (processFailure !== undefined) {
        failure = connectionError({ stage: startupStage, category: 'process-start' }, processFailure)
      } else {
        const observedOutcome = await observeOutcome()
        failure = processFailure !== undefined
          ? connectionError({ stage: startupStage, category: 'process-start' }, processFailure)
          : observedOutcome === undefined
            ? connectionError({ stage: startupStage, category: 'transport' }, error)
            : connectionError({ stage: startupStage, category: 'process-exit', outcome: observedOutcome }, error)
      }
    }
    try { spec.onError?.(toError(error), 'error') } catch { /* sink cannot replace the failure */ }
    await dispose().catch((cleanupError: unknown) => {
      // Startup classification owns the rejection; a failed cleanup is still reported.
      try { spec.onError?.(toError(cleanupError), 'error') } catch { /* sink cannot replace the failure */ }
    })
    if (failure === undefined) {
      throw new Error('subagent request was aborted before the ACP child started')
    }
    throw failure
  }
  signal?.removeEventListener('abort', onAbort)
  if (remoteSessionId === undefined) throw new Error('unreachable: ACP startup fulfilled without a session id')
  const sessionId = remoteSessionId

  return {
    id,
    remoteSessionId: sessionId,
    get processSettled(): boolean {
      return processOutcome !== undefined || processFailure !== undefined
    },
    observeOutcome,
    notifyCancel: requestCancel,
    dispose,
    async steer(message: string): Promise<AcpSteerResult> {
      let reply: unknown
      try {
        reply = await agent.request('_session/steer', { sessionId, message })
      } catch (error: unknown) {
        if (error instanceof RequestError && error.code === METHOD_NOT_FOUND) {
          throw new AcpSteerUnsupportedError({ cause: error })
        }
        throw error
      }
      const messageId: unknown = typeof reply === 'object' && reply !== null ? Reflect.get(reply, 'messageId') : undefined
      const queued: unknown = typeof reply === 'object' && reply !== null ? Reflect.get(reply, 'queued') : undefined
      return {
        // A success reply without the field still means the request was accepted.
        queued: queued !== false,
        ...(typeof messageId === 'string' ? { messageId } : {}),
      }
    },
    async prompt(blocks: readonly AcpContentBlock[], promptSignal: AbortSignal, onText?: (text: string) => void): Promise<AcpTurnResult> {
      // Per-turn state: a notifyCancel between turns or a previous turn's
      // permission decision must not leak into this turn.
      flags.cancelled = false
      latestPermission = undefined
      turnText = ''
      turnTextObserver = onText
      acceptingUpdates = true
      let turnCancelled = false
      let turnCancelSettled!: () => void
      const turnCancel = new Promise<void>((resolve) => { turnCancelSettled = resolve })
      const onTurnAbort = (): void => {
        turnCancelled = true
        turnCancelSettled()
        requestCancel()
      }
      promptSignal.addEventListener('abort', onTurnAbort, { once: true })
      if (promptSignal.aborted) onTurnAbort()
      const settleTurn = (): void => {
        acceptingUpdates = false
        turnTextObserver = undefined
      }
      const turnOutput = (): readonly ContentBlock[] => turnText === '' ? [] : [{ type: 'text', text: turnText }]
      let diagnostic: string | undefined
      try {
        // An already-aborted turn never reaches the agent.
        if (turnCancelled) throw new Error('subagent cancelled before the ACP prompt was sent')
        const promptResult = (await Promise.race([
          agent.request(methods.agent.session.prompt, {
            sessionId,
            prompt: [...blocks],
          }),
          turnCancel.then((): never => { throw new Error('subagent cancelled while the ACP prompt was running') }),
        ])) as { stopReason: StopReason }
        settleTurn()
        const stopReason = acpStopReason(promptResult.stopReason)
        diagnostic = terminalDiagnostic(promptResult.stopReason, latestPermission)
        return { output: turnOutput(), stopReason, diagnostic }
      } catch (error: unknown) {
        settleTurn()
        if (turnCancelled || flags.cancelled) {
          return { output: turnOutput(), stopReason: 'aborted', diagnostic }
        }
        const outcome = await observeOutcome(promptSignal)
        // A cancel arriving while exit facts were awaited still owns the turn.
        if (turnCancelled || flags.cancelled) {
          return { output: turnOutput(), stopReason: 'aborted', diagnostic }
        }
        diagnostic = failureDiagnostic(outcome === undefined
          ? { stage: 'prompt', category: 'transport' }
          : { stage: 'process', category: 'process-exit', outcome })
          + (latestPermission === undefined ? '' : `\n${permissionDiagnostic(latestPermission)}`)
        try { spec.onError?.(processFailure ?? toError(error), 'error') } catch { /* sink cannot replace the failure */ }
        return { output: turnOutput(), stopReason: 'error', diagnostic }
      } finally {
        promptSignal.removeEventListener('abort', onTurnAbort)
      }
    },
  }
}
