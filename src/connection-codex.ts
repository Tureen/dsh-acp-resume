/**
 * Codex app-server connection for the persistent session pool (D25). Codex CLI
 * does not speak ACP: `codex app-server` exposes a private JSON-RPC 2.0 protocol
 * over stdio with a thread/turn/item model. This module spawns that process,
 * implements its own newline-delimited JSON-RPC transport (no ACP SDK), opens a
 * thread (`thread/start`, or `thread/resume` for reconnect, always with
 * `ephemeral: false` so the thread persists), runs turns (`turn/start`, result
 * delivered by `item/*` notifications and settled by `turn/completed`), and maps
 * Codex terminals onto the ACP stop-reason vocabulary. It returns an object of
 * the same shape as {@link AcpConnection}, so the pool can drive either protocol.
 * Native extras ACP lacks: `turn/steer` (appends to the running turn without
 * interrupting it, needs the in-flight `expectedTurnId`) and `turn/interrupt`.
 * `item/<kind>/requestApproval` server requests are answered by the spec's
 * policy (`allow` → `accept`, `reject` → `decline`, `ask` → the host user via the
 * turn's permission resolver, see codex-approval.ts; no bridge and approvals
 * arriving outside a turn → `cancel`).
 * The streamed text observer sees every `agentMessage` delta of the in-flight
 * turn; the settled output is the `final_answer` item text when present, else
 * the concatenated deltas. Startup failures reject with the shared
 * {@link AcpConnectionError} (same stages and categories, so pool degradation
 * rules apply unchanged). The one-shot provider (run.ts) is not involved.
 *
 * @module dsh-acp-resume/connection-codex
 */

import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { ContentBlock as AcpContentBlock } from '@agentclientprotocol/sdk'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import {
  AcpConnectionError,
  AcpSteerUnsupportedError,
  deliverText, type TextSink,
  type AcpConnection,
  type AcpFailureCategory,
  type AcpStartupStage,
  type AcpSteerResult,
  type AcpTurnResult,
  type OpenAcpMode,
} from './connection.js'
import { COMMAND_NOT_FOUND_GUIDANCE, isCommandNotFound } from './command-not-found.js'
import { acpStopReason, disposeAcpChild, type AcpRunSpec } from './run.js'
import { isCodexApprovalMethod, resolveCodexApproval } from './codex-approval.js'
import type { PermissionRequestResolver } from './permission-request.js'

interface CodexConnectionSpec extends AcpRunSpec {
  /** Set on new threads; omit it on resume to keep the thread's existing model. */
  readonly codexModel?: string
  /** `read-only` | `workspace-write` | `danger-full-access`. Default `read-only`. */
  readonly sandbox?: string
  /** `never` | `untrusted` | `on-request` | `on-failure`. Default `never`. */
  readonly approvalPolicy?: string
  /** Reasoning effort passed on every `turn/start`, when set. */
  readonly codexEffort?: string
}

/** The Codex spawn and thread settings with a selected model for a new thread. */
export interface CodexSessionSpec extends CodexConnectionSpec {
  readonly codexModel: string
}

/** Readiness-only connection: no thread, turn, login or usage methods. */
interface CodexProbeConnection {
  readAccount(): Promise<unknown>
  readConfig(): Promise<unknown>
  listModels(cursor?: string): Promise<unknown>
  dispose(): Promise<void>
}

/** JSON-RPC error reply from the Codex server. */
class CodexRpcError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.name = 'CodexRpcError'
    this.code = code
  }
}

/** JSON-RPC "Method not found". */
const METHOD_NOT_FOUND = -32601

/**
 * Codex turn terminal → harness stop reason. Same table as the ACP mapping
 * (completed→end_turn, interrupted→cancelled, contextWindowExceeded→max_tokens);
 * `failed` and any unknown status settle as `error`.
 */
