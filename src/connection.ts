/**
 * Reusable ACP connection primitives over a spawned agent process: open
 * (`session/new` or `session/load` reconnect), one prompt turn with the
 * official settlement semantics (streamed-text fold, stop-reason mapping,
 * unattended permission policy, cancellation), and the official teardown
 * ladder. Extracted from the baseline one-shot driver so both the one-shot
 * path and the persistent session pool share one implementation.
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
  type ContentBlock as AcpContentBlock,
  type StopReason,
  type ToolKind,
} from '@agentclientprotocol/sdk'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { AssistantOutputFold } from '@deepseek-ai/dsh-subagent'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { acpStopReason, acpContentText, disposeAcpChild, type AcpRunSpec, type PermissionPolicy } from './run.js'

export type { PermissionPolicy }

/** Terminal elements of one settled prompt turn. */
export interface AcpTurnResult {
  /** Accumulated assistant text blocks of this connection (not just the turn). */
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
  /** Snapshot of the accumulated assistant text fold. */
  collectOutput(): readonly ContentBlock[]
  /**
   * Run one prompt turn to its terminal. Never rejects on a child-level
   * failure: a cancelled turn settles `aborted`, a remote failure settles
   * `error` with the safe diagnostic, mirroring the one-shot contract.
   * @param blocks - ACP prompt content blocks (text only today).
   * @param signal - cancellation channel for this turn.
   */
  prompt(blocks: readonly AcpContentBlock[], signal: AbortSignal): Promise<AcpTurnResult>
  /** Observe the process outcome for failure classification (bounded by the spec grace). */
  observeOutcome(signal?: AbortSignal): Promise<SubprocessOutcome | undefined>
  /** Best-effort `session/cancel` notification for the remote session. */
  notifyCancel(): void
  /** Tear the process down with the official ladder. Idempotent. */
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

/** Observe the managed-range exit within `ms` (mirrors run.ts rangeExitsWithin). */
async function rangeExitsWithin(child: SubprocessHandle, ms: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, ms)
  try {
    return await child.waitForExit(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Open one ACP connection: spawn the child, wire the client app, run the
 * startup transaction (`initialize` then `session/new` or `session/load`),
 * and return the live connection. Rejects with fixed safe facts after
 * provider-owned cleanup on any startup failure — including a `load` of an
 * unknown remote session.
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
    throw new Error(`acp-resume: ${failureDiagnostic({ stage: 'process', category: 'process-start' })}`, { cause: error })
  }
  if (child.stdin === undefined || child.stdout === undefined) {
    throw new Error('acp-resume: subprocess implementation dropped a piped protocol stream')
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

  let processDisposal: Promise<void> | undefined
  const dispose = (): Promise<void> => (processDisposal ??= (async () => {
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

  const fold = new AssistantOutputFold()
  // Turn-scoped text: reset at each prompt start so a pooled connection reports
  // THIS turn's answer, not the connection's accumulated history. The fold
  // above keeps the connection-level accumulation for one-shot consumers.
  let turnText = ''
  let latestPermission: AcpPermissionDecision | undefined
  const flags = { cancelled: false }

  const clientApp = createAcpClientApp({ name: 'dsh-acp-resume' })
    .onNotification(methods.client.session.update, ({ params }) => {
      const update = params.update
      if (update.sessionUpdate === 'agent_message_chunk') {
        const piece = acpContentText(update.content)
        fold.pushText(piece)
        turnText += piece
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
  let startupStage: 'initialize' | 'new-session' | 'load-session' = 'initialize'
  let signalCancelSettled!: () => void
  const cancelSettled = new Promise<void>((resolve) => { signalCancelSettled = resolve })
  const requestCancel = (): void => {
    if (flags.cancelled) return
    flags.cancelled = true
    signalCancelSettled()
    if (remoteSessionId !== undefined) {
      void agent.notify(methods.agent.session.cancel, { sessionId: remoteSessionId }).catch(() => { /* child gone / no session */ })
    }
  }
  const onAbort = (): void => { requestCancel() }
  signal?.addEventListener('abort', onAbort, { once: true })

  const collectOutput = (): readonly ContentBlock[] => fold.collect() ?? []

  try {
    await Promise.race([
      (async (): Promise<void> => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        })
        if (open.mode === 'new') {
          startupStage = 'new-session'
          const session = await agent.request(methods.agent.session.new, { cwd: spec.cwd, mcpServers: [] })
          const returned: unknown = Reflect.get(session, 'sessionId')
          if (typeof returned !== 'string') {
            throw new Error('acp-resume: ACP child published without a session id')
          }
          remoteSessionId = returned
        } else {
          startupStage = 'load-session'
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
    const observedOutcome = !flags.cancelled ? await observeOutcome() : undefined
    try { spec.onError?.(toError(error), 'error') } catch { /* sink cannot replace the failure */ }
    await dispose().catch(() => { /* startup classification owns the message */ })
    if (flags.cancelled) {
      throw new Error('subagent request was aborted before the ACP child started')
    }
    const message = error instanceof Error && error.message.startsWith('acp-resume:')
      ? error.message
      : `acp-resume: ${failureDiagnostic({
        stage: startupStage,
        category: error instanceof Error && error.message.includes('session not found') ? 'protocol' : observedOutcome === undefined ? 'transport' : 'process-exit',
        ...(observedOutcome === undefined ? {} : { outcome: observedOutcome }),
      })}`
    throw new Error(message, { cause: error })
  }
  signal?.removeEventListener('abort', onAbort)
  if (remoteSessionId === undefined) throw new Error('unreachable: ACP startup fulfilled without a session id')

  return {
    id,
    remoteSessionId,
    collectOutput,
    observeOutcome,
    notifyCancel: requestCancel,
    dispose,
    async prompt(blocks: readonly AcpContentBlock[], promptSignal: AbortSignal): Promise<AcpTurnResult> {
      let turnCancelled = false
      let turnCancelSettled!: () => void
      const turnCancel = new Promise<void>((resolve) => { turnCancelSettled = resolve })
      const onTurnAbort = (): void => {
        turnCancelled = true
        turnCancelSettled()
        requestCancel()
      }
      promptSignal.addEventListener('abort', onTurnAbort, { once: true })
      turnText = ''
      const turnOutput = (): readonly ContentBlock[] => turnText === '' ? [] : [{ type: 'text', text: turnText }]
      let diagnostic: string | undefined
      try {
        const promptResult = (await Promise.race([
          agent.request(methods.agent.session.prompt, {
            sessionId: remoteSessionId,
            prompt: [...blocks],
          }),
          turnCancel.then((): never => { throw new Error('subagent cancelled while the ACP prompt was running') }),
        ])) as { stopReason: StopReason }
        const stopReason = acpStopReason(promptResult.stopReason)
        diagnostic = terminalDiagnostic(promptResult.stopReason, latestPermission)
        return { output: turnOutput(), stopReason, diagnostic }
      } catch (error: unknown) {
        if (!turnCancelled && !flags.cancelled) {
          const outcome = await observeOutcome(promptSignal)
          diagnostic = failureDiagnostic(outcome === undefined
            ? { stage: 'prompt', category: 'transport' }
            : { stage: 'process', category: 'process-exit', outcome })
            + (latestPermission === undefined ? '' : `\n${permissionDiagnostic(latestPermission)}`)
        }
        if (turnCancelled || flags.cancelled) {
          return { output: turnOutput(), stopReason: 'aborted', diagnostic }
        }
        return { output: turnOutput(), stopReason: 'error', diagnostic }
      } finally {
        promptSignal.removeEventListener('abort', onTurnAbort)
      }
    },
  }
}