function codexStopReason(status: string | undefined, errorInfo: string | undefined): SubagentStopReason {
  if (status === 'completed') return acpStopReason('end_turn')
  if (status === 'interrupted') return acpStopReason('cancelled')
  if (errorInfo === 'contextWindowExceeded') return acpStopReason('max_tokens')
  return 'error'
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function hasProcessErrorCode(error: Error | undefined): error is Error {
  return error !== undefined && typeof Reflect.get(error, 'code') === 'string'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Fixed safe failure text from structured facts only (mirrors connection.ts, provider named Codex). */
function failureDiagnostic(facts: { stage: string; category: string; stopReason?: string; outcome?: SubprocessOutcome }): string {
  const fields = ['provider: Codex', `stage: ${facts.stage}`, `category: ${facts.category}`]
  if (facts.stopReason !== undefined) fields.push(`stop reason: ${facts.stopReason}`)
  if (facts.outcome?.exitCode !== null && facts.outcome?.exitCode !== undefined) fields.push(`exit code: ${facts.outcome.exitCode}`)
  if (facts.outcome?.signal !== null && facts.outcome?.signal !== undefined) fields.push(`signal: ${facts.outcome.signal}`)
  return `Subagent failure (${fields.join('; ')})`
}

function connectionError(
  facts: { stage: AcpStartupStage; category: AcpFailureCategory; jsonRpcCode?: number },
  cause?: unknown,
): AcpConnectionError {
  return new AcpConnectionError(
    `acp-resume: ${failureDiagnostic(facts)}${facts.category === 'process-start' && isCommandNotFound(cause) ? `\n${COMMAND_NOT_FOUND_GUIDANCE}` : ''}`,
    {
      stage: facts.stage,
      category: facts.category,
      ...(facts.jsonRpcCode === undefined ? {} : { jsonRpcCode: facts.jsonRpcCode }),
      ...(cause === undefined ? {} : { cause }),
    },
  )
}

/** Join the text blocks of an ACP prompt into Codex user-input items. */
function toCodexInput(blocks: readonly AcpContentBlock[]): Array<{ type: 'text'; text: string; text_elements: [] }> {
  const text = blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  return [{ type: 'text', text, text_elements: [] }]
}

/** Per-turn state; replaced wholesale at each prompt start. */
interface TurnState {
  /** Known after the `turn/start` reply; notifications seen earlier wait in `early`. */
  turnId: string | undefined
  early: Array<{ method: string; params: Record<string, unknown> }>
  deltas: string
  finalAnswer: string | undefined
  observer: TextSink | undefined
  resolveTerminal: (terminal: { status: string | undefined; errorInfo: string | undefined }) => void
}

/** Open a new/existing thread, or initialize only for usage reads (D28). */
export type CodexOpenMode = OpenAcpMode | { readonly mode: 'usage' }
type CodexProbeMode = { readonly mode: 'probe' }

/**
 * Spawn `codex app-server`, initialize, then start/resume a thread or return a usage connection.
 * Startup failures dispose the child before rejecting: spawn failures are `process-start`,
 * closed streams are `transport` or `process-exit`, and server rejections are `protocol`.
 * Local cancellation rejects with a plain abort error. Configured starts and D6 recovery
 * may omit the model to use the app-server default; resume keeps the saved thread's model.
 */
export function openCodexConnection(spec: CodexConnectionSpec, open: CodexOpenMode, signal?: AbortSignal): Promise<AcpConnection>
/** Initialize only for readiness (D31), with no capability to start turns. */
export function openCodexConnection(spec: AcpRunSpec, open: CodexProbeMode, signal?: AbortSignal): Promise<CodexProbeConnection>
export async function openCodexConnection(spec: CodexConnectionSpec, open: CodexOpenMode | CodexProbeMode, signal?: AbortSignal): Promise<AcpConnection | CodexProbeConnection> {
  if (signal?.aborted) throw new Error('subagent request was aborted before the Codex child started')
  const id = brandString<SessionId>(randomUUID())

  let child: SubprocessHandle
  try {
    child = spec.spawn({
      argv: [spec.command, ...spec.args],
      cwd: spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: open.mode === 'probe' ? 'pipe' : 'inherit' },
      graceMs: spec.disposeGraceMs,
      env: spec.env,
    })
  } catch (error: unknown) {
    try { spec.onError?.(toError(error), 'error') } catch { /* sink cannot replace the failure */ }
    throw connectionError({ stage: 'initialize', category: 'process-start' }, error)
  }
  if (open.mode === 'probe') child.stderr?.resume()
  const stdin = child.stdin
  const stdout = child.stdout
  if (stdin === undefined || stdout === undefined) {
    const error = new Error('subprocess implementation dropped a piped protocol stream')
    try { spec.onError?.(error, 'error') } catch { /* sink cannot replace the failure */ }
    child.done.catch(() => { /* the startup rejection below already reports this attempt */ })
    await disposeAcpChild(child, spec.disposeEofGraceMs).catch((cleanupError: unknown) => {
      try { spec.onError?.(toError(cleanupError), 'error') } catch { /* sink cannot replace the failure */ }
    })
    throw connectionError({ stage: 'initialize', category: 'process-start' }, error)
  }

  let processOutcome: SubprocessOutcome | undefined
  let processFailure: Error | undefined
  const processDone = child.done.then(
    (outcome) => { processOutcome = outcome; return outcome },
    (error: unknown) => { processFailure = toError(error); throw processFailure },
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

  // ---- JSON-RPC line transport -------------------------------------------
  let nextRequestId = 1
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let streamClosed = false
  const writeLine = (message: unknown): void => {
    stdin.write(`${JSON.stringify(message)}\n`)
  }
  const request = (method: string, params: unknown): Promise<unknown> => {
    if (streamClosed) return Promise.reject(new Error('Codex app-server stream is closed'))
    const requestId = nextRequestId++
    return new Promise<unknown>((resolve, reject) => {
      pending.set(requestId, { resolve, reject })
      try {
        writeLine({ jsonrpc: '2.0', id: requestId, method, params })
      } catch (error: unknown) {
        pending.delete(requestId)
        reject(toError(error))
      }
    })
  }
  const notify = (method: string, params?: unknown): void => {
    try { writeLine(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }) } catch { /* child gone */ }
  }
  const failPending = (error: Error): void => {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }

  // ---- per-turn state and server messages --------------------------------
  let turn: TurnState | undefined
  const flags = { cancelled: false }

  // Approvals are meaningful only while a prompt owns this connection.
  let approvalResolver: PermissionRequestResolver | undefined
  let approvalSignal: AbortSignal | undefined

  const applyTurnEvent = (state: TurnState, method: string, params: Record<string, unknown>): void => {
    if (method === 'item/agentMessage/delta') {
      const delta = str(params['delta'])
      if (delta === undefined || delta === '') return
      state.deltas += delta
      if (state.observer !== undefined) {
        deliverText(state.observer, delta)
      }
    } else if (method === 'item/completed') {
      const item = asRecord(params['item'])
      if (item !== undefined && item['type'] === 'agentMessage' && item['phase'] === 'final_answer') {
        const text = str(item['text'])
        if (text !== undefined) state.finalAnswer = text
      }
    } else if (method === 'turn/completed') {
      const turnInfo = asRecord(params['turn']) ?? params
      // codexErrorInfo is a bare string for unit variants, or a one-key object for data variants.
      const info = asRecord(turnInfo['error'])?.['codexErrorInfo']
      const errorInfo = typeof info === 'string' ? info : Object.keys(asRecord(info) ?? {})[0]
      state.resolveTerminal({ status: str(turnInfo['status']), errorInfo })
    }
  }

  const handleNotification = (method: string, params: Record<string, unknown>): void => {
    const state = turn
    if (state === undefined) return
    // Turn isolation: events carry turnId; a late tail of a settled turn never reaches the next one.
    const eventTurnId = str(params['turnId']) ?? str(asRecord(params['turn'])?.['id'])
    if (state.turnId === undefined) {
      state.early.push({ method, params })
      return
    }
    if (eventTurnId !== undefined && eventTurnId !== state.turnId) return
    applyTurnEvent(state, method, params)
  }

  const handleServerRequest = (requestId: unknown, method: string, params: Record<string, unknown>): void => {
    if (isCodexApprovalMethod(method)) {
      void resolveCodexApproval(spec.permission, method, params, turn === undefined ? undefined : approvalSignal, approvalResolver)
        .then(decision => { writeLine({ jsonrpc: '2.0', id: requestId, result: { decision } }) })
        .catch(() => { /* child gone: nothing left to answer */ })
    } else {
      // Unknown server request: answer so the server never waits on us.
      writeLine({ jsonrpc: '2.0', id: requestId, error: { code: METHOD_NOT_FOUND, message: 'Method not found' } })
    }
  }

  const handleLine = (line: string): void => {
    let message: Record<string, unknown> | undefined
    try { message = asRecord(JSON.parse(line)) } catch { return }
    if (message === undefined) return
    const method = str(message['method'])
    const messageId = message['id']
    if (method !== undefined) {
      if (messageId !== undefined && messageId !== null) {
        try { handleServerRequest(messageId, method, asRecord(message['params']) ?? {}) } catch { /* child gone */ }
      } else {
        handleNotification(method, asRecord(message['params']) ?? {})
      }
      return
    }
    if (typeof messageId !== 'number') return
    const entry = pending.get(messageId)
    if (entry === undefined) return
    pending.delete(messageId)
    const rpcError = asRecord(message['error'])
    if (rpcError !== undefined) {
      entry.reject(new CodexRpcError(typeof rpcError['code'] === 'number' ? rpcError['code'] : -32603, str(rpcError['message']) ?? 'Codex request failed'))
    } else {
      entry.resolve(message['result'])
    }
  }

  const decoder = new StringDecoder('utf8')
  let buffered = ''
  stdout.on('data', (chunk: Buffer | string) => {
    buffered += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) if (line.trim() !== '') handleLine(line)
  })
  const onStreamEnd = (): void => {
    if (streamClosed) return
    streamClosed = true
    failPending(new Error('Codex app-server stream closed'))
  }
  stdout.on('end', onStreamEnd)
  stdout.on('close', onStreamEnd)
  stdout.on('error', onStreamEnd)
  // A broken stdin pipe surfaces as a write error; the stream-closed path owns classification.
  stdin.on('error', () => { /* observed through stdout end / process exit */ })

  // ---- cancellation and disposal -----------------------------------------
  let remoteThreadId: string | undefined
  let signalCancelSettled!: () => void
  const cancelSettled = new Promise<void>((resolve) => { signalCancelSettled = resolve })
  const sendInterrupt = (): void => {
    if (remoteThreadId === undefined || turn?.turnId === undefined) return
    void request('turn/interrupt', { threadId: remoteThreadId, turnId: turn.turnId }).catch(() => { /* turn already over / child gone */ })
  }
  const requestCancel = (): void => {
    if (flags.cancelled) return
    flags.cancelled = true
    signalCancelSettled()
    sendInterrupt()
  }
  const onAbort = (): void => { requestCancel() }
  signal?.addEventListener('abort', onAbort, { once: true })

  let processDisposal: Promise<void> | undefined
  const dispose = (): Promise<void> => (processDisposal ??= (async () => {
    sendInterrupt()
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

  // ---- startup ------------------------------------------------------------
  const threadParams = {
    ...(spec.codexModel === undefined ? {} : { model: spec.codexModel }),
    approvalPolicy: spec.approvalPolicy ?? 'never',
    sandbox: spec.sandbox ?? 'read-only',
  }
  let startupStage: AcpStartupStage = 'initialize'
  try {
    await Promise.race([
      (async (): Promise<void> => {
        await request('initialize', { clientInfo: { name: 'dsh-acp-resume', version: '0.1.0' } })
        notify('initialized')
        if (open.mode === 'usage' || open.mode === 'probe') {
          remoteThreadId = ''
        } else if (open.mode === 'new') {
          startupStage = 'new-session'
          const reply = asRecord(await request('thread/start', { cwd: spec.cwd, ...threadParams, ephemeral: false }))
          const threadId = str(asRecord(reply?.['thread'])?.['id'])
          if (threadId === undefined) {
            throw connectionError({ stage: 'new-session', category: 'protocol' }, new Error('Codex thread/start returned no thread id'))
          }
          remoteThreadId = threadId
        } else {
          startupStage = 'load-session'
          remoteThreadId = open.sessionId
          await request('thread/resume', { threadId: open.sessionId, ...threadParams })
        }
        if (flags.cancelled) throw new Error('subagent cancelled before the Codex thread started')
      })(),
      processRejected,
      cancelSettled.then((): never => { throw new Error('subagent cancelled before the Codex thread started') }),
    ])
  } catch (error: unknown) {
    signal?.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = flags.cancelled
    const observedOutcome = !cancelledBeforeCleanup && startupStage === 'initialize' && !(error instanceof AcpConnectionError)
      ? await observeOutcome()
      : undefined
    let failure: AcpConnectionError | undefined
    if (!cancelledBeforeCleanup) {
      if (startupStage === 'initialize' && hasProcessErrorCode(processFailure)) {
        failure = connectionError({ stage: 'initialize', category: 'process-start' }, processFailure)
      } else if (error instanceof AcpConnectionError) {
        failure = error
      } else if (error instanceof CodexRpcError) {
        failure = connectionError({ stage: startupStage, category: 'protocol', jsonRpcCode: error.code }, error)
      } else if (processFailure !== undefined) {
        failure = connectionError({ stage: startupStage, category: 'process-start' }, processFailure)
      } else {
        failure = observedOutcome === undefined
          ? connectionError({ stage: startupStage, category: 'transport' }, error)
          : connectionError({ stage: startupStage, category: 'process-exit' }, error)
      }
    }
    const reported = startupStage === 'initialize' && hasProcessErrorCode(processFailure) ? processFailure : error
    try { spec.onError?.(toError(reported), 'error') } catch { /* sink cannot replace the failure */ }
    await dispose().catch((cleanupError: unknown) => {
      try { spec.onError?.(toError(cleanupError), 'error') } catch { /* sink cannot replace the failure */ }
    })
    if (failure === undefined) throw new Error('subagent request was aborted before the Codex child started')
    throw failure
  }
  signal?.removeEventListener('abort', onAbort)
  if (remoteThreadId === undefined) throw new Error('unreachable: Codex startup fulfilled without a thread id')
  const threadId = remoteThreadId

  if (open.mode === 'probe') {
    return {
      readAccount: () => request('account/read', { refreshToken: false }),
      readConfig: () => request('config/read', { includeLayers: false }),
      listModels: (cursor) => request('model/list', { limit: 100, ...(cursor === undefined ? {} : { cursor }) }),
      dispose,
    }
  }

  return {
    id,
    remoteSessionId: threadId,
    get currentTurnText() { return turn?.deltas ?? '' },
    get processSettled(): boolean {
      return processOutcome !== undefined || processFailure !== undefined
    },
    observeOutcome,
    notifyCancel: requestCancel,
    dispose,
    // D28 read-only allowlist: exactly these two account methods, never a generic request.
    readAccount: () => request('account/read', {}),
    readRateLimits: () => request('account/rateLimits/read', { excludeResetCreditDetails: true }),
    async steer(message: string): Promise<AcpSteerResult> {
      const expectedTurnId = turn?.turnId
      if (expectedTurnId === undefined) throw new Error('acp-resume: no Codex turn is in flight to steer')
      let reply: unknown
      try {
        reply = await request('turn/steer', {
          threadId,
          input: [{ type: 'text', text: message, text_elements: [] }],
          expectedTurnId,
        })
      } catch (error: unknown) {
        if (error instanceof CodexRpcError && error.code === METHOD_NOT_FOUND) throw new AcpSteerUnsupportedError({ cause: error })
        throw error
      }
      const messageId = str(asRecord(reply)?.['turnId'])
      return { queued: true, ...(messageId === undefined ? {} : { messageId }) }
    },
    async prompt(blocks: readonly AcpContentBlock[], promptSignal: AbortSignal, onText?: TextSink, permissionResolver?: PermissionRequestResolver): Promise<AcpTurnResult> {
      flags.cancelled = false
      approvalResolver = permissionResolver
      approvalSignal = promptSignal
      let turnCancelled = false
      let turnCancelSettled!: () => void
      const turnCancel = new Promise<void>((resolve) => { turnCancelSettled = resolve })
      const terminal = Promise.withResolvers<{ status: string | undefined; errorInfo: string | undefined }>()
      const state: TurnState = {
        turnId: undefined,
        early: [],
        deltas: '',
        finalAnswer: undefined,
        observer: onText,
        resolveTerminal: terminal.resolve,
      }
      turn = state
      const onTurnAbort = (): void => {
        turnCancelled = true
        turnCancelSettled()
        requestCancel()
      }
      let onTurnStreamClose: (() => void) | undefined
      promptSignal.addEventListener('abort', onTurnAbort, { once: true })
      if (promptSignal.aborted) onTurnAbort()
      const settleTurn = (): void => {
        state.observer = undefined
        if (turn === state) { turn = undefined; approvalResolver = undefined; approvalSignal = undefined }
      }
      const turnOutput = (): readonly ContentBlock[] => {
        const text = state.finalAnswer ?? state.deltas
        return text === '' ? [] : [{ type: 'text', text }]
      }
      try {
        if (turnCancelled) throw new Error('subagent cancelled before the Codex turn was sent')
        const turnStart = request('turn/start', {
          threadId,
          input: toCodexInput(blocks),
          ...(spec.codexEffort === undefined ? {} : { effort: spec.codexEffort }),
        })
        // Cancelled before the turn id arrived: the race below has already settled `aborted`
        // and sendInterrupt had no id, so interrupt the late-started turn here. Registered
        // before the race, so on a normal reply it runs first and sees turnCancelled false.
        void turnStart.then((reply) => {
          if (!turnCancelled || state.turnId !== undefined) return
          const lateTurnId = str(asRecord(asRecord(reply)?.['turn'])?.['id'])
          if (lateTurnId === undefined) return
          void request('turn/interrupt', { threadId, turnId: lateTurnId }).catch(() => { /* child gone */ })
        }, () => { /* failure is observed by the race below */ })
        const started = asRecord(await Promise.race([
          turnStart,
          turnCancel.then((): never => { throw new Error('subagent cancelled while the Codex turn was starting') }),
        ]))
        const turnId = str(asRecord(started?.['turn'])?.['id'])
        if (turnId === undefined) throw new Error('Codex turn/start returned no turn id')
        state.turnId = turnId
        // Replay what arrived before the id was known (same-turn only; others are dropped).
        for (const event of state.early) {
          const eventTurnId = str(event.params['turnId']) ?? str(asRecord(event.params['turn'])?.['id'])
          if (eventTurnId === undefined || eventTurnId === turnId) applyTurnEvent(state, event.method, event.params)
        }
        state.early = []
        if (flags.cancelled) sendInterrupt()
        const end = await Promise.race([
          terminal.promise,
          turnCancel.then((): never => { throw new Error('subagent cancelled while the Codex turn was running') }),
          processRejected,
          new Promise<never>((_resolve, reject) => {
            onTurnStreamClose = () => { reject(new Error('Codex app-server stream closed during the turn')) }
            stdout.once('close', onTurnStreamClose)
            if (streamClosed) onTurnStreamClose()
          }),
        ])
        settleTurn()
        const stopReason = codexStopReason(end.status, end.errorInfo)
        const diagnostic = stopReason === 'error'
          ? failureDiagnostic({ stage: 'prompt', category: 'protocol', stopReason: end.status ?? 'unknown' })
          : undefined
        return { output: turnOutput(), stopReason, diagnostic }
      } catch (error: unknown) {
        settleTurn()
        if (turnCancelled || flags.cancelled) return { output: turnOutput(), stopReason: 'aborted', diagnostic: undefined }
        const outcome = await observeOutcome(promptSignal)
        if (turnCancelled || flags.cancelled) return { output: turnOutput(), stopReason: 'aborted', diagnostic: undefined }
        const diagnostic = failureDiagnostic(outcome === undefined
          ? { stage: 'prompt', category: 'transport' }
          : { stage: 'process', category: 'process-exit', outcome })
        try { spec.onError?.(processFailure ?? toError(error), 'error') } catch { /* sink cannot replace the failure */ }
        return { output: turnOutput(), stopReason: 'error', diagnostic }
      } finally {
        promptSignal.removeEventListener('abort', onTurnAbort)
        // Per-turn listener: left attached, each turn adds one (MaxListenersExceededWarning at turn 11).
        if (onTurnStreamClose !== undefined) stdout.removeListener('close', onTurnStreamClose)
      }
    },
  }
}
